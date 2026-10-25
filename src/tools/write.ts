import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool, diffPreview, resolveInside } from "./tool.ts";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a file with the given content, or replace an existing file's whole content. " +
    "Missing folders are created. To change part of an existing file, use edit_file instead.",
  schema: z.object({
    path: z.string().describe("File path, relative to the project folder"),
    content: z.string().describe("The complete content of the file"),
  }),
  async run({ path, content }, { cwd, confirm }) {
    const full = await resolveInside(cwd, path);
    const before = await readFile(full, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      if (err.code === "EISDIR") throw new Error(`${path} is a folder, not a file.`);
      throw err;
    });
    if (before === content) return `${path} already has exactly this content; nothing to do.`;

    const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const title = before === undefined ? `New file ${path} (${lines} lines)` : `Replace ${path} (${lines} lines)`;
    if (!(await confirm(`${title}\n${diffPreview(path, before ?? "", content)}`))) {
      return "The user declined this change. Ask them what they would prefer, or try a different approach.";
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    return `${before === undefined ? "Created" : "Replaced"} ${path} (${lines} lines).`;
  },
});
