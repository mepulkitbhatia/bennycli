import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool, OUTPUT_MAX_CHARS } from "./tool.ts";

const DEFAULT_TIMEOUT = 120;
const MAX_TIMEOUT = 600;

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a shell command in the project folder and return its output and exit code. " +
    "Use it for tests, builds, linters, git and other command-line tools. The command cannot read input " +
    "and is stopped at the timeout, so do not start servers, watchers or interactive programs.",
  schema: z.object({
    command: z.string().min(1).describe("The command to run with /bin/sh"),
    timeout_seconds: z.coerce.number().int().min(1).max(MAX_TIMEOUT).optional()
      .describe(`Stop the command after this many seconds. Default ${DEFAULT_TIMEOUT}`),
  }),
  async run({ command, timeout_seconds = DEFAULT_TIMEOUT }, { cwd, confirm, signal }) {
    // "Always" covers this exact command only, never every command.
    if (!(await confirm(`$ ${command}`, command))) {
      return "The user declined to run this command. Ask them what they would prefer, or try a different approach.";
    }

    const result = await exec(command, cwd, timeout_seconds * 1000, signal);
    const status = result.timedOut
      ? `The command did not finish within ${timeout_seconds}s and was stopped.`
      : result.stopped
        ? "The user stopped the command."
        : `Exit code: ${result.code ?? `killed by ${result.signal}`}`;
    return `${status}\n${result.output || "(no output)"}`;
  },
});

type Outcome = { output: string; code: number | null; signal: string | null; timedOut: boolean; stopped: boolean };

function exec(command: string, cwd: string, timeoutMs: number, abort?: AbortSignal): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      // Its own process group, so stopping it also stops everything it started.
      detached: true,
      // No input: a command that waits for the keyboard would otherwise hang until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
      // Keep tools from opening a pager or an editor that nobody can see, and from adding colour codes.
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", GIT_EDITOR: "true", NO_COLOR: "1" },
    });

    const output = keepHeadAndTail();
    child.stdout.setEncoding("utf8").on("data", output.add);
    child.stderr.setEncoding("utf8").on("data", output.add);

    let timedOut = false;
    let stopped = false;
    let forceKill: NodeJS.Timeout | undefined;
    const stopGroup = () => {
      const kill = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig); // the minus sign means "the whole group"
        } catch {} // already gone
      };
      kill("SIGTERM");
      forceKill ??= setTimeout(() => kill("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => ((timedOut = true), stopGroup()), timeoutMs);
    const onAbort = () => ((stopped = true), stopGroup());
    abort?.addEventListener("abort", onAbort, { once: true });

    let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // ponytail: anything the command left running in the background is stopped with it.
      // Add a background mode if the model ever needs to start a server and keep it running.
      stopGroup();
    });
    child.on("close", () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      abort?.removeEventListener("abort", onAbort);
      resolve({ output: output.text(), ...exit, timedOut, stopped });
    });
  });
}

// Long output is cut in the middle: the start shows what ran, the end shows how
// it finished (errors, test summaries). Memory stays bounded however much the
// command prints.
function keepHeadAndTail() {
  const HEAD = 1500;
  const TAIL = 4000;
  let head = "";
  let tail = "";
  let total = 0;
  return {
    add(chunk: string) {
      total += chunk.length;
      if (head.length < OUTPUT_MAX_CHARS) {
        const room = OUTPUT_MAX_CHARS - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (chunk) tail = (tail + chunk).slice(-OUTPUT_MAX_CHARS);
    },
    text() {
      // Up to here head + tail is everything printed, with nothing missing in between.
      if (total <= OUTPUT_MAX_CHARS) return (head + tail).trimEnd();
      const all = head + tail;
      let start = all.slice(0, HEAD);
      start = start.slice(0, start.lastIndexOf("\n") + 1 || HEAD);
      let end = all.slice(-TAIL);
      end = end.slice(end.indexOf("\n") + 1);
      const cut = total - start.length - end.length;
      return `${start}[… ${cut} characters of output cut …]\n${end}`.trimEnd();
    },
  };
}
