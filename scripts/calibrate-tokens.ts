// Throwaway check: runs one real task and compares, for every request, the rough
// token estimate and the counter's estimate with the size Groq reports.
// Run with: node --env-file=.env scripts/calibrate-tokens.ts "task"
import { runTurn } from "../src/agent.ts";
import { roughTokens, systemPrompt, tokenCounter } from "../src/context.ts";
import { createChat, type Chat, type Message } from "../src/llm.ts";
import { tools } from "../src/tools/index.ts";
import { toOpenAITools } from "../src/tools/tool.ts";

const real = createChat({ apiKey: process.env.GROQ_API_KEY!, baseURL: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" });
const counter = tokenCounter();
const defs = toOpenAITools(tools);
const chat: Chat = async (messages, opts) => {
  const rough = roughTokens(messages) + roughTokens(defs);
  const counted = counter.estimate(messages, defs);
  const reply = await real(messages, opts);
  const actual = reply.usage!.prompt_tokens;
  counter.record(messages, actual);
  const pct = (n: number) => `${n >= actual ? "+" : ""}${Math.round(((n - actual) / actual) * 100)}%`;
  console.log(`request ${String(messages.length).padStart(2)} msgs | actual ${actual} | rough ${rough} (${pct(rough)}) | counter ${counted} (${pct(counted)})`);
  return reply;
};
const messages: Message[] = [
  { role: "system", content: systemPrompt({ cwd: process.cwd(), platform: process.platform, date: "2026-11-10" }) },
  { role: "user", content: process.argv[2]! },
];
await runTurn(messages, chat, { onText: () => {}, onToolCall: (n, a) => console.log(`   ● ${n} ${a.slice(0, 70)}`), onNotice: console.log }, {
  tools: tools.filter((t) => ["read_file", "list_dir", "search"].includes(t.name)), // read-only, nothing to approve
  cwd: process.cwd(),
  permission: async () => false,
});
