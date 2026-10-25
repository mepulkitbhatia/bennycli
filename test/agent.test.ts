import { expect, test } from "vitest";
import { z } from "zod";
import { runTurn, type TurnEvents } from "../src/agent.ts";
import type { Chat, Message, Reply } from "../src/llm.ts";
import { defineTool } from "../src/tools/tool.ts";

const echo = defineTool({
  name: "echo",
  description: "Returns the text it is given",
  schema: z.object({ text: z.string() }),
  run: async ({ text }) => `echo: ${text}`,
});

const text = (content: string): Reply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const toolCall = (name: string, args: object | string, id = "call_1"): Reply => ({
  content: "",
  toolCalls: [{ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

// A model that follows a script: each request gets the next reply in the list.
function scripted(replies: Reply[]) {
  const received: Message[][] = [];
  const chat: Chat = async (messages, { onText }) => {
    received.push(structuredClone(messages));
    const reply = replies[received.length - 1] ?? text("script ran out");
    if (reply.content) onText(reply.content);
    return reply;
  };
  return { chat, received };
}

const quiet: TurnEvents = { onText: () => {}, onToolCall: () => {} };
const run = (messages: Message[], chat: Chat, extra: Partial<Parameters<typeof runTurn>[3]> = {}, events = quiet) =>
  runTurn(messages, chat, events, { tools: [echo], cwd: process.cwd(), permission: async () => true, ...extra });

test("a text answer ends the turn after one request", async () => {
  const { chat, received } = scripted([text("Hello")]);
  const messages: Message[] = [{ role: "user", content: "hi" }];

  const result = await run(messages, chat);

  expect(result).toEqual({ requests: 1, tokens: 15, aborted: false, hitStepLimit: false });
  expect(messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }]);
  expect(received[0]).toHaveLength(1);
});

test("a tool request is run, its result goes back to the model, and the answer follows", async () => {
  const { chat, received } = scripted([toolCall("echo", { text: "ping" }), text("It said ping")]);
  const messages: Message[] = [{ role: "user", content: "use echo" }];
  const calls: string[] = [];

  const result = await run(messages, chat, {}, { onText: () => {}, onToolCall: (name, args) => calls.push(`${name} ${args}`) });

  expect(result.requests).toBe(2);
  expect(result.tokens).toBe(30);
  expect(calls).toEqual(['echo {"text":"ping"}']);
  expect(messages).toEqual([
    { role: "user", content: "use echo" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"text":"ping"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "echo: ping" },
    { role: "assistant", content: "It said ping" },
  ]);
  // The second request carried the tool result, which is how the model "sees" it.
  expect(received[1]).toHaveLength(3);
});

test("bad arguments come back to the model as an error it can fix", async () => {
  const { chat } = scripted([toolCall("echo", { txt: "oops" }), toolCall("echo", { text: "fixed" }, "call_2"), text("done")]);
  const messages: Message[] = [{ role: "user", content: "go" }];

  const result = await run(messages, chat);

  expect(result.requests).toBe(3);
  const toolResults = messages.filter((m) => m.role === "tool");
  expect(toolResults[0]?.content).toContain("Error: invalid arguments for echo");
  expect(toolResults[0]?.content).toContain("text");
  expect(toolResults[1]?.content).toBe("echo: fixed");
});

test("an unknown tool name is reported, not crashed on", async () => {
  const { chat } = scripted([toolCall("shout", { text: "x" }), text("ok")]);
  const messages: Message[] = [{ role: "user", content: "go" }];

  await run(messages, chat);

  expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: 'Error: there is no tool named "shout". Available tools: echo.' });
});

test("the loop stops at the step limit and leaves the conversation valid", async () => {
  const forever: Chat = async () => toolCall("echo", { text: "again" });
  const messages: Message[] = [{ role: "user", content: "loop" }];

  const result = await run(messages, forever, { maxSteps: 3 });

  expect(result.hitStepLimit).toBe(true);
  expect(result.requests).toBe(3);
  expect(messages.at(-1)?.role).toBe("tool"); // every tool request has its result
});

test("each request carries the whole conversation so far", async () => {
  const { chat, received } = scripted([text("Hi Pulkit"), text("Your name is Pulkit")]);
  const messages: Message[] = [{ role: "user", content: "My name is Pulkit" }];

  await run(messages, chat);
  messages.push({ role: "user", content: "What is my name?" });
  await run(messages, chat);

  expect(received[1]).toEqual([
    { role: "user", content: "My name is Pulkit" },
    { role: "assistant", content: "Hi Pulkit" },
    { role: "user", content: "What is my name?" },
  ]);
});

// A stopped request can surface in two ways: the call throws, or (as the OpenAI
// SDK does mid-stream) the stream just ends early and the call returns normally.
test.each(["throws", "ends quietly"])("stopping a reply keeps the part already shown (request %s)", async (how) => {
  const stop = new AbortController();
  const chat: Chat = async (_messages, { onText, signal }) => {
    onText("par");
    onText("tial");
    stop.abort();
    if (how === "throws") signal?.throwIfAborted();
    return text("partial");
  };
  const messages: Message[] = [{ role: "user", content: "Write a long story" }];

  const result = await run(messages, chat, { signal: stop.signal });

  expect(result.aborted).toBe(true);
  expect(messages).toEqual([{ role: "user", content: "Write a long story" }, { role: "assistant", content: "partial" }]);
});

test("stopping during tool requests still gives every request a result", async () => {
  const stop = new AbortController();
  const { chat } = scripted([toolCall("echo", { text: "x" }), text("never asked")]);
  const messages: Message[] = [{ role: "user", content: "go" }];

  const result = await run(messages, chat, { signal: stop.signal }, { onText: () => {}, onToolCall: () => stop.abort() });

  expect(result).toMatchObject({ aborted: true, requests: 1 });
  expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "Cancelled: the user stopped this turn before the tool ran." });
});

test("a failed request is reported and adds nothing to the conversation", async () => {
  const chat: Chat = async () => {
    throw new Error("429 rate limited");
  };
  const messages: Message[] = [{ role: "user", content: "hello" }];

  await expect(run(messages, chat)).rejects.toThrow("429");
  expect(messages).toHaveLength(1);
});

test("a request that fails mid-turn rolls the conversation back to before the turn", async () => {
  let requests = 0;
  const chat: Chat = async () => {
    if (++requests === 1) return toolCall("echo", { text: "x" });
    throw new Error("400 Parsing failed");
  };
  const messages: Message[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "go" }];

  await expect(run(messages, chat)).rejects.toThrow("400");
  expect(messages).toHaveLength(3); // no dangling tool request left behind
  expect(messages.at(-1)).toEqual({ role: "user", content: "go" });
});
