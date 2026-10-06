import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("benny --version prints the package version", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const out = execFileSync(process.execPath, ["src/cli.ts", "--version"], { encoding: "utf8" });
  expect(out.trim()).toBe(version);
});

test("benny without an API key explains how to get one and exits with 1", () => {
  const { BENNY_API_KEY, GROQ_API_KEY, ...env } = process.env;
  const result = spawnSync(process.execPath, ["src/cli.ts"], { encoding: "utf8", env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("GROQ_API_KEY");
});
