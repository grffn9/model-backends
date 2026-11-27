# model-backends

One streaming interface over every AI token source you have: subscription CLIs (GitHub Copilot, Claude Code, Codex, Antigravity), API keys (Claude, Gemini) and any OpenAI-compatible host (DeepSeek, OpenRouter, Groq, xAI, Mistral and others). It also reads each subscription's real usage, enforces the caps you set, and falls back to the next backend when one hits a limit.

Extracted from [model-switchboard](https://github.com/grffn9/model-switchboard). Start a new app from [agent-app-template](https://github.com/grffn9/agent-app-template), which already uses it.

## Install

```bash
npm install github:grffn9/model-backends#v0.1.0
```

Installing from git runs `prepare`, which builds `dist/`. Node 24 or later is required.

## Use

Describe your accounts and backends in YAML. [`examples/connections.yaml`](examples/connections.yaml) has one backend for every adapter:

```yaml
accounts:
  copilot: { label: GitHub Copilot, kind: subscription, liveUsage: { source: copilot } }
  deepseek-api: { label: DeepSeek API, kind: api, limits: [{ window: month, usd: 5 }] }
backends:
  - { id: copilot-gpt-6-luna, account: copilot, adapter: copilot, model: gpt-6-luna }
  - id: deepseek-flash
    account: deepseek-api
    adapter: openai
    baseUrl: https://api.deepseek.com
    apiKeyEnv: DEEPSEEK_API_KEY
    model: deepseek-flash
    price: { input: 0.3, output: 1.2 }
```

Then run a prompt on the first backend that can take it:

```ts
import { defaultAdapters, loadConnections, runWithFallback, UsageLedger } from "model-backends";

const { accounts, backends } = loadConnections("config/connections.yaml");
const ledger = new UsageLedger("data/usage.db");

for await (const event of runWithFallback({
  backends,
  accounts,
  ledger,
  adapters: defaultAdapters(),
  input: { messages: [{ role: "user", content: "Explain SSE in one line" }], attachments: [] },
})) {
  if (event.type === "text") process.stdout.write(event.text);
  if (event.type === "fallback") console.error(`\n${event.from} failed: ${event.reason}`);
}
```

## What's in it

| Export                                               | What it does                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseConnections`, `loadConnections`                | Read accounts and backends from YAML with `${VAR}` expansion. Fields it doesn't know are kept in `extras` for your app, such as routing scores. |
| `defaultAdapters`                                    | The seven adapters by name. Pass your own to add or replace one.                                                                                |
| `createCliAdapter`, `buildInvocation`                | Drives the CLIs: tool-free in an empty sandbox folder by default, or agent mode with tools on when you pass `folder`.                           |
| `anthropicAdapter`, `geminiAdapter`, `openaiAdapter` | Streaming HTTP adapters. The Claude adapter falls back to the `ant auth login` sign-in when no key is set.                                      |
| `runWithFallback`                                    | Tries backends in order. A limit pauses the account (or one model) until the provider's reset time.                                             |
| `checkBackend`, `describeProviders`                  | Whether each backend is set up, and how to link each account (key URL, CLI install and sign-in).                                                |
| `LiveUsage`, `defaultReaders`                        | Reads real usage: Copilot credits, Claude 5-hour and weekly percentages, Codex windows and credits.                                             |
| `UsageLedger`                                        | SQLite (`node:sqlite`) record of calls, caps you set and cooldowns. It never stores prompt text.                                                |
| `withoutSecrets`                                     | Strips API keys from a child process environment, so a subscription CLI is never billed as API.                                                 |
| `BackendError`                                       | Every failure has a `kind`: `rate_limit`, `auth`, `unavailable`, `timeout`, `bad_request`, `refused` or `cancelled`.                            |

## Develop

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

Tests run `src/` directly. Consumers get `dist/`, because Node won't strip TypeScript types inside `node_modules`.
