import OpenAI from "openai";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type Chunk = OpenAI.Chat.ChatCompletionChunk;
export type Usage = OpenAI.CompletionUsage;
export type Reply = { content: string; usage?: Usage };

// The one function the rest of Benny uses to talk to a model. Tests pass in a
// fake with the same shape, so nothing above this file needs the network.
export type Chat = (
  messages: Message[],
  opts: { onText: (text: string) => void; signal?: AbortSignal },
) => Promise<Reply>;

// A streamed reply arrives as many small chunks. This joins them into one
// reply and hands each piece of visible text to onText as it arrives.
export async function collect(stream: AsyncIterable<Chunk>, onText: (text: string) => void): Promise<Reply> {
  let content = "";
  let usage: Usage | undefined;
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) {
      content += text;
      onText(text);
    }
    if (chunk.usage) usage = chunk.usage; // sent once, in the last chunk
  }
  return { content, usage };
}

export function createChat(config: { apiKey: string; baseURL: string; model: string }): Chat {
  // The SDK retries rate-limit (429) and server errors itself, waiting as long as the server asks.
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 5 });
  return async (messages, { onText, signal }) => {
    const stream = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        // ponytail: model-name check. gpt-oss thinks before answering and those tokens count
        // against the rate limit; move this to config when a second reasoning model needs it.
        ...(config.model.includes("gpt-oss") && { reasoning_effort: "low" as const }),
      },
      { signal },
    );
    return collect(stream, onText);
  };
}
