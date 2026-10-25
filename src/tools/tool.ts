import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type OpenAI from "openai";
import { z } from "zod";

// A tool is an ordinary function plus what the model needs to ask for it:
// a name, a description, and a schema for its input.
export type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  // `input` is whatever `schema` produced, so it has already been validated.
  run: (input: any, cwd: string) => Promise<string>;
};

// Ties the type of `run`'s input to the schema, so each tool is checked by TypeScript.
export function defineTool<Schema extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: Schema;
  run: (input: z.infer<Schema>, cwd: string) => Promise<string>;
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
export async function runTool(tools: Tool[], name: string, rawArgs: string, cwd: string): Promise<string> {
  const tool = tools.find((t) => t.name === name);
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
    return await tool.run(parsed.data, cwd);
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
// the project folder, including through a symlink.
export async function resolveInside(cwd: string, path: string): Promise<string> {
  const outside = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  const refuse = () => new Error(`${path} is outside the project folder. Only files inside the project can be used.`);

  const full = resolve(cwd, path);
  if (outside(cwd, full)) throw refuse();
  try {
    if (outside(await realpath(cwd), await realpath(full))) throw refuse();
  } catch (err) {
    // ponytail: a path that does not exist yet passes on the check above alone.
    // Fine for reading; write_file (step 6) must also check the parent folder.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return full;
}
