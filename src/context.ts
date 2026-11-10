import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The project's own instructions for Benny, read once at start-up. The whole
// file is sent with every request, so it is capped: about 1,000 tokens is
// already an eighth of the free tier's per-minute allowance.
export const INSTRUCTIONS_FILE = "BENNY.md";
const INSTRUCTIONS_MAX_CHARS = 4000;

export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  const text = (await readFile(join(cwd, INSTRUCTIONS_FILE), "utf8").catch(() => ""))?.trim();
  if (!text) return undefined;
  if (text.length <= INSTRUCTIONS_MAX_CHARS) return text;
  return `${text.slice(0, INSTRUCTIONS_MAX_CHARS).trimEnd()}\n[${INSTRUCTIONS_FILE} was cut at ${INSTRUCTIONS_MAX_CHARS} characters.]`;
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

// The instructions sent first on every request. Each rule is here because the
// model got it wrong without it: searching only one spelling of an import,
// guessing indentation, claiming tests pass without running them, and answering
// in Markdown that a terminal shows as raw asterisks.
export function systemPrompt(env: { cwd: string; platform: NodeJS.Platform; date: string; instructions?: string }): string {
  const prompt = `You are Benny, a coding agent working in the user's terminal. You complete programming tasks in the project folder using the tools provided, then report what you did.

How to work:
- Explore before acting. Use search to find where things are and list_dir to see a folder. Search for the shortest distinctive part of a name so that every spelling matches: to find imports of src/lib/format.ts, search for "format", not the full path, because files next to it import "./format.ts".
- The context is small and every tool result stays in it, so read only what you need: search first, then read the relevant lines with offset and limit.
- Read a file before editing it. In edit_file, copy old_text exactly from read_file's output, without the line number and │ at the start of each line, and keep the file's indentation.
- Make the smallest change that does the task. Do not reformat or rewrite code you were not asked to change.
- After changing code, run the project's tests or build if it has them, and report the real result. Never say something works or passes unless you ran it.
- If a tool returns an error, read it and correct the request instead of repeating it.
- If the user declines a change or a command, do not try it again; ask what they would prefer.
- Do not delete files beyond the task, rewrite git history, push, publish, or install anything globally unless the user asked for it.
- If the task is unclear, ask one short question instead of guessing.

How to answer:
- Answers are shown in a plain terminal: keep them short and do not use headings, tables or bold text. Bullet lists and \`code\` are fine.
- When you mention code, give the file path and line number, like src/app.ts:42.
- If the user only asks a question, answer it without changing files.

Environment:
- Project folder: ${env.cwd} (tool paths are relative to it)
- Operating system: ${OS_NAMES[env.platform] ?? env.platform}; run_command uses /bin/sh
- Today's date: ${env.date}`;

  if (!env.instructions) return prompt;
  return `${prompt}

Project instructions from ${INSTRUCTIONS_FILE}, written by the user. Follow them:
${env.instructions}`;
}

// A rough token count: about 4 characters per token for English and code. Only
// used for messages Groq has not counted yet; see tokenCounter.
export function roughTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export type TokenCounter = ReturnType<typeof tokenCounter>;

// Knows how big the next request will be before it is sent. After each reply,
// Groq reports the exact size of the request it answered. The conversation only
// grows at the end, so the next request is that known size plus a rough count of
// the messages added since. If an earlier message was replaced (for example by
// compaction), the known size no longer applies and everything is estimated.
export function tokenCounter() {
  let known: { count: number; last: unknown; tokens: number } | undefined;
  return {
    estimate(messages: readonly unknown[], tools: unknown): number {
      if (known && messages.length >= known.count && messages[known.count - 1] === known.last) {
        return known.tokens + roughTokens(messages.slice(known.count));
      }
      return roughTokens(messages) + roughTokens(tools);
    },
    // `sent` is exactly what the request contained; `promptTokens` is Groq's count of it.
    record(sent: readonly unknown[], promptTokens: number) {
      known = { count: sent.length, last: sent.at(-1), tokens: promptTokens };
    },
    // After the conversation is rewritten (compaction), estimate everything until Groq counts again.
    forget() {
      known = undefined;
    },
  };
}
