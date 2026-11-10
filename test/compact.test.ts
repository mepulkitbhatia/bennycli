import { expect, test } from "vitest";
import { chooseCut, compact } from "../src/compact.ts";
import type { Chat, Message } from "../src/llm.ts";

const system: Message = { role: "system", content: "You are Benny." };
const user = (content: string): Message => ({ role: "user", content });
const answer = (content: string): Message => ({ role: "assistant", content });
const call = (id: string, name: string, args: object): Message => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content: string): Message => ({ role: "tool", tool_call_id: id, content });

// A conversation: an earlier question, then a task with two rounds of tool use.
const conversation = (): Message[] => [
  system,
  user("What does sum.js do?"),
  call("c1", "read_file", { path: "sum.js" }),
  result("c1", "1│export function sum(a, b) {\n2│  return a - b;\n3│}"),
  answer("sum.js exports sum(a, b), which subtracts instead of adding."),
  user("Fix it and run the tests."),
  call("c2", "edit_file", { path: "sum.js", old_text: "a - b", new_text: "a + b" }),
  result("c2", "Edited sum.js: lines 2-2 now contain the new text."),
  call("c3", "run_command", { command: "npm test" }),
  result("c3", "Exit code: 0\n" + "ok ".repeat(400)),
];

// A summary model that records what it was sent.
function summarizer(summary = "- sum.js subtracted; changed to add.") {
  const sent: Message[][] = [];
  const chat: Chat = async (messages) => {
    sent.push(messages);
    return { content: summary, toolCalls: [] };
  };
  return { chat, sent };
}

test("the cut never separates a tool request from its results", () => {
  const messages = conversation();
  for (const keep of [0, 50, 200, 400, 2000]) {
    const cut = chooseCut(messages, keep);
    if (cut !== undefined) expect(messages[cut]!.role, `keep ${keep}`).not.toBe("tool");
  }
});

test("with a small budget, only the last tool request and its result are kept", () => {
  expect(chooseCut(conversation(), 0)).toBe(8); // c3 and its result
});

test("a bigger budget keeps more recent messages", () => {
  const small = chooseCut(conversation(), 0)!;
  const big = chooseCut(conversation(), 1000)!;
  expect(big).toBeLessThan(small);
});

test("nothing to summarise in a conversation of one message", () => {
  expect(chooseCut([system, user("hi")], 0)).toBeUndefined();
});

test("the old messages become one summary, and recent messages stay exactly as they were", async () => {
  const messages = conversation();
  const kept = messages.slice(8);
  const { chat } = summarizer();

  const summarised = await compact(messages, chat, { keepTokens: 0 });

  expect(summarised).toBe(7);
  expect(messages[0]).toBe(system);
  expect(messages[1]).toEqual({ role: "user", content: "Summary of everything that happened before the messages that follow, in order (written by Benny to save space):\n- sum.js subtracted; changed to add." });
  // The latest request is put back word for word after the summary.
  expect(messages[2]).toEqual(user("Fix it and run the tests."));
  expect(messages.slice(3)).toEqual(kept);
  expect(messages[3]).toBe(kept[0]); // the same objects, not copies
});

test("the summary model gets plain text, not tool-call structures, with long results shortened", async () => {
  const messages = conversation();
  messages[3] = result("c1", "x".repeat(5000));
  const { chat, sent } = summarizer();

  await compact(messages, chat, { keepTokens: 0 });

  const [instructions, input] = sent[0]!;
  expect(instructions!.role).toBe("system");
  expect(input!.role).toBe("user");
  const text = input!.content as string;
  expect(text).toContain("User: What does sum.js do?");
  expect(text).toContain('Benny used read_file {"path":"sum.js"}');
  expect(text).toContain("[… result shortened]");
  expect(text).not.toContain("x".repeat(2001));
  expect(text).toContain("Benny: sum.js exports sum(a, b)");
});

test("a second compaction folds the earlier summary in, and still keeps the latest request", async () => {
  const messages = conversation();
  await compact(messages, summarizer("- first summary").chat, { keepTokens: 0 });
  messages.push(answer("Fixed; tests pass."), call("c4", "read_file", { path: "README.md" }), result("c4", "# Demo"));
  const second = summarizer("- second summary");

  await compact(messages, second.chat, { keepTokens: 0 });

  const text = second.sent[0]![1]!.content as string;
  expect(text).toContain("- first summary");
  expect(text).not.toContain("User: Summary of everything"); // shown as the summary it is
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
  expect(messages[1]!.content).toContain("- second summary");
  expect(messages[2]).toEqual(user("Fix it and run the tests."));
});

test("if the summary request fails, the conversation is untouched", async () => {
  const messages = conversation();
  const copy = [...messages];
  const failing: Chat = async () => {
    throw new Error("429 rate limited");
  };

  await expect(compact(messages, failing, { keepTokens: 0 })).rejects.toThrow("429");
  expect(messages).toEqual(copy);
});

test("an empty summary is treated as a failure", async () => {
  await expect(compact(conversation(), summarizer("  ").chat, { keepTokens: 0 })).rejects.toThrow("empty");
});
