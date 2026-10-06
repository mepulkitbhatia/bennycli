#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { runTurn } from "./agent.ts";
import { createChat, type Message } from "./llm.ts";

// package.json sits one level above both src/ (dev) and dist/ (published).
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

async function main() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(version);
    return;
  }

  // Any OpenAI-compatible provider works: change the URL and the model name.
  const apiKey = process.env.BENNY_API_KEY ?? process.env.GROQ_API_KEY;
  const baseURL = process.env.BENNY_BASE_URL ?? "https://api.groq.com/openai/v1";
  const model = process.env.BENNY_MODEL ?? "openai/gpt-oss-120b";
  if (!apiKey) {
    console.error("No API key found. Get a free key at https://console.groq.com/keys, then run:\n  export GROQ_API_KEY=your-key");
    process.exitCode = 1;
    return;
  }

  const chat = createChat({ apiKey, baseURL, model });
  const messages: Message[] = [];
  let replying: AbortController | undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.on("SIGINT", () => {
    if (replying) replying.abort(); // Ctrl+C during a reply stops the reply, not Benny
    else rl.close(); // Ctrl+C at the prompt leaves
  });
  // Input can end while a reply is still streaming (Ctrl+D, or piped input); prompting then would throw.
  let open = true;
  rl.on("close", () => (open = false));
  const prompt = () => open && rl.prompt();

  console.log(styleText("dim", `benny ${version} · ${model} · Ctrl+C stops a reply, Ctrl+D exits`));
  prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text) {
      messages.push({ role: "user", content: text });
      replying = new AbortController();
      try {
        const { usage, aborted } = await runTurn(messages, chat, (piece) => process.stdout.write(piece), replying.signal);
        console.log(aborted ? styleText("dim", "\n(stopped)") : "");
        if (usage) console.log(styleText("dim", `${usage.total_tokens} tokens`));
      } catch (err) {
        messages.pop(); // the request failed, so forget the message and let the user try again
        console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      }
      replying = undefined;
    }
    prompt();
  }
  console.log();
}

await main();
