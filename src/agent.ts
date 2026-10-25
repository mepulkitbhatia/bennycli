import type { Chat, Message, Reply } from "./llm.ts";
import { runTool, toOpenAITools, type Tool } from "./tools/tool.ts";

export type TurnEvents = {
  onText: (text: string) => void;
  onToolCall: (name: string, args: string) => void;
};

export type TurnOptions = {
  tools: Tool[];
  cwd: string;
  signal?: AbortSignal;
  maxSteps?: number;
};

export type TurnResult = {
  requests: number;
  tokens: number;
  aborted: boolean;
  hitStepLimit: boolean;
};

// The agent loop. Send everything said so far; if the model answers in text,
// the turn is over. If it asks for tools instead, run them, add the results to
// the conversation and ask again. The model keeps no memory between requests,
// so `messages` is the memory, and every tool result it sees is in there.
export async function runTurn(messages: Message[], chat: Chat, events: TurnEvents, opts: TurnOptions): Promise<TurnResult> {
  const lengthBefore = messages.length;
  try {
    return await loop(messages, chat, events, opts);
  } catch (err) {
    // A request failed part-way through. Drop the half-finished turn, or the next
    // request would carry a tool request with no result and fail as well.
    messages.length = lengthBefore;
    throw err;
  }
}

async function loop(messages: Message[], chat: Chat, events: TurnEvents, opts: TurnOptions): Promise<TurnResult> {
  const { tools, cwd, signal, maxSteps = 25 } = opts;
  const toolDefs = toOpenAITools(tools);
  const result: TurnResult = { requests: 0, tokens: 0, aborted: false, hitStepLimit: false };

  // ponytail: a plain step cap. Add detection of the same call repeating if the evals show loops.
  for (let step = 0; step < maxSteps; step++) {
    let shown = "";
    const onText = (text: string) => {
      shown += text;
      events.onText(text);
    };
    // A stopped request may throw or may just end early (the OpenAI SDK ends its
    // stream quietly), so the signal decides what happened, not the error.
    const reply = await chat(messages, { signal, onText, tools: toolDefs }).catch((err) => {
      if (!signal?.aborted) throw err;
    });
    result.requests++;
    if (signal?.aborted || !reply) {
      // Stopped by the user: keep the text they already saw, so the next request matches the
      // screen. Half-received tool requests are dropped; they were never run.
      if (shown) messages.push({ role: "assistant", content: shown });
      result.aborted = true;
      return result;
    }

    result.tokens += reply.usage?.total_tokens ?? 0;
    messages.push(assistantMessage(reply));
    if (reply.toolCalls.length === 0) return result;

    // Every tool request must get a result, even a cancelled one, or the next request is invalid.
    for (const call of reply.toolCalls) {
      events.onToolCall(call.name, call.arguments);
      const content = signal?.aborted
        ? "Cancelled: the user stopped this turn before the tool ran."
        : await runTool(tools, call.name, call.arguments, cwd);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    if (signal?.aborted) {
      result.aborted = true;
      return result;
    }
  }

  result.hitStepLimit = true;
  return result;
}

function assistantMessage(reply: Reply): Message {
  return {
    role: "assistant",
    content: reply.content || null,
    ...(reply.toolCalls.length > 0 && {
      tool_calls: reply.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    }),
  };
}
