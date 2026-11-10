import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { tools } from "../src/tools/index.ts";
import { runTool } from "../src/tools/tool.ts";

let cwd: string;
beforeAll(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "benny-run-")));
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

const runCommand = (command: string, opts: { allow?: boolean; timeout?: number; signal?: AbortSignal } = {}) => {
  const previews: string[] = [];
  const result = runTool(tools, "run_command", JSON.stringify({ command, timeout_seconds: opts.timeout }), {
    cwd,
    signal: opts.signal,
    permission: async (_tool, preview) => (previews.push(preview), opts.allow ?? true),
  });
  return { result, previews };
};

test("runs in the project folder and returns the exit code and output", async () => {
  const { result, previews } = runCommand("pwd -P && echo hello");
  expect(await result).toBe(`Exit code: 0\n${cwd}\nhello`);
  expect(previews).toEqual(["$ pwd -P && echo hello"]);
});

test("a failing command reports its exit code and error output", async () => {
  expect(await runCommand("echo broken >&2; exit 3").result).toBe("Exit code: 3\nbroken");
});

test("a refused command does not run", async () => {
  const { result } = runCommand("touch made-it", { allow: false });
  expect(await result).toContain("The user declined to run this command");
  await expect(access(join(cwd, "made-it"))).rejects.toThrow();
});

test("a command that waits for input does not hang", async () => {
  expect(await runCommand("cat").result).toBe("Exit code: 0\n(no output)");
});

test("the timeout stops the command and everything it started", async () => {
  const started = Date.now();
  const out = await runCommand("echo begun; sleep 30 & sleep 30", { timeout: 1 }).result;
  expect(Date.now() - started).toBeLessThan(5000);
  expect(out).toBe("The command did not finish within 1s and was stopped.\nbegun");
});

test("Ctrl+C stops a running command", async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const started = Date.now();
  const out = await runCommand("sleep 30", { signal: stop.signal }).result;
  expect(Date.now() - started).toBeLessThan(5000);
  expect(out).toBe("The user stopped the command.\n(no output)");
});

test("huge output keeps the start and the end, and says how much was cut", async () => {
  const out = await runCommand("seq 1 200000").result;
  expect(out.length).toBeLessThan(6000);
  expect(out.split("\n").slice(0, 3)).toEqual(["Exit code: 0", "1", "2"]);
  expect(out.endsWith("\n199999\n200000")).toBe(true);
  expect(out).toMatch(/\n\[… \d+ characters of output cut …\]\n/);
});

test("background processes left behind are stopped when the command ends", async () => {
  const started = Date.now();
  expect(await runCommand("sleep 30 &").result).toBe("Exit code: 0\n(no output)");
  expect(Date.now() - started).toBeLessThan(5000);
});
