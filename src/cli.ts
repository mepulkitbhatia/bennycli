#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import { runTurn } from "./agent.ts";
import { INSTRUCTIONS_FILE, loadProjectInstructions, systemPrompt, tokenCounter } from "./context.ts";
import { createChat, type Message } from "./llm.ts";
import { createPermissions } from "./permissions.ts";
import { tools } from "./tools/index.ts";
import { ripgrepAvailable } from "./tools/search.ts";

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
  // Groq's free tier rejects any request over 8,000 tokens a minute, which by Groq's own
  // count of a prompt is about 7,570. 7,000 leaves room for the estimate being a little low.
  const contextLimit = Number(process.env.BENNY_CONTEXT_LIMIT) || 7000;
  const counter = tokenCounter();
  if (!apiKey) {
    console.error("No API key found. Get a free key at https://console.groq.com/keys, then run:\n  export GROQ_API_KEY=your-key");
    process.exitCode = 1;
    return;
  }

  const chat = createChat({ apiKey, baseURL, model });
  let available = tools;
  if (!(await ripgrepAvailable())) {
    console.error(styleText("yellow", "ripgrep (rg) is not installed, so the search tool is off. Install it with: brew install ripgrep"));
    available = tools.filter((tool) => tool.name !== "search");
  }
  const cwd = process.cwd();
  const instructions = await loadProjectInstructions(cwd);
  // The instructions come first in every request. Local date, as YYYY-MM-DD.
  const date = new Date().toLocaleDateString("en-CA");
  const messages: Message[] = [{ role: "system", content: systemPrompt({ cwd, platform: process.platform, date, instructions }) }];
  let replying: AbortController | undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  // The question is cancelled by the same Ctrl+C that stops the turn, and a cancelled question is a "no".
  const permission = createPermissions((question) => rl.question(question, { signal: replying?.signal }));
  rl.on("SIGINT", () => {
    if (replying) replying.abort(); // Ctrl+C during a reply stops the reply, not Benny
    else rl.close(); // Ctrl+C at the prompt leaves
  });
  // Input can end while a reply is still streaming (Ctrl+D, or piped input); prompting then would throw.
  let open = true;
  rl.on("close", () => (open = false));
  const prompt = () => open && rl.prompt();

  // Streamed text and tool lines share the screen; keep each tool line on its own line.
  let midLine = false;
  const events = {
    onText: (text: string) => {
      process.stdout.write(text);
      midLine = !text.endsWith("\n");
    },
    onNotice: (text: string) => {
      console.log(`${midLine ? "\n" : ""}${styleText("yellow", text)}`);
      midLine = false;
    },
    onToolCall: (name: string, args: string) => {
      const shown = args.length > 100 ? `${args.slice(0, 100)}…` : args;
      console.log(`${midLine ? "\n" : ""}${styleText("cyan", "●")} ${name} ${styleText("dim", shown)}`);
      midLine = false;
    },
  };

  console.log(styleText("dim", `benny ${version} · ${model} · Ctrl+C stops a reply, Ctrl+D exits`));
  if (instructions) console.log(styleText("dim", `Following ${INSTRUCTIONS_FILE} in this folder`));
  prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text) {
      messages.push({ role: "user", content: text });
      replying = new AbortController();
      try {
        const result = await runTurn(messages, chat, events, { tools: available, cwd, permission, signal: replying.signal, contextLimit, counter });
        if (midLine) console.log();
        midLine = false;
        if (result.aborted) console.log(styleText("dim", "(stopped)"));
        if (result.hitStepLimit) console.log(styleText("yellow", "Stopped after 25 tool steps. Say \"continue\" to carry on."));
        if (result.contextFull) {
          console.log(styleText("yellow", `The conversation is now too long to send (about ${result.contextTokens.toLocaleString("en")} tokens; the limit is ${contextLimit.toLocaleString("en")}). Start a new session: press Ctrl+D, then run benny again.`));
        }
        const plural = result.requests === 1 ? "" : "s";
        console.log(styleText("dim", `${result.tokens.toLocaleString("en")} tokens · ${result.requests} request${plural} · context ${kilo(result.contextTokens)} of ${kilo(contextLimit)}`));
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

function kilo(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

await main();
