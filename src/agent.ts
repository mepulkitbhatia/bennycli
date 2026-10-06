import type { Chat, Message, Usage } from "./llm.ts";

// One turn of conversation: send everything said so far, stream the reply and
// remember it. The model keeps no memory between requests, so `messages` is the
// memory. Step 4 turns this into the agent loop by repeating while the model
// asks for tools.
export async function runTurn(
  messages: Message[],
  chat: Chat,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ usage?: Usage; aborted: boolean }> {
  let shown = "";
  const collectShown = (text: string) => {
    shown += text;
    onText(text);
  };
  // A stopped request may throw or may just end early (the OpenAI SDK ends its
  // stream quietly), so the signal decides what happened, not the error.
  const reply = await chat(messages, { signal, onText: collectShown }).catch((err) => {
    if (!signal?.aborted) throw err;
  });
  if (signal?.aborted || !reply) {
    // Stopped by the user: keep the part they already saw, so the next request matches the screen.
    if (shown) messages.push({ role: "assistant", content: shown });
    return { aborted: true };
  }
  messages.push({ role: "assistant", content: reply.content });
  return { usage: reply.usage, aborted: false };
}
