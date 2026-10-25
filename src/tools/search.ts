import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { capLines, defineTool, resolveInside } from "./tool.ts";

const run = promisify(execFile);

// Benny needs ripgrep installed on the machine. The CLI checks this at start-up
// and leaves the search tool out, with a warning, when it is missing.
export const ripgrepAvailable = () => run("rg", ["--version"]).then(() => true, () => false);

const MAX_PER_FILE = 20;

export const searchTool = defineTool({
  name: "search",
  description:
    "Search file contents with a regular expression (ripgrep syntax; plain words work too). " +
    "Returns matching lines as path:line:text. Use it to find where something is defined or used before reading files.",
  schema: z.object({
    pattern: z.string().min(1).describe("What to search for"),
    path: z.string().optional().describe("Folder or file to search in, relative to the project. Default: the whole project"),
    glob: z.string().optional().describe('Only search files whose path matches this pattern, e.g. "*.ts" or "src/**"'),
  }),
  async run({ pattern, path = ".", glob }, cwd) {
    const target = relative(cwd, await resolveInside(cwd, path)) || ".";
    // ripgrep skips .gitignore'd and binary files on its own. Hidden files are included
    // (.github, .eslintrc), but the .git folder is not.
    const args = [
      "--line-number", "--with-filename", "--no-heading", "--color", "never", "--smart-case",
      "--hidden", "--glob", "!.git",
      "--max-count", String(MAX_PER_FILE), // per file, so one noisy file cannot crowd out the others
      "--max-columns", "200", "--max-columns-preview",
      ...(glob ? ["--glob", glob] : []),
      "-e", pattern, "--", target, // always give a path: with none, rg reads stdin when not in a terminal
    ];

    let stdout: string;
    try {
      ({ stdout } = await run("rg", args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (err) {
      // execFile reports a missing program with code "ENOENT" and a non-zero exit with the number.
      const failure = err as { code?: string | number; message: string; stderr?: string; killed?: boolean };
      if (failure.code === "ENOENT") throw new Error("ripgrep (rg) is not installed. Install it with: brew install ripgrep");
      if (failure.code === 1) return `No matches for ${JSON.stringify(pattern)} in ${path}.`; // rg's "nothing found"
      if (failure.killed) throw new Error("The search took too long and was stopped. Narrow the path or glob.");
      throw new Error((failure.stderr || failure.message).trim());
    }

    const lines = stdout.trimEnd().split("\n").map((line) => line.replace(/^\.\//, ""));
    let out = capLines(lines, (shown, total) => `[Showing ${shown} of ${total}+ matching lines. Narrow the pattern, path or glob to see the rest.]`);

    // ripgrep stopped early in any file with MAX_PER_FILE matches; say so, or the model assumes it saw everything.
    const perFile = new Map<string, number>();
    for (const line of lines) {
      const file = line.slice(0, line.indexOf(":"));
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    const crowded = [...perFile].filter(([, count]) => count >= MAX_PER_FILE).map(([file]) => file);
    if (crowded.length > 0) {
      out += `\n[Only the first ${MAX_PER_FILE} matches per file are shown; ${crowded.join(", ")} ${crowded.length === 1 ? "has" : "have"} more. Use a narrower pattern or read_file to see them.]`;
    }
    return out;
  },
});
