import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildInvocation,
  childEnv,
  classifyFailure,
  createCliAdapter,
  flatten,
} from "../src/adapters/cli.ts";
import type { SpawnFn } from "../src/adapters/cli.ts";
import { anthropicAdapter } from "../src/adapters/anthropic.ts";
import { geminiAdapter } from "../src/adapters/gemini.ts";
import { errorFromStatus, parseRetryAfter, readSse } from "../src/adapters/http.ts";
import { openaiAdapter } from "../src/adapters/openai.ts";
import { BackendError } from "../src/types.ts";
import type { Adapter, Backend, Effort, GenerateInput, OutputEvent } from "../src/types.ts";
import { antFolder, makeBackend, removeAntFolders } from "./helpers.ts";

const realFetch = globalThis.fetch;
// The Anthropic SDK reads these from process.env, so tests point them at a temporary sign-in.
const SIGN_IN_ENV = ["ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE"] as const;
const savedSignInEnv = SIGN_IN_ENV.map((name) => process.env[name]);
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TEST_KEY;
  SIGN_IN_ENV.forEach((name, index) => {
    if (savedSignInEnv[index] === undefined) delete process.env[name];
    else process.env[name] = savedSignInEnv[index];
  });
  removeAntFolders();
});

const input = (overrides: Partial<GenerateInput> = {}): GenerateInput => ({
  messages: [{ role: "user", content: "hello" }],
  attachments: [],
  signal: new AbortController().signal,
  ...overrides,
});

async function drain(adapter: Adapter, backend: Backend, request = input()) {
  const events: OutputEvent[] = [];
  for await (const event of adapter(backend, request)) events.push(event);
  return events;
}

const textOf = (events: OutputEvent[]) =>
  events.map((event) => (event.type === "text" ? event.text : "")).join("");

function sseResponse(lines: string[]): Response {
  return new Response(lines.map((line) => `data: ${line}\n\n`).join(""), { status: 200 });
}

/** Runs a tiny Node script in place of the real CLI. */
function fakeCli(script: string): SpawnFn {
  return ((_command, _args, options) =>
    spawn(process.execPath, ["-e", script], options)) as SpawnFn;
}

test("CLI environment drops API keys so subscriptions are not billed as API", () => {
  const env = childEnv(
    makeBackend({ id: "c", adapter: "claude-cli", env: { CLAUDE_CONFIG_DIR: "/profile" } }),
    {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "secret",
      GEMINI_API_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      CLAUDE_CONFIG_DIR: "/wrong",
      GH_TOKEN: "secret",
    },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/profile");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
  ]) {
    assert.equal(env[key], undefined, key);
  }
});

test("Codex uses its ChatGPT sign-in, never an API key or another account's token", () => {
  const env = childEnv(makeBackend({ id: "x", adapter: "codex" }), {
    PATH: "/bin",
    CODEX_HOME: "/codex",
    CODEX_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    CODEX_ACCESS_TOKEN: "secret",
  });
  assert.deepEqual(env, { NO_COLOR: "1", PATH: "/bin", CODEX_HOME: "/codex" });
});

test("Copilot keeps its GitHub token", () => {
  const env = childEnv(makeBackend({ id: "c", adapter: "copilot" }), { GH_TOKEN: "token" });
  assert.equal(env.GH_TOKEN, "token");
});

test("CLI invocations disable tools", () => {
  const copilot = buildInvocation(makeBackend({ id: "c", adapter: "copilot" }), "hi");
  assert.ok(copilot.args.includes("--available-tools="));
  assert.equal(copilot.stdin, "hi");

  const claude = buildInvocation(makeBackend({ id: "c", adapter: "claude-cli" }), "hi");
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.stdin, "hi");

  const agy = buildInvocation(makeBackend({ id: "c", adapter: "agy" }), "hi");
  assert.equal(agy.args.at(-1), "hi");
  const agySettings = JSON.parse(agy.args[agy.args.indexOf("--settings") + 1] ?? "{}") as {
    permissions: { deny: string[] };
  };
  for (const rule of ["command(*)", "write_file(*)", "read_file(*)"]) {
    assert.ok(agySettings.permissions.deny.includes(rule), rule);
  }
});

test("agy takes a prompt too long for its command line on stdin, on every OS", () => {
  const prompt = "x".repeat(40_000);
  const agy = buildInvocation(makeBackend({ id: "c", adapter: "agy" }), prompt);
  assert.ok(!agy.args.includes(prompt));
  assert.deepEqual(agy.args.slice(-2), ["-p", ""]);
  assert.equal(agy.args[agy.args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(agy.args[agy.args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(agy.json, true);
  assert.deepEqual(JSON.parse(agy.stdin ?? ""), { event: "user", message: { content: prompt } });
  assert.ok(agy.stdin?.endsWith("\n"));
  // Still tool-free.
  assert.ok(agy.args.includes("--settings"));
  assert.ok(!agy.args.includes("--dangerously-skip-permissions"));

  const short = buildInvocation(makeBackend({ id: "c", adapter: "agy" }), "hi");
  assert.equal(short.stdin, undefined);
  assert.equal(short.json, false);
  assert.ok(!short.args.includes("--input-format"));
});

test("Codex runs one tool-free turn that reads the prompt from stdin", () => {
  const { args, stdin } = buildInvocation(
    makeBackend({ id: "x", adapter: "codex", model: "gpt-6.2-sol" }),
    "hi",
  );
  const configs = args.flatMap((arg, index) => (args[index - 1] === "-c" ? [arg] : []));
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-");
  assert.equal(stdin, "hi");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6.2-sol");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  for (const flag of ["--skip-git-repo-check", "--ephemeral", "--ignore-user-config"]) {
    assert.ok(args.includes(flag), flag);
  }
  for (const feature of ["shell_tool", "unified_exec", "view_image", "code_mode_host", "apps"]) {
    assert.ok(configs.includes(`features.${feature}=false`), feature);
  }
  assert.ok(configs.includes("web_search=disabled"));
  // Some models default to the Fast tier, which spends credits twice as fast.
  assert.ok(configs.includes("service_tier=default"));
});

test("agent invocations turn tools on and skip approvals", () => {
  const agent = (adapter: Backend["adapter"]) =>
    buildInvocation(makeBackend({ id: "c", adapter }), "hi", undefined, true).args;

  const copilot = agent("copilot");
  assert.ok(copilot.includes("--allow-all-tools"));
  assert.ok(!copilot.some((arg) => arg.startsWith("--available-tools")));

  const claude = agent("claude-cli");
  assert.ok(claude.includes("--dangerously-skip-permissions"));
  assert.ok(!claude.includes("--tools"));
  assert.ok(claude.includes("--no-session-persistence"));

  const agy = agent("agy");
  assert.ok(agy.includes("--dangerously-skip-permissions"));
  assert.ok(!agy.includes("--settings"));
  assert.equal(agy.at(-1), "hi");

  // Codex uses its own config and rules, as by hand, but still spends credits at standard speed.
  const codex = agent("codex");
  assert.ok(codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  for (const flag of ["--sandbox", "--ignore-user-config", "--ignore-rules"]) {
    assert.ok(!codex.includes(flag), flag);
  }
  assert.ok(!codex.some((arg) => arg.startsWith("features.") || arg.startsWith("web_search")));
  assert.ok(codex.includes("service_tier=default"));
  assert.ok(codex.includes("--ephemeral"));
  assert.equal(codex.at(-1), "-");
});

test("CLI invocations pass effort in each CLI's own flag", () => {
  const flagValue = (args: string[], flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const effortOf = (adapter: Backend["adapter"], effort?: Effort) =>
    buildInvocation(makeBackend({ id: "c", adapter }), "hi", effort).args;

  assert.equal(flagValue(effortOf("copilot", "xhigh"), "--reasoning-effort"), "xhigh");
  assert.equal(flagValue(effortOf("claude-cli", "max"), "--effort"), "max");
  assert.equal(flagValue(effortOf("agy", "low"), "--effort"), "low");
  assert.ok(effortOf("codex", "max").includes("model_reasoning_effort=max"));
  for (const adapter of ["copilot", "claude-cli", "agy", "codex"] as const) {
    const args = effortOf(adapter);
    assert.ok(!args.includes("--effort") && !args.includes("--reasoning-effort"), adapter);
    assert.ok(!args.some((arg) => arg.startsWith("model_reasoning_effort")), adapter);
  }

  const agy = makeBackend({
    id: "a",
    adapter: "agy",
    model: "gemini-3.8-flash-{effort}",
    efforts: ["low", "medium", "high"],
  });
  const args = buildInvocation(agy, "hi", "medium").args;
  assert.equal(flagValue(args, "--model"), "gemini-3.8-flash-medium");
  assert.ok(!args.includes("--effort"));
});

test("multi-turn history is flattened for CLIs", () => {
  const text = flatten([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  assert.match(text, /User:\none\n\nAssistant:\ntwo\n\nUser:\nthree/);
});

test("CLI failures are classified", () => {
  assert.equal(classifyFailure("You've hit your limit", "x", 1).kind, "rate_limit");
  assert.equal(classifyFailure("Not logged in", "x", 1).kind, "auth");
  assert.equal(classifyFailure("segfault", "x", 1).kind, "unavailable");
});

test("Codex limit, credit and sign-in errors are classified", () => {
  const kind = (stderr: string) => classifyFailure(stderr, "codex", 1).kind;
  assert.equal(kind("ERROR: You’ve hit your usage limit. Try again at 3:04 PM."), "rate_limit");
  assert.equal(
    kind("ERROR: Your workspace is out of credits. Add credits to continue."),
    "rate_limit",
  );
  assert.equal(
    kind(
      "ERROR: You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    ),
    "rate_limit",
  );
  assert.equal(
    kind(
      "ERROR: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
    ),
    "auth",
  );
});

test("Antigravity's quota error is a rate limit that lasts until the reset it reports", () => {
  const stderr =
    "error: Individual quota reached. Please upgrade your subscription to increase your limits. " +
    'Resets in 4h48m33s. AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached."}';
  const error = classifyFailure(stderr, "agy", 3);
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.retryAfterMs, (4 * 3600 + 48 * 60 + 33) * 1000);
  assert.equal(classifyFailure("RESOURCE_EXHAUSTED", "agy", 3).kind, "rate_limit");
  assert.equal(classifyFailure("Quota reached. Resets in 45s.", "agy", 3).retryAfterMs, 45_000);
  assert.equal(classifyFailure("Quota reached. Resets in 2m.", "agy", 3).retryAfterMs, 120_000);
});

test("a monthly quota error pauses until the next month", () => {
  const now = Date.UTC(2026, 10, 23, 12);
  const error = classifyFailure("You have exceeded your monthly quota", "copilot", 1, now);
  assert.equal(error.kind, "rate_limit");
  assert.equal(now + (error.retryAfterMs ?? 0), Date.UTC(2026, 11, 1));
});

test("CLI adapter streams stdout", async () => {
  const adapter = createCliAdapter(fakeCli("process.stdout.write('hello from cli')"));
  const events = await drain(adapter, makeBackend({ id: "c", adapter: "copilot" }));
  assert.equal(textOf(events), "hello from cli");
});

test("CLI adapter answers a long agy chat from agy's JSON output", async () => {
  // Reads the stream-json message on stdin and answers with the prompt's length, as agy would.
  const script = `
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const { event, message } = JSON.parse(input);
      const answer = event + " " + message.content.length;
      const step = { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: answer };
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: step }) + "\\n");
      const result = { status: "SUCCESS", response: answer };
      process.stdout.write(JSON.stringify({ event: "result", result }) + "\\n");
    });`;
  const content = "y".repeat(40_000);
  const events = await drain(
    createCliAdapter(fakeCli(script)),
    makeBackend({ id: "c", adapter: "agy" }),
    input({ messages: [{ role: "user", content }] }),
  );
  assert.equal(textOf(events), "user 40000");
  assert.ok(events.every((event) => event.type === "text"));
});

test("CLI adapter treats a limit message on exit 0 as a rate limit", async () => {
  const adapter = createCliAdapter(fakeCli("process.stdout.write('Usage limit reached')"));
  await assert.rejects(
    drain(adapter, makeBackend({ id: "c", adapter: "claude-cli" })),
    (error: BackendError) => error.kind === "rate_limit",
  );
});

test("CLI adapter reports a non-zero exit", async () => {
  const adapter = createCliAdapter(
    fakeCli("process.stderr.write('Not logged in'); process.exit(1)"),
  );
  await assert.rejects(
    drain(adapter, makeBackend({ id: "c", adapter: "copilot" })),
    (error: BackendError) => error.kind === "auth",
  );
});

test("CLI adapter stops on timeout", async () => {
  const adapter = createCliAdapter(fakeCli("setInterval(() => {}, 1000)"), 150);
  await assert.rejects(
    drain(adapter, makeBackend({ id: "c", adapter: "copilot" })),
    (error: BackendError) => error.kind === "timeout",
  );
});

test("CLI adapter runs chats in the empty sandbox and agents in their folder", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-folder-"));
  try {
    const adapter = createCliAdapter(fakeCli("process.stdout.write(process.cwd())"));
    const backend = makeBackend({ id: "c", adapter: "claude-cli" });
    const chat = textOf(await drain(adapter, backend));
    assert.equal(path.basename(chat), "model-backends-sandbox");
    const agent = textOf(await drain(adapter, backend, input({ folder })));
    assert.equal(realpathSync(agent), realpathSync(folder));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("agent runs get their own, longer timeout", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-folder-"));
  try {
    const slow = "setTimeout(() => process.stdout.write('done'), 400)";
    const adapter = createCliAdapter(fakeCli(slow), 150, 10_000);
    const backend = makeBackend({ id: "c", adapter: "copilot" });
    await assert.rejects(
      drain(adapter, backend),
      (error: BackendError) => error.kind === "timeout",
    );
    assert.equal(textOf(await drain(adapter, backend, input({ folder }))), "done");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("HTTP statuses map to failure kinds", () => {
  assert.equal(errorFromStatus(401, "").kind, "auth");
  assert.equal(errorFromStatus(402, "").kind, "rate_limit");
  assert.equal(errorFromStatus(429, "", "30").retryAfterMs, 30_000);
  assert.equal(errorFromStatus(404, "").kind, "unavailable");
  assert.equal(errorFromStatus(503, "").kind, "unavailable");
  assert.equal(errorFromStatus(400, "").kind, "bad_request");
  assert.equal(parseRetryAfter("nonsense"), undefined);
});

test("SSE parser handles events split across chunks", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: one\n"));
      controller.enqueue(encoder.encode("\ndata: t"));
      controller.enqueue(encoder.encode("wo\r\n\r\n"));
      controller.close();
    },
  });
  const seen: string[] = [];
  for await (const payload of readSse(body)) seen.push(payload);
  assert.deepEqual(seen, ["one", "two"]);
});

test("OpenAI-compatible adapter streams text and usage", async () => {
  process.env.TEST_KEY = "key";
  let sent: { url: string; auth: string | null; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = {
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return sseResponse([
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "[DONE]",
    ]);
  }) as typeof fetch;

  const backend = makeBackend({
    id: "d",
    model: "deepseek-flash",
    baseUrl: "https://example.test",
    apiKeyEnv: "TEST_KEY",
  });
  const events = await drain(openaiAdapter, backend);
  assert.equal(textOf(events), "Hello");
  assert.deepEqual(events.at(-1), { type: "usage", inputTokens: 3, outputTokens: 2 });
  assert.equal(sent?.url, "https://example.test/chat/completions");
  assert.equal(sent?.auth, "Bearer key");
  assert.equal(sent?.body.model, "deepseek-flash");
});

/** Stands in for an HTTP API and records each request body. */
function recordBodies(reply: () => Response): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return reply();
  }) as typeof fetch;
  return bodies;
}

test("OpenAI-compatible adapter sends reasoning_effort only when there is one", async () => {
  process.env.TEST_KEY = "key";
  const bodies = recordBodies(() => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}']));
  const backend = makeBackend({ id: "d", baseUrl: "https://example.test", apiKeyEnv: "TEST_KEY" });
  await drain(openaiAdapter, backend, input({ effort: "max" }));
  await drain(openaiAdapter, backend);
  assert.equal(bodies[0]?.reasoning_effort, "max");
  assert.equal("reasoning_effort" in (bodies[1] ?? {}), false);
});

test("Gemini adapter sends the effort as a thinking level", async () => {
  process.env.TEST_KEY = "key";
  const bodies = recordBodies(() =>
    sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })]),
  );
  const backend = makeBackend({ id: "g", adapter: "gemini", apiKeyEnv: "TEST_KEY" });
  await drain(geminiAdapter, backend, input({ effort: "minimal" }));
  await drain(geminiAdapter, backend);
  const config = (index: number) => bodies[index]?.generationConfig as Record<string, unknown>;
  assert.deepEqual(config(0).thinkingConfig, { thinkingLevel: "minimal" });
  assert.equal(config(1).thinkingConfig, undefined);
});

test("OpenAI-compatible adapter adds extraBody without overriding core fields", async () => {
  process.env.TEST_KEY = "key";
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(["[DONE]"]);
  }) as typeof fetch;

  const backend = makeBackend({
    id: "r",
    model: "real-model",
    baseUrl: "https://example.test",
    apiKeyEnv: "TEST_KEY",
    extraBody: { reasoning: { enabled: false }, model: "sneaky", stream: false },
  });
  await drain(openaiAdapter, backend);
  assert.deepEqual(body?.reasoning, { enabled: false });
  assert.equal(body?.model, "real-model");
  assert.equal(body?.stream, true);
});

test("OpenAI-compatible adapter maps an auth failure", async () => {
  process.env.TEST_KEY = "bad";
  globalThis.fetch = (async () =>
    new Response('{"error":"invalid key"}', { status: 401 })) as unknown as typeof fetch;
  const backend = makeBackend({ id: "d", baseUrl: "https://example.test", apiKeyEnv: "TEST_KEY" });
  await assert.rejects(
    drain(openaiAdapter, backend),
    (error: BackendError) => error.kind === "auth",
  );
});

test("Gemini adapter sends attachments and returns images", async () => {
  process.env.TEST_KEY = "key";
  let body: { contents: { parts: Record<string, unknown>[] }[] } | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as typeof body;
    return sseResponse([
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking", thought: true },
                { text: "Here" },
                { inlineData: { mimeType: "image/png", data: "AAAA" } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5 },
      }),
    ]);
  }) as typeof fetch;

  const backend = makeBackend({ id: "g", adapter: "gemini", apiKeyEnv: "TEST_KEY" });
  const events = await drain(
    geminiAdapter,
    backend,
    input({ attachments: [{ name: "a.png", mime: "image/png", data: "BBBB" }] }),
  );
  assert.equal(textOf(events), "Here");
  assert.ok(events.some((event) => event.type === "image" && event.data === "AAAA"));
  assert.deepEqual(events.at(-1), { type: "usage", inputTokens: 4, outputTokens: 5 });
  assert.deepEqual(body?.contents[0]?.parts[0], {
    inlineData: { mimeType: "image/png", data: "BBBB" },
  });
});

test("Gemini safety blocks are refusals", async () => {
  process.env.TEST_KEY = "key";
  globalThis.fetch = (async () =>
    sseResponse([
      JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
    ])) as unknown as typeof fetch;
  const backend = makeBackend({ id: "g", adapter: "gemini", apiKeyEnv: "TEST_KEY" });
  await assert.rejects(
    drain(geminiAdapter, backend),
    (error: BackendError) => error.kind === "refused",
  );
});

const CLAUDE_STREAM = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

/** Stands in for the Claude API and records the headers and body of each request. */
function fakeClaudeApi(status = 200, bodies: Record<string, unknown>[] = []): Headers[] {
  const seen: Headers[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(url instanceof Request ? url.headers : new Headers(init?.headers));
    const body = url instanceof Request ? await url.clone().text() : String(init?.body ?? "{}");
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    if (status !== 200) {
      return new Response(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}',
        { status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(CLAUDE_STREAM, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return seen;
}

const claudeBackend = makeBackend({
  id: "claude",
  adapter: "anthropic",
  model: "claude-haiku-5-5",
  apiKeyEnv: "TEST_KEY",
});

test("Claude adapter sends the API key when one is set, even if signed in", async () => {
  process.env.TEST_KEY = "sk-test";
  process.env.ANTHROPIC_CONFIG_DIR = antFolder();
  delete process.env.ANTHROPIC_PROFILE;
  const seen = fakeClaudeApi();

  const events = await drain(anthropicAdapter, claudeBackend);
  assert.equal(textOf(events), "Hi");
  assert.deepEqual(events.at(-1), { type: "usage", inputTokens: 3, outputTokens: 2 });
  // SDK 1.x sends API keys as a bearer token; only the sign-in adds the OAuth beta.
  assert.equal(seen[0]?.get("authorization"), "Bearer sk-test");
  assert.doesNotMatch(seen[0]?.get("anthropic-beta") ?? "", /oauth/);
});

test("Claude adapter thinks at the chosen effort, and at the model default without one", async () => {
  process.env.TEST_KEY = "sk-test";
  const bodies: Record<string, unknown>[] = [];
  fakeClaudeApi(200, bodies);

  await drain(anthropicAdapter, claudeBackend, input({ effort: "xhigh" }));
  await drain(anthropicAdapter, claudeBackend);
  assert.deepEqual(bodies[0]?.output_config, { effort: "xhigh" });
  assert.deepEqual(bodies[0]?.thinking, { type: "adaptive" });
  // Models without effort levels, such as Haiku 4.5, take neither setting.
  assert.equal(bodies[1]?.output_config, undefined);
  assert.equal(bodies[1]?.thinking, undefined);
});

test("Claude adapter uses the ant sign-in when no key is set", async () => {
  process.env.ANTHROPIC_CONFIG_DIR = antFolder(["default"], { token: "signed-in" });
  delete process.env.ANTHROPIC_PROFILE;
  const seen = fakeClaudeApi();

  const events = await drain(anthropicAdapter, claudeBackend);
  assert.equal(textOf(events), "Hi");
  assert.equal(seen[0]?.get("authorization"), "Bearer signed-in");
  assert.match(seen[0]?.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
});

test("Claude adapter asks for a fresh ant login when the sign-in is rejected", async () => {
  process.env.ANTHROPIC_CONFIG_DIR = antFolder();
  delete process.env.ANTHROPIC_PROFILE;
  fakeClaudeApi(401);

  await assert.rejects(
    drain(anthropicAdapter, claudeBackend),
    (error: BackendError) => error.kind === "auth" && /ant auth login/.test(error.message),
  );
});

test("Claude adapter refuses to run with no key and no sign-in", async () => {
  process.env.ANTHROPIC_CONFIG_DIR = antFolder([]);
  delete process.env.ANTHROPIC_PROFILE;
  const seen = fakeClaudeApi();

  await assert.rejects(
    drain(anthropicAdapter, claudeBackend),
    (error: BackendError) =>
      error.kind === "auth" && error.message === 'Set TEST_KEY or run "ant auth login"',
  );
  assert.equal(seen.length, 0);
});

test("custom instructions go to OpenAI-compatible APIs as a system message", async () => {
  process.env.TEST_KEY = "key";
  const bodies = recordBodies(() => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}']));
  const backend = makeBackend({ id: "d", baseUrl: "https://example.test", apiKeyEnv: "TEST_KEY" });
  await drain(openaiAdapter, backend, input({ instructions: "Answer in French." }));
  await drain(openaiAdapter, backend);
  assert.deepEqual((bodies[0]?.messages as unknown[])[0], {
    role: "system",
    content: "Answer in French.",
  });
  assert.equal((bodies[0]?.messages as unknown[]).length, 2);
  assert.deepEqual(bodies[1]?.messages, [{ role: "user", content: "hello" }]);
});

test("custom instructions go to Gemini as its system instruction", async () => {
  process.env.TEST_KEY = "key";
  const bodies = recordBodies(() =>
    sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })]),
  );
  const backend = makeBackend({ id: "g", adapter: "gemini", apiKeyEnv: "TEST_KEY" });
  await drain(geminiAdapter, backend, input({ instructions: "Answer in French." }));
  await drain(geminiAdapter, backend);
  assert.deepEqual(bodies[0]?.systemInstruction, { parts: [{ text: "Answer in French." }] });
  assert.equal(bodies[1]?.systemInstruction, undefined);
});

test("custom instructions go to Claude as the system prompt", async () => {
  process.env.TEST_KEY = "sk-test";
  const bodies: Record<string, unknown>[] = [];
  fakeClaudeApi(200, bodies);
  await drain(anthropicAdapter, claudeBackend, input({ instructions: "Answer in French." }));
  await drain(anthropicAdapter, claudeBackend);
  assert.equal(bodies[0]?.system, "Answer in French.");
  assert.equal(bodies[1]?.system, undefined);
});

test("custom instructions lead the prompt a CLI reads", () => {
  const text = flatten([{ role: "user", content: "hello" }], "Answer in French.");
  assert.equal(text, "Follow these instructions from the user:\nAnswer in French.\n\nhello");
  assert.equal(flatten([{ role: "user", content: "hello" }], "  "), "hello");
});
