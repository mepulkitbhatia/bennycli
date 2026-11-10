import { tokenCounter, type TokenCounter } from "./context.ts";
import { MalformedToolCallError, type Chat, type Message, type Reply } from "./llm.ts";
import { runTool, toOpenAITools, type Permission, type Tool } from "./tools/tool.ts";

export type TurnEvents = {
  onText: (text: string) => void;
  onToolCall: (name: string, args: string) => void;
  onNotice: (text: string) => void;
};

const MALFORMED_RETRIES = 2;

export type TurnOptions = {
  tools: Tool[];
  cwd: string;
  permission: Permission;
  signal?: AbortSignal;
  maxSteps?: number;
  // A request bigger than this (in tokens) is not sent. Keep one counter for the
  // whole session so it can reuse Groq's counts from earlier turns.
  contextLimit?: number;
  counter?: TokenCounter;
};

export type TurnResult = {
  requests: number;
  tokens: number;
  aborted: boolean;
  hitStepLimit: boolean;
  contextFull: boolean; // stopped because the next request would be over contextLimit
  contextTokens: number; // how big the conversation is now, as the next request would be
};

// The agent loop. Send everything said so far; if the model answers in text,
// the turn is over. If it asks for tools instead, run them, add the results to
// the conversation and ask again. The model keeps no memory between requests,
// so `messages` is the memory, and every tool result it sees is in there.
export async function runTurn(messages: Message[], chat: Chat, events: TurnEvents, opts: TurnOptions): Promise<TurnResult> {
  const lengthBefore = messages.length;
  const counter = opts.counter ?? tokenCounter();
  try {
    const result = await loop(messages, chat, events, { ...opts, counter });
    result.contextTokens = counter.estimate(messages, toOpenAITools(opts.tools));
    return result;
  } catch (err) {
    // A request failed part-way through. Drop the half-finished turn, or the next
    // request would carry a tool request with no result and fail as well.
    messages.length = lengthBefore;
    throw err;
  }
}

async function loop(
  messages: Message[],
  chat: Chat,
  events: TurnEvents,
  opts: TurnOptions & { counter: TokenCounter },
): Promise<TurnResult> {
  const { tools, cwd, permission, signal, maxSteps = 25, contextLimit = Infinity, counter } = opts;
  const toolDefs = toOpenAITools(tools);
  const result: TurnResult = { requests: 0, tokens: 0, aborted: false, hitStepLimit: false, contextFull: false, contextTokens: 0 };
  let lastMalformed: MalformedToolCallError | undefined;

  // ponytail: a plain step cap. Add detection of the same call repeating if the evals show loops.
  for (let step = 0; step < maxSteps; step++) {
    // Groq rejects a request over the limit outright, and waiting does not help,
    // so a request that will not fit is never sent. The conversation stays valid.
    if (counter.estimate(messages, toolDefs) > contextLimit) {
      result.contextFull = true;
      return result;
    }

    let shown = "";
    const onText = (text: string) => {
      shown += text;
      events.onText(text);
    };
    let reply: Reply | undefined;
    for (let attempt = 0; ; attempt++) {
      result.requests++;
      shown = "";
      try {
        // On a retry, tell the model what went wrong. The note is sent once and not kept.
        const request = attempt === 0 ? messages : [...messages, retryNote(lastMalformed!)];
        reply = await chat(request, { signal, onText, tools: toolDefs });
        if (reply.usage) counter.record(request, reply.usage.prompt_tokens);
        break;
      } catch (err) {
        // A stopped request may throw or may just end early (the OpenAI SDK ends its
        // stream quietly), so the signal decides what happened, not the error.
        if (signal?.aborted) break;
        if (!(err instanceof MalformedToolCallError) || attempt >= MALFORMED_RETRIES) throw err;
        lastMalformed = err;
        events.onNotice(`The model sent a tool request that could not be read. Asking again (${attempt + 1} of ${MALFORMED_RETRIES}).`);
      }
    }
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
        : await runTool(tools, call.name, call.arguments, { cwd, permission, signal });
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

function retryNote(err: MalformedToolCallError): Message {
  const sent = err.generation ? ` What you sent began: ${err.generation.slice(0, 300)}` : "";
  return {
    role: "user",
    content:
      `Your last reply could not be used: ${err.message}.${sent}\n` +
      "Reply again: either answer in plain text, or call one of the provided tools by its exact name with its arguments as one valid JSON object.",
  };
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
