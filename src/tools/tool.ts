import { structuredPatch } from "diff";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type OpenAI from "openai";
import { z } from "zod";

// What a tool gets besides its input: where the project is, and a way to ask
// the user before changing anything. Read-only tools never call confirm.
export type ToolContext = {
  cwd: string;
  confirm: (preview: string) => Promise<boolean>;
};

// The user's answer to "may this tool do this?", decided by the CLI.
export type Permission = (tool: string, preview: string) => Promise<boolean>;

// A tool is an ordinary function plus what the model needs to ask for it:
// a name, a description, and a schema for its input.
export type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  // `input` is whatever `schema` produced, so it has already been validated.
  run: (input: any, ctx: ToolContext) => Promise<string>;
};

// Ties the type of `run`'s input to the schema, so each tool is checked by TypeScript.
export function defineTool<Schema extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: Schema;
  run: (input: z.infer<Schema>, ctx: ToolContext) => Promise<string>;
}): Tool {
  return tool;
}

// The tool list in the format the chat API expects: each schema becomes JSON Schema.
export function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((tool) => {
    const { $schema, ...parameters } = z.toJSONSchema(tool.schema);
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
}

// Runs one tool request from the model. The name and the arguments were typed
// by the model, so either can be wrong. Every failure comes back as text the
// model can read and correct, never as a crash.
export async function runTool(
  tools: Tool[],
  name: string,
  rawArgs: string,
  ctx: { cwd: string; permission: Permission },
): Promise<string> {
  // gpt-oss sometimes prefixes the name with a namespace it invented ("repo_browser.list_dir").
  const tool = tools.find((t) => t.name === name || t.name === name.replace(/^\w+\./, ""));
  if (!tool) {
    return `Error: there is no tool named "${name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`;
  }

  let args: unknown;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return `Error: the arguments for ${name} were not valid JSON. Send one JSON object.`;
  }

  const parsed = tool.schema.safeParse(dropNulls(args));
  if (!parsed.success) {
    return `Error: invalid arguments for ${name}.\n${z.prettifyError(parsed.error)}`;
  }

  try {
    return await tool.run(parsed.data, { cwd: ctx.cwd, confirm: (preview) => ctx.permission(tool.name, preview) });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Models often send `null` for an optional argument they do not want to set.
function dropNulls(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

// Turns a path from the model into an absolute path, refusing anything outside
// the project folder, including through a symlink. For a path that does not
// exist yet, the nearest existing parent folder is what gets checked.
export async function resolveInside(cwd: string, path: string): Promise<string> {
  const outside = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  const refuse = () => new Error(`${path} is outside the project folder. Only files inside the project can be used.`);

  const full = resolve(cwd, path);
  if (outside(cwd, full)) throw refuse();

  let existing = full;
  while (true) {
    try {
      if (outside(await realpath(cwd), await realpath(existing))) throw refuse();
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      existing = dirname(existing);
    }
  }
}

// Everything a tool returns is sent to the model again on every later request,
// so output is capped. 6,000 characters is roughly 1,500 tokens.
export const OUTPUT_MAX_CHARS = 6000;

// Keeps the first lines that fit and ends with a note telling the model what was left out.
export function capLines(lines: string[], note: (shown: number, total: number) => string, maxLines = 50): string {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= maxLines || (out.length > 0 && chars + line.length > OUTPUT_MAX_CHARS)) break;
    out.push(line);
    chars += line.length + 1;
  }
  if (out.length < lines.length) out.push(note(out.length, lines.length));
  return out.join("\n");
}

// A unified diff of one file, shown to the user before a change is applied.
export function diffPreview(path: string, before: string, after: string): string {
  const { hunks } = structuredPatch(path, path, before, after, "", "", { context: 3 });
  const lines = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  return capLines(lines, (shown, total) => `… ${total - shown} more lines of changes not shown`, 200);
}
