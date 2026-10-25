import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, diffPreview, resolveInside } from "./tool.ts";

// "Replace this exact text with that text" is far more reliable with open
// models than asking them to rewrite a whole file: the change is small, easy to
// show as a diff, and cannot silently drop the rest of the file.
export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace one exact piece of text in a file with new text. old_text must match the file exactly " +
    "(including spaces and indentation) and appear exactly once; include surrounding lines to make it unique. " +
    "Read the file first.",
  schema: z.object({
    path: z.string().describe("File path, relative to the project folder"),
    old_text: z.string().min(1).describe("The exact text to replace, copied from the file"),
    new_text: z.string().describe("The text to put in its place. Empty string deletes old_text"),
  }),
  async run({ path, old_text, new_text }, { cwd, confirm }) {
    const full = await resolveInside(cwd, path);
    const before = await readFile(full, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`File not found: ${path}. Use write_file to create a new file.`);
      throw err;
    });

    // ponytail: exact match only. Add whitespace-tolerant matching if the evals show models mis-copying indentation.
    const count = before.split(old_text).length - 1;
    if (count === 0) {
      throw new Error(`old_text was not found in ${path}. It must match the file exactly, including spaces and indentation. Read the file and copy the text from it.`);
    }
    if (count > 1) {
      throw new Error(`old_text appears ${count} times in ${path}. Include more surrounding lines so it matches exactly once.`);
    }
    if (old_text === new_text) throw new Error("old_text and new_text are the same, so there is nothing to change.");

    const at = before.indexOf(old_text);
    const after = before.slice(0, at) + new_text + before.slice(at + old_text.length);
    if (!(await confirm(diffPreview(path, before, after)))) {
      return "The user declined this change. Ask them what they would prefer, or try a different approach.";
    }

    await writeFile(full, after);
    const startLine = before.slice(0, at).split("\n").length;
    const endLine = startLine + Math.max(new_text.split("\n").length - 1, 0);
    return `Edited ${path}: lines ${startLine}-${endLine} now contain the new text.`;
  },
});
