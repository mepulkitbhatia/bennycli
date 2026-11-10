import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProjectInstructions, roughTokens, systemPrompt, tokenCounter } from "../src/context.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "benny-context-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

const env = { cwd: "/work/demo", platform: "darwin" as const, date: "2026-11-10" };

test("the system prompt, exactly as sent", () => {
  expect(systemPrompt(env)).toMatchSnapshot();
});

test("the system prompt stays small: about 600 tokens at most", () => {
  // Roughly 4 characters per token for English text.
  expect(systemPrompt(env).length / 4).toBeLessThan(600);
});

test("project instructions are added at the end", () => {
  const prompt = systemPrompt({ ...env, instructions: "Use pnpm, not npm." });
  expect(prompt.startsWith(systemPrompt(env))).toBe(true);
  expect(prompt.endsWith("Project instructions from BENNY.md, written by the user. Follow them:\nUse pnpm, not npm.")).toBe(true);
});

test("the operating system is named in plain words", () => {
  expect(systemPrompt({ ...env, platform: "linux" })).toContain("Operating system: Linux;");
});

test("BENNY.md is read when present, and ignored when missing or empty", async () => {
  expect(await loadProjectInstructions(cwd)).toBeUndefined();

  await writeFile(join(cwd, "BENNY.md"), "  \n\n");
  expect(await loadProjectInstructions(cwd)).toBeUndefined();

  await writeFile(join(cwd, "BENNY.md"), "\nRun tests with `npm test`.\n");
  expect(await loadProjectInstructions(cwd)).toBe("Run tests with `npm test`.");
});

test("a long BENNY.md is cut, with a note", async () => {
  await writeFile(join(cwd, "BENNY.md"), "x".repeat(10_000));
  const text = await loadProjectInstructions(cwd);
  expect(text).toHaveLength(4000 + "\n[BENNY.md was cut at 4000 characters.]".length);
  expect(text?.endsWith("\n[BENNY.md was cut at 4000 characters.]")).toBe(true);
});

describe("counting tokens", () => {
  const tools = [{ type: "function", function: { name: "read_file" } }];
  const system = { role: "system", content: "You are Benny." };
  const user = { role: "user", content: "Fix the bug." };

  test("a rough count is about one token per 4 characters of JSON", () => {
    expect(roughTokens("x".repeat(398))).toBe(100); // 400 characters with the quotes
  });

  test("before Groq has counted anything, everything is estimated", () => {
    expect(tokenCounter().estimate([system, user], tools)).toBe(roughTokens([system, user]) + roughTokens(tools));
  });

  test("after a reply, Groq's count is reused and only new messages are estimated", () => {
    const counter = tokenCounter();
    const messages: object[] = [system, user];
    counter.record(messages, 900);
    const reply = { role: "assistant", content: "Done." };
    messages.push(reply);
    expect(counter.estimate(messages, tools)).toBe(900 + roughTokens([reply]));
  });

  test("if an earlier message is replaced, Groq's count no longer applies", () => {
    const counter = tokenCounter();
    const messages: object[] = [system, user];
    counter.record(messages, 900);
    messages[1] = { role: "user", content: "Summary of the earlier conversation." };
    expect(counter.estimate(messages, tools)).toBe(roughTokens(messages) + roughTokens(tools));
  });
});
