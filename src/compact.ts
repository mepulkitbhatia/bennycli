import { roughTokens } from "./context.ts";
import type { Chat, Message } from "./llm.ts";

// Compaction: when the conversation no longer fits, the oldest part is replaced
// by a short summary written by a smaller model, and the turn carries on.
// messages[0] (the system prompt) and the most recent messages stay as they are.

const SUMMARY_PROMPT = `You summarise the earlier part of a conversation between a user and Benny, a coding agent, so that Benny can continue the work without it.

Write at most 250 words of plain-text bullet points, in the order things happened. Keep everything needed to continue:
- what the user asked for, and any preferences or constraints they stated
- files read, with the facts learned from them (names, line numbers, what the code does)
- files changed and how, commands run and their results
- decisions made, including anything the user declined
- what is still left to do

Leave out greetings, repetition and anything no longer relevant. Do not invent details.`;

const SUMMARY_HEADER = "Summary of everything that happened before the messages that follow, in order (written by Benny to save space):";
// Each tool result is shortened in what the summary model sees, and the whole
// transcript is capped, so the summary request itself always fits on the free tier.
const RESULT_CHARS = 2000;
const TRANSCRIPT_MAX_CHARS = 24_000; // about 6,000 tokens

// Where to cut: messages[1..cut) are summarised and messages[cut..] kept. A cut
// never lands on a tool result, so a tool request always keeps its results. It
// keeps as many recent messages as fit in keepTokens, and at least the last
// tool request with its results. Undefined means there is nothing to summarise.
export function chooseCut(messages: Message[], keepTokens: number): number | undefined {
  let cut: number | undefined;
  for (let i = messages.length - 1; i >= 2; i--) {
    if (messages[i]!.role === "tool") continue;
    if (cut !== undefined && roughTokens(messages.slice(i)) > keepTokens) break;
    cut = i;
  }
  return cut;
}

// Replaces the oldest messages with a summary. Returns how many messages were
// summarised, or 0 if there was nothing to summarise. Throws if the summary
// request fails, leaving `messages` untouched.
export async function compact(messages: Message[], summarize: Chat, opts: { keepTokens: number; signal?: AbortSignal }): Promise<number> {
  const cut = chooseCut(messages, opts.keepTokens);
  if (cut === undefined) return 0;
  const old = messages.slice(1, cut);

  const reply = await summarize(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: transcript(old) },
    ],
    { onText: () => {}, signal: opts.signal },
  );
  const summary = reply.content.trim();
  if (!summary) throw new Error("the summary came back empty");

  // The user's latest request is kept word for word, never paraphrased, even
  // when the work on it has to be summarised. It goes back in after the summary.
  const lastRequest = messages.findLast((m) => m.role === "user" && !isSummary(m));
  const keepRequest = lastRequest && old.includes(lastRequest) ? [lastRequest] : [];

  messages.splice(1, cut - 1, { role: "user", content: `${SUMMARY_HEADER}\n${summary}` }, ...keepRequest);
  return old.length;
}

function isSummary(message: Message): boolean {
  return typeof message.content === "string" && message.content.startsWith(SUMMARY_HEADER);
}

// The messages as plain text. Sent as tool-call structures, the summary model
// would try to continue the conversation instead of summarising it.
function transcript(messages: Message[]): string {
  const text = messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : "";
      if (m.role === "tool") {
        const shown = content.length > RESULT_CHARS ? `${content.slice(0, RESULT_CHARS)}\n[… result shortened]` : content;
        return `Tool result:\n${shown}`;
      }
      if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).map((c) => (c.type === "function" ? `Benny used ${c.function.name} ${c.function.arguments}` : ""));
        return [content && `Benny: ${content}`, ...calls].filter(Boolean).join("\n");
      }
      return isSummary(m) ? content : `User: ${content}`;
    })
    .join("\n\n");
  if (text.length <= TRANSCRIPT_MAX_CHARS) return text;
  return `${text.slice(0, TRANSCRIPT_MAX_CHARS / 3)}\n\n[… middle of the conversation left out …]\n\n${text.slice((-TRANSCRIPT_MAX_CHARS * 2) / 3)}`;
}
