import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool, OUTPUT_MAX_CHARS, resolveInside } from "./tool.ts";

const DEFAULT_LIMIT = 150;
const MAX_LINE_CHARS = 400;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from the project. Returns the lines with their line numbers. " +
    "A large file is returned in parts: use offset and limit to read further.",
  schema: z.object({
    path: z.string().describe("File path, relative to the project folder"),
    // coerce: models sometimes send numbers as strings ("10")
    offset: z.coerce.number().int().min(1).optional().describe("Line number to start from. The first line is 1"),
    limit: z.coerce.number().int().min(1).optional().describe(`Maximum number of lines to return. Default ${DEFAULT_LIMIT}`),
  }),
  async run({ path, offset = 1, limit = DEFAULT_LIMIT }, cwd) {
    const full = await resolveInside(cwd, path);
    const info = await stat(full).catch(() => undefined);
    if (!info) throw new Error(`File not found: ${path}. Use list_dir or search to find the right path.`);
    if (info.isDirectory()) throw new Error(`${path} is a folder, not a file.`);
    // ponytail: reads the whole file to count lines; read line by line if bigger files matter.
    if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to read (${Math.round(info.size / 1024 / 1024)} MB).`);

    const bytes = await readFile(full);
    if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${path} looks like a binary file, not text.`);

    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop(); // the newline that ends the file is not an extra line
    if (lines.length === 0) return "(empty file)";
    if (offset > lines.length) throw new Error(`${path} has only ${lines.length} lines; offset ${offset} is past the end.`);

    const out: string[] = [];
    let chars = 0;
    const end = Math.min(lines.length, offset - 1 + limit);
    for (let i = offset - 1; i < end; i++) {
      let line = lines[i]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line cut]`;
      const numbered = `${i + 1}\t${line}`;
      if (out.length > 0 && chars + numbered.length > OUTPUT_MAX_CHARS) break;
      out.push(numbered);
      chars += numbered.length + 1;
    }

    const last = offset + out.length - 1;
    if (last < lines.length) {
      // Tell the model exactly how to get the rest.
      out.push(`[Showing lines ${offset}-${last} of ${lines.length}. To read more, call read_file with offset=${last + 1}.]`);
    }
    return out.join("\n");
  },
});
