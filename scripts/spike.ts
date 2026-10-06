// Throwaway measurement script: finds out how Groq's free tier really behaves
// before the design depends on it. Run with: npm run spike
// Spends roughly 15-20K tokens of the daily allowance and takes 2-3 minutes.
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
  maxRetries: 0, // we want to see 413 and 429 ourselves, not have the SDK hide them
});

const MAIN = "openai/gpt-oss-120b";
const TOKENS_PER_MINUTE = 8000;

type Params = OpenAI.Chat.ChatCompletionCreateParamsStreaming;
type Result = {
  status: number;
  usage?: OpenAI.CompletionUsage;
  usageFrom?: string;
  remaining?: number;
  deltaKeys: string[];
  error?: string;
  at: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    `${prefix} ${i}: Benny reads files, searches code, edits files and runs commands in a loop.`,
  ).join("\n");

async function call(label: string, model: string, messages: Params["messages"], extra: Partial<Params> = {}): Promise<Result> {
  console.log(`\n── ${label}  [${model}]`);
  const params: Params = { model, messages, stream: true, stream_options: { include_usage: true }, ...extra };
  try {
    const { data: stream, response } = await client.chat.completions.create(params).withResponse();
    let text = "";
    let reasoningChars = 0;
    let usage: OpenAI.CompletionUsage | undefined;
    let usageFrom: string | undefined;
    const deltaKeys = new Set<string>();

    for await (const chunk of stream) {
      const delta = (chunk.choices[0]?.delta ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(delta)) deltaKeys.add(key);
      if (typeof delta.content === "string") text += delta.content;
      if (typeof delta.reasoning === "string") reasoningChars += delta.reasoning.length;
      const groqUsage = (chunk as { x_groq?: { usage?: OpenAI.CompletionUsage } }).x_groq?.usage;
      if (chunk.usage) [usage, usageFrom] = [chunk.usage, "chunk.usage"];
      else if (groqUsage && !usage) [usage, usageFrom] = [groqUsage, "chunk.x_groq.usage"];
    }

    response.headers.forEach((value, key) => {
      if (key.startsWith("x-ratelimit")) console.log(`   ${key}: ${value}`);
    });
    console.log(`   usage (from ${usageFrom}): ${JSON.stringify(usage)}`);
    console.log(`   delta keys: ${[...deltaKeys].join(", ")} | reasoning chars: ${reasoningChars}`);
    console.log(`   reply: ${JSON.stringify(text.slice(0, 80))}`);
    return {
      status: response.status,
      usage,
      usageFrom,
      remaining: Number(response.headers.get("x-ratelimit-remaining-tokens")),
      deltaKeys: [...deltaKeys],
      at: Date.now(),
    };
  } catch (err) {
    if (!(err instanceof OpenAI.APIError)) throw err;
    console.log(`   HTTP ${err.status}: ${err.message}`);
    console.log(`   retry-after: ${err.headers?.get("retry-after") ?? "none"}`);
    return { status: err.status ?? 0, deltaKeys: [], error: err.message, at: Date.now() };
  }
}

const cached = (r: Result) => r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
const waitForFreshMinute = async (why: string) => {
  console.log(`\n   …waiting 62s for the tokens-per-minute window to refill (${why})`);
  await sleep(62_000);
};

const tiny: Params["messages"] = [{ role: "user", content: "Reply with the single word: ready" }];

// 1. What does a normal streamed reply look like?
const baseline = await call("1. baseline", MAIN, tiny, { reasoning_effort: "low" });

// 2. Does the space reserved for the reply count towards the 8K limit?
const bigReserve = await call("2. tiny prompt, 9000 tokens reserved for the reply", MAIN, tiny, {
  reasoning_effort: "low",
  max_completion_tokens: 9000,
});

// 3. Does each model have its own allowance?
const small = await call("3a. other model", "openai/gpt-oss-20b", tiny, { reasoning_effort: "low" });
const qwen = await call("3b. other model", "qwen/qwen3.8-27b", tiny, { max_completion_tokens: 300 });

// 4. Do cached tokens stretch the limit?
const prefixLines = 150;
const prefix = lines("Line", prefixLines);
const withPrefix = (user: string): Params["messages"] => [
  { role: "system", content: prefix },
  { role: "user", content: user },
];

const first = await call("4a. long prompt, first time", MAIN, withPrefix("Reply with: ok"), { reasoning_effort: "low" });
let second = await call("4b. same prompt again (should be cached)", MAIN, withPrefix("Reply with: ok"), { reasoning_effort: "low" });
if (second.status === 429 || (second.status === 200 && cached(second) === 0)) {
  await waitForFreshMinute("no cache hit yet, trying once more");
  second = await call("4b. same prompt, second try", MAIN, withPrefix("Reply with: ok"), { reasoning_effort: "low" });
}

// 4c. A request bigger than 8K in total, but whose cached part would bring it under.
const tokensPerLine = (first.usage?.prompt_tokens ?? prefixLines * 22) / prefixLines;
const prefixTokens = Math.round(tokensPerLine * prefixLines);
const newTokens = Math.max(5500, TOKENS_PER_MINUTE + 800 - prefixTokens);
const fresh = lines("Note", Math.round(newTokens / tokensPerLine));
await waitForFreshMinute("so the oversized request is judged on its own");
const oversized = await call(
  `4c. ~${prefixTokens} cached + ~${newTokens} new = ~${prefixTokens + newTokens} tokens`,
  MAIN,
  withPrefix(`${fresh}\nReply with: ok`),
  { reasoning_effort: "low" },
);

console.log("\n════ FINDINGS ════");
console.log(`Usage arrives in: ${baseline.usageFrom}; stream delta keys: ${baseline.deltaKeys.join(", ")}`);
console.log(`Reasoning tokens on a trivial reply: ${baseline.usage?.completion_tokens_details?.reasoning_tokens ?? "not reported"}`);
console.log(`Reserved reply space counts towards 8K: ${bigReserve.status === 200 ? "NO (request accepted)" : `YES (HTTP ${bigReserve.status})`}`);
console.log(`Tokens left this minute, per model: 120b=${bigReserve.remaining ?? baseline.remaining}, 20b=${small.remaining}, qwen=${qwen.remaining}`);
console.log(`Cache hit on repeat: ${cached(second)} of ${second.usage?.prompt_tokens} prompt tokens`);
console.log(`Tokens left after 4a: ${first.remaining}; after 4b: ${second.remaining} (${((second.at - first.at) / 1000).toFixed(1)}s later, window refills ~133/s)`);
console.log(`Oversized request with cached prefix: ${oversized.status === 200 ? `ACCEPTED, cached ${cached(oversized)}` : `REJECTED (HTTP ${oversized.status})`}`);
