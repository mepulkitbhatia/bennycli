# Benny

A coding agent for your terminal. Describe a task, and Benny reads, searches and edits your code and runs commands until the task is done, asking before it changes anything.

The agent loop is written from scratch, with no agent framework or agent SDK. It runs on [Groq](https://groq.com)'s free tier by default and works with any OpenAI-compatible API.

> Early release (0.1). The core loop and tools work; context management, saved sessions and an eval suite are in progress.

## Install

You need Node.js 22 or later, [ripgrep](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`), and a free Groq API key from [console.groq.com/keys](https://console.groq.com/keys).

```sh
npm install -g @pulkitbhatia/bennycli
export GROQ_API_KEY=your-key
```

## Use

Run `benny` inside the project you want to work on:

```
$ benny
> The test in math.test.js is failing. Find out why and fix it.
● read_file {"path":"math.test.js"}
● read_file {"path":"math.js"}
● edit_file {"path":"math.js","old_text":"return a - b;","new_text":"return a + b;"}
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
Allow edit_file? (y)es / (n)o / (a)lways  y
● run_command {"command":"npm test"}
$ npm test
Allow run_command? (y)es / (n)o / (a)lways for this exact command  y
Fixed: add() subtracted instead of adding. Both tests pass now.
```

Ctrl+C stops the current reply or command. Ctrl+C at an empty prompt, or Ctrl+D, exits.

## Tools

| Tool | What it does | Asks first |
|---|---|---|
| `read_file` | Reads a file with line numbers, in parts if it is long | No |
| `list_dir` | Lists a folder | No |
| `search` | Searches the code with ripgrep | No |
| `edit_file` | Replaces one exact piece of text, shown as a diff | Yes |
| `write_file` | Creates or replaces a file, shown as a diff | Yes |
| `run_command` | Runs a shell command with a timeout | Yes |

Benny only reads and writes files inside the folder it was started in.

## Settings

| Variable | Default |
|---|---|
| `GROQ_API_KEY` or `BENNY_API_KEY` | (required) |
| `BENNY_MODEL` | `openai/gpt-oss-120b` |
| `BENNY_BASE_URL` | `https://api.groq.com/openai/v1` |
| `BENNY_CONTEXT_LIMIT` | `7000` tokens, which fits Groq's free tier. Raise it for a paid tier or another provider. |

To use another OpenAI-compatible provider, set `BENNY_BASE_URL`, `BENNY_MODEL` and `BENNY_API_KEY`.

## How it works

The loop is in [`src/agent.ts`](src/agent.ts): send the conversation and the tool list to the model; if it answers in text, the turn is over; if it asks for tools, run them, add the results to the conversation, and ask again. Each tool is a function with a [Zod](https://zod.dev) schema, which is both sent to the model and used to check what the model sends back.

## License

MIT
