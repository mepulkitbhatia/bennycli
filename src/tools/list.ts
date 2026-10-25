import { readdir } from "node:fs/promises";
import { z } from "zod";
import { capLines, defineTool, resolveInside } from "./tool.ts";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List the files and folders directly inside a folder. Folders end with /.",
  schema: z.object({
    path: z.string().optional().describe("Folder path, relative to the project. Default: the project root"),
  }),
  async run({ path = "." }, { cwd }) {
    const full = await resolveInside(cwd, path);
    const entries = await readdir(full, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`Folder not found: ${path}`);
      if (err.code === "ENOTDIR") throw new Error(`${path} is a file, not a folder. Use read_file to read it.`);
      throw err;
    });

    const names = entries
      .filter((entry) => entry.name !== ".git")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (names.length === 0) return "(empty folder)";
    return capLines(names, (shown, total) => `[Showing ${shown} of ${total} entries.]`, 200);
  },
});
