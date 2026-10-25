import OpenAI from "openai";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type Chunk = OpenAI.Chat.ChatCompletionChunk;
export type Usage = OpenAI.CompletionUsage;
export type ToolDefinition = OpenAI.Chat.ChatCompletionTool;
// What the model asks for when it wants a tool. `arguments` is JSON the model typed, unparsed.
export type ToolCall = { id: string; name: string; arguments: string };
export type Reply = { content: string; toolCalls: ToolCall[]; usage?: Usage };

// The one function the rest of Benny uses to talk to a model. Tests pass in a
// fake with the same shape, so nothing above this file needs the network.
export type Chat = (
  messages: Message[],
  opts: { onText: (text: string) => void; tools?: ToolDefinition[]; signal?: AbortSignal },
) => Promise<Reply>;

// A streamed reply arrives as many small chunks. This joins them into one
// reply and hands each piece of visible text to onText as it arrives. A tool
// request also arrives in pieces: its id and name first, then its arguments a
// few characters at a time, all tagged with the same index.
export async function collect(stream: AsyncIterable<Chunk>, onText: (text: string) => void): Promise<Reply> {
  let content = "";
  let usage: Usage | undefined;
  const calls: ToolCall[] = [];
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onText(delta.content);
    }
    for (const piece of delta?.tool_calls ?? []) {
      const index = piece.index ?? (piece.id ? calls.length : calls.length - 1);
      const call = (calls[index] ??= { id: "", name: "", arguments: "" });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name += piece.function.name;
      if (piece.function?.arguments) call.arguments += piece.function.arguments;
    }
    if (chunk.usage) usage = chunk.usage; // sent once, in the last chunk
  }
  return { content, toolCalls: calls.filter(Boolean), usage };
}

export function createChat(config: { apiKey: string; baseURL: string; model: string }): Chat {
  // The SDK retries rate-limit (429) and server errors itself, waiting as long as the server asks.
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 5 });
  return async (messages, { onText, tools, signal }) => {
    const stream = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools?.length && { tools }),
        // ponytail: model-name check. gpt-oss thinks before answering and those tokens count
        // against the rate limit; move this to config when a second reasoning model needs it.
        ...(config.model.includes("gpt-oss") && { reasoning_effort: "low" as const }),
      },
      { signal },
    );
    return collect(stream, onText);
  };
}
