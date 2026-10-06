import { expect, test } from "vitest";
import { runTurn } from "../src/agent.ts";
import type { Chat, Message } from "../src/llm.ts";

test("each request carries the whole conversation so far", async () => {
  const received: Message[][] = [];
  const replies = ["Hi Pulkit", "Your name is Pulkit"];
  const fakeChat: Chat = async (messages, { onText }) => {
    received.push([...messages]);
    const content = replies[received.length - 1]!;
    onText(content);
    return { content };
  };

  const messages: Message[] = [{ role: "user", content: "My name is Pulkit" }];
  await runTurn(messages, fakeChat, () => {});
  messages.push({ role: "user", content: "What is my name?" });
  await runTurn(messages, fakeChat, () => {});

  expect(received[1]).toEqual([
    { role: "user", content: "My name is Pulkit" },
    { role: "assistant", content: "Hi Pulkit" },
    { role: "user", content: "What is my name?" },
  ]);
  expect(messages).toHaveLength(4);
});

// A stopped request can surface in two ways: the call throws, or (as the OpenAI
// SDK does mid-stream) the stream just ends early and the call returns normally.
test.each(["throws", "ends quietly"])("stopping a reply keeps the part already shown (request %s)", async (how) => {
  const stop = new AbortController();
  const fakeChat: Chat = async (_messages, { onText, signal }) => {
    onText("par");
    onText("tial");
    stop.abort();
    if (how === "throws") signal?.throwIfAborted();
    return { content: "partial" };
  };

  const messages: Message[] = [{ role: "user", content: "Write a long story" }];
  const result = await runTurn(messages, fakeChat, () => {}, stop.signal);

  expect(result.aborted).toBe(true);
  expect(messages).toHaveLength(2);
  expect(messages.at(-1)).toEqual({ role: "assistant", content: "partial" });
});

test("a failed request is reported and adds nothing to the conversation", async () => {
  const fakeChat: Chat = async () => {
    throw new Error("429 rate limited");
  };

  const messages: Message[] = [{ role: "user", content: "hello" }];
  await expect(runTurn(messages, fakeChat, () => {})).rejects.toThrow("429");
  expect(messages).toHaveLength(1);
});
