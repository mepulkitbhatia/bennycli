#!/usr/bin/env node
import { readFileSync } from "node:fs";

// package.json sits one level above both src/ (dev) and dist/ (published).
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(version);
} else {
  console.log(`benny ${version}: chat arrives in step 2. Try: benny --version`);
}
