import { expect, test } from "vitest";
import { collect, type Chunk } from "../src/llm.ts";

const chunk = (delta: object | undefined, usage?: object) =>
  ({ choices: delta ? [{ index: 0, delta }] : [], usage }) as unknown as Chunk;

async function* streamOf(...chunks: Chunk[]) {
  yield* chunks;
}

test("collect joins streamed pieces into one reply", async () => {
  const pieces: string[] = [];
  const reply = await collect(
    streamOf(
      chunk({ role: "assistant" }),
      chunk({ reasoning: "the user wants a greeting" }), // hidden thinking is not part of the answer
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk(undefined, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
    ),
    (text) => pieces.push(text),
  );

  expect(reply.content).toBe("Hello");
  expect(reply.toolCalls).toEqual([]);
  expect(pieces).toEqual(["Hel", "lo"]);
  expect(reply.usage?.total_tokens).toBe(12);
});

test("collect reassembles tool requests that arrive in pieces", async () => {
  const reply = await collect(
    streamOf(
      chunk({ role: "assistant", content: null }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path": "pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ckage.json"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } }] }),
      chunk(undefined, { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }),
    ),
    () => {},
  );

  expect(reply.content).toBe("");
  expect(reply.toolCalls).toEqual([
    { id: "call_1", name: "read_file", arguments: '{"path": "package.json"}' },
    { id: "call_2", name: "read_file", arguments: '{"path":"b"}' },
  ]);
});
