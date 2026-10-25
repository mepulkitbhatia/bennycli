import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tools } from "../src/tools/index.ts";
import { runTool, toOpenAITools } from "../src/tools/tool.ts";

let base: string; // holds the project folder and one file outside it
let cwd: string;

const numbered = (count: number, text = "line") => Array.from({ length: count }, (_, i) => `${text} ${i + 1}`).join("\n") + "\n";
const read = (args: object) => runTool(tools, "read_file", JSON.stringify(args), cwd);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "benny-tools-"));
  cwd = join(base, "project");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(base, "secret.txt"), "outside the project\n");
  await writeFile(join(cwd, "small.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "big.txt"), numbered(1000));
  await writeFile(join(cwd, "wide.txt"), numbered(100, "x".repeat(300)));
  await writeFile(join(cwd, "minified.js"), `var a=${"1+".repeat(50_000)}1;\n`);
  await writeFile(join(cwd, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  await symlink(join(base, "secret.txt"), join(cwd, "link-to-secret.txt"));

  // for list_dir and search
  await writeFile(join(cwd, "src", "auth.ts"), "export function loginHandler() {}\nexport const LOGIN_PATH = '/login';\n");
  await writeFile(join(cwd, "src", "app.ts"), "import { loginHandler } from './auth.ts';\nloginHandler();\n");
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, "ignored", "notes.md"), "loginHandler is mentioned here too\n");
  await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  await mkdir(join(cwd, ".github"));
  await writeFile(join(cwd, ".github", "ci.yml"), "run: loginHandler\n");
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git", "HEAD"), "loginHandler\n");
  await writeFile(join(cwd, "many.txt"), numbered(100, "needle"));
  await mkdir(join(cwd, "crowd"));
  await Promise.all(Array.from({ length: 250 }, (_, i) => writeFile(join(cwd, "crowd", `f${String(i).padStart(3, "0")}.txt`), "")));
});

const list = (args: object) => runTool(tools, "list_dir", JSON.stringify(args), cwd);
const search = (args: object) => runTool(tools, "search", JSON.stringify(args), cwd);

afterAll(() => rm(base, { recursive: true, force: true }));

describe("read_file", () => {
  test("returns a small file with line numbers", async () => {
    expect(await read({ path: "small.txt" })).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  test("a missing file gives a clear message", async () => {
    expect(await read({ path: "nope.txt" })).toBe("Error: File not found: nope.txt. Use list_dir or search to find the right path.");
  });

  test("a long file is cut, and the note says how to read the rest", async () => {
    const first = await read({ path: "big.txt" });
    const lines = first.split("\n");
    expect(lines).toHaveLength(151);
    expect(lines[149]).toBe("150\tline 150");
    expect(lines[150]).toBe("[Showing lines 1-150 of 1000. To read more, call read_file with offset=151.]");

    const next = await read({ path: "big.txt", offset: 151, limit: 2 });
    expect(next.split("\n").slice(0, 2)).toEqual(["151\tline 151", "152\tline 152"]);

    expect(await read({ path: "big.txt", offset: 999 })).toBe("999\tline 999\n1000\tline 1000");
  });

  test("output stays under the size cap even when lines are long", async () => {
    const out = await read({ path: "wide.txt" });
    expect(out.length).toBeLessThan(6200);
    expect(out).toMatch(/\[Showing lines 1-\d+ of 100\. To read more, call read_file with offset=\d+\.\]$/);
  });

  test("one enormous line is cut instead of flooding the conversation", async () => {
    const out = await read({ path: "minified.js" });
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("[line cut]");
  });

  test("paths outside the project are refused", async () => {
    for (const path of ["../secret.txt", join(base, "secret.txt"), "/etc/hosts", "link-to-secret.txt"]) {
      const out = await read({ path });
      expect(out, path).toContain("outside the project folder");
      expect(out, path).not.toContain("outside the project\n");
    }
  });

  test("folders, binary files, empty files and a bad offset are explained", async () => {
    expect(await read({ path: "src" })).toBe("Error: src is a folder, not a file.");
    expect(await read({ path: "image.png" })).toBe("Error: image.png looks like a binary file, not text.");
    expect(await read({ path: "empty.txt" })).toBe("(empty file)");
    expect(await read({ path: "small.txt", offset: 10 })).toBe("Error: small.txt has only 3 lines; offset 10 is past the end.");
  });
});

describe("list_dir", () => {
  test("lists folders first, then files, and hides .git", async () => {
    const out = await list({ path: "." });
    const names = out.split("\n");
    expect(names.slice(0, 5)).toEqual([".github/", "crowd/", "ignored/", "src/", ".gitignore"]);
    expect(names).toContain("small.txt");
    expect(names).not.toContain(".git/");
  });

  test("defaults to the project root and lists a subfolder", async () => {
    expect(await list({})).toBe(await list({ path: "." }));
    expect(await list({ path: "src" })).toBe("app.ts\nauth.ts");
  });

  test("a huge folder is cut with a note", async () => {
    const lines = (await list({ path: "crowd" })).split("\n");
    expect(lines).toHaveLength(201);
    expect(lines[200]).toBe("[Showing 200 of 250 entries.]");
  });

  test("missing folders, files and outside paths are explained", async () => {
    expect(await list({ path: "nope" })).toBe("Error: Folder not found: nope");
    expect(await list({ path: "small.txt" })).toBe("Error: small.txt is a file, not a folder. Use read_file to read it.");
    expect(await list({ path: ".." })).toContain("outside the project folder");
  });
});

describe("search", () => {
  test("returns path:line:text for each match, skipping ignored files and .git", async () => {
    const out = await search({ pattern: "loginHandler" });
    const lines = out.split("\n").sort();
    expect(lines).toEqual([
      ".github/ci.yml:1:run: loginHandler",
      "src/app.ts:1:import { loginHandler } from './auth.ts';",
      "src/app.ts:2:loginHandler();",
      "src/auth.ts:1:export function loginHandler() {}",
    ]);
  });

  test("narrows by path and by glob", async () => {
    expect(await search({ pattern: "loginHandler", path: "src/auth.ts" })).toBe("src/auth.ts:1:export function loginHandler() {}");
    expect(await search({ pattern: "loginHandler", glob: "*.yml" })).toBe(".github/ci.yml:1:run: loginHandler");
  });

  test("is case-insensitive for lowercase patterns and supports regex", async () => {
    expect(await search({ pattern: "login_path" })).toBe("src/auth.ts:2:export const LOGIN_PATH = '/login';");
    expect(await search({ pattern: "^export (function|const)", path: "src" })).toContain("src/auth.ts:1:");
  });

  test("says so when nothing matches, and explains a bad pattern", async () => {
    expect(await search({ pattern: "zzz_not_here" })).toBe('No matches for "zzz_not_here" in ..');
    expect(await search({ pattern: "(unclosed" })).toMatch(/^Error: .*regex/);
  });

  test("too many matches are cut with a note", async () => {
    const lines = (await search({ pattern: "needle", path: "many.txt" })).split("\n");
    expect(lines).toHaveLength(21); // ripgrep stops at 20 per file, then one note
    expect(lines[19]).toBe("many.txt:20:needle 20");
    expect(lines[20]).toBe("[Only the first 20 matches per file are shown; many.txt has more. Use a narrower pattern or read_file to see them.]");
  });

  test("paths outside the project are refused", async () => {
    expect(await search({ pattern: "outside", path: ".." })).toContain("outside the project folder");
  });
});

describe("runTool handles whatever the model sends", () => {
  test("an unknown tool name lists the tools that exist", async () => {
    expect(await runTool(tools, "open_file", "{}", cwd)).toBe(
      'Error: there is no tool named "open_file". Available tools: read_file, list_dir, search.',
    );
  });

  test("a made-up namespace in front of the tool name is forgiven", async () => {
    expect(await runTool(tools, "repo_browser.read_file", '{"path":"small.txt"}', cwd)).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  test("broken JSON is reported", async () => {
    expect(await runTool(tools, "read_file", '{"path": "small.txt"', cwd)).toContain("not valid JSON");
  });

  test("a missing or wrongly typed argument names the field", async () => {
    const missing = await runTool(tools, "read_file", "{}", cwd);
    expect(missing).toContain("invalid arguments for read_file");
    expect(missing).toContain("path");

    expect(await read({ path: "small.txt", offset: "two" })).toContain("offset");
  });

  test("null for an optional argument and numbers sent as strings are accepted", async () => {
    expect(await read({ path: "small.txt", offset: null, limit: null })).toBe("1\talpha\n2\tbeta\n3\tgamma");
    expect(await read({ path: "small.txt", offset: "2", limit: "1" })).toBe("2\tbeta\n[Showing lines 2-2 of 3. To read more, call read_file with offset=3.]");
  });
});

test("the tool list is in the format the chat API expects", () => {
  const [first] = toOpenAITools(tools);
  expect(first).toMatchObject({
    type: "function",
    function: {
      name: "read_file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      },
    },
  });
  expect(first).not.toHaveProperty("function.parameters.$schema");
});
