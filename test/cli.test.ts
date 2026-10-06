import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("benny --version prints the package version", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const out = execFileSync(process.execPath, ["src/cli.ts", "--version"], { encoding: "utf8" });
  expect(out.trim()).toBe(version);
});
