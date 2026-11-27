import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentStream, describeTool, unwrapShell } from "../src/adapters/agent-stream.ts";
import { buildInvocation, createCliAdapter } from "../src/adapters/cli.ts";
import type { SpawnFn } from "../src/adapters/cli.ts";
import { BackendError } from "../src/types.ts";
import type { AdapterName, OutputEvent, StepEvent } from "../src/types.ts";
import { makeBackend } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "agent-stream");
const FOLDER = path.join(os.tmpdir(), "agent-repo");

/** A recorded sample, with __FOLDER__ swapped for a real path on this OS. */
function sample(name: string, folder = FOLDER): string {
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  return readFileSync(path.join(FIXTURES, name), "utf8")
    .replaceAll("__FOLDER__/", escape(folder + path.sep))
    .replaceAll("__FOLDER__", escape(folder));
}

/** Feeds a sample in uneven chunks, as a pipe would, so lines arrive split. */
function parse(adapter: AdapterName, text: string, folder = FOLDER) {
  const stream = new AgentStream(adapter, folder);
  const steps: StepEvent[] = [];
  for (let at = 0; at < text.length; at += 97) steps.push(...stream.push(text.slice(at, at + 97)));
  const outcome = stream.finish();
  return { ...outcome, steps: [...steps, ...outcome.steps] };
}

const summaries = (steps: StepEvent[]) => steps.map((step) => step.summary);

test("Claude Code's stream-json shows each tool call and ends with its result", () => {
  const { steps, text, fatal } = parse("claude-cli", sample("claude.jsonl"));
  assert.deepEqual(summaries(steps), ["Wrote hello.txt", "Ran `git status --short`"]);
  assert.deepEqual(
    steps.map((step) => step.tool),
    ["Write", "Bash"],
  );
  assert.equal(
    text,
    "`git status --short` printed `?? hello.txt`, showing the new file is untracked.",
  );
  assert.equal(fatal, false);
});

test("Antigravity's stream-json shows each tool once and joins the streamed answer", () => {
  const { steps, text } = parse("agy", sample("agy.jsonl"));
  assert.deepEqual(summaries(steps), ["Wrote hello.txt", "Ran `git status --short`"]);
  assert.equal(
    text,
    "The command printed `?? hello.txt`, indicating that `hello.txt` is an untracked file.\n",
  );
});

test("Codex's JSON events show what it said and ran, unwrapping the shell", () => {
  const { steps, text } = parse("codex", sample("codex.jsonl"));
  assert.deepEqual(summaries(steps), [
    "I’ll create `hello.txt`, then run the requested Git status command.",
    "Ran `Set-Content -LiteralPath hello.txt -Value hi -NoNewline; git status --short`",
  ]);
  assert.equal(steps[0]?.tool, "message");
  assert.equal(text, "`git status --short` printed `?? hello.txt`.");
});

test("Copilot's JSON events show narration, patches and commands", () => {
  const { steps, text } = parse("copilot", sample("copilot.jsonl"));
  assert.deepEqual(summaries(steps), [
    "I'll create hello.txt, then check git status.",
    "Created hello.txt",
    "Ran `git status --short`",
  ]);
  assert.equal(text, "`git status --short` printed `?? hello.txt`.");
});

test("Copilot's quota error is kept for classifying the failure", () => {
  const { text, errors, fatal } = parse("copilot", sample("copilot-quota.jsonl"));
  assert.equal(text, "");
  assert.equal(fatal, false);
  assert.match(errors[0] ?? "", /exceeded your monthly quota/);
});

test("a message is narration if the agent goes on, and the answer if it is last", () => {
  const stream = new AgentStream("codex", FOLDER);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const message = (text: string) =>
    line({ type: "item.completed", item: { type: "agent_message", text } });
  assert.deepEqual(stream.push(message("Looking around first.")), []);
  assert.deepEqual(summaries(stream.push(message("Now the fix."))), ["Looking around first."]);
  assert.deepEqual(stream.push(message("Done: fixed it.")).length, 1);
  assert.equal(stream.finish().text, "Done: fixed it.");
});

test("a failed result is fatal and gives no answer, even after narration", () => {
  const stream = new AgentStream("claude-cli", FOLDER);
  stream.push(
    [
      { type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "API Error: 529",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  const outcome = stream.finish();
  assert.equal(outcome.fatal, true);
  assert.equal(outcome.text, "");
  assert.match(outcome.errors[0] ?? "", /API Error: 529/);
});

test("output that is not JSON still comes through as the answer", () => {
  const stream = new AgentStream("copilot", FOLDER);
  stream.push("plain answer from an older CLI\n");
  assert.equal(stream.finish().text, "plain answer from an older CLI");
});

test("tool calls get short summaries, with paths relative to the folder", () => {
  const inside = path.join(FOLDER, "src", "login.ts");
  const outside = path.join(os.tmpdir(), "elsewhere", "notes.md");
  assert.equal(
    describeTool("Edit", { file_path: inside }, FOLDER),
    `Edited ${path.join("src", "login.ts")}`,
  );
  assert.equal(describeTool("Read", { file_path: outside }, FOLDER), `Read ${outside}`);
  assert.equal(describeTool("Grep", { pattern: "TODO" }), "Searched for `TODO`");
  assert.equal(
    describeTool("WebFetch", { url: "https://example.com" }),
    "Fetched https://example.com",
  );
  assert.equal(describeTool("TodoWrite", { todos: [] }), "Updated its plan");
  assert.equal(
    describeTool("Task", { description: "Find the bug" }),
    "Started a subagent: Find the bug",
  );
  assert.equal(describeTool("mcp__github__create_pr", {}), "Used github create_pr");
  assert.equal(describeTool("browser_click_element", {}), "Used browser_click_element");
  assert.equal(
    describeTool("Bash", { command: "npm test\nnpm run lint" }),
    "Ran `npm test npm run lint`",
  );
  assert.ok(describeTool("Bash", { command: "x".repeat(500) }).length <= 160);
});

test("shell wrappers are taken off commands", () => {
  assert.equal(unwrapShell("/bin/bash -lc 'npm test'"), "npm test");
  assert.equal(unwrapShell(`"C:\\pwsh.exe" -Command 'git status'`), "git status");
  assert.equal(unwrapShell("npm test"), "npm test");
  assert.equal(unwrapShell("node -c 'x'"), "node -c 'x'");
  // A here-string and a tail after the quote still lose the wrapper.
  const pwsh = `"C:\\\\WINDOWS\\\\powershell.exe" -Command "@'\nhi\n'@ | Set-Content a.txt" 2>&1`;
  assert.equal(unwrapShell(pwsh), `@'\nhi\n'@ | Set-Content a.txt" 2>&1`);
});

test("agent invocations ask each CLI for its JSON stream; chats stay plain text", () => {
  const args = (adapter: AdapterName, agent: boolean) =>
    buildInvocation(makeBackend({ id: "c", adapter }), "hi", undefined, agent).args.join(" ");
  assert.match(args("claude-cli", true), /--output-format stream-json --verbose/);
  assert.match(args("claude-cli", false), /--output-format text/);
  assert.match(args("agy", true), /--output-format stream-json/);
  assert.doesNotMatch(args("agy", false), /--output-format/);
  assert.match(args("codex", true), /--json/);
  assert.doesNotMatch(args("codex", false), /--json/);
  assert.match(args("copilot", true), /--output-format json/);
  assert.doesNotMatch(args("copilot", true), /(^| )-s( |$)/);
  assert.match(args("copilot", false), /^-s /);
});

/** Runs a Node script that prints a sample slowly, in place of the real CLI. */
function printsSample(text: string, exitCode = 0): SpawnFn {
  const script = `
    const lines = ${JSON.stringify(text.trim().split("\n"))};
    let i = 0;
    const next = () => {
      if (i === lines.length) process.exit(${exitCode});
      process.stdout.write(lines[i++] + "\\n", () => setTimeout(next, 5));
    };
    next();`;
  return ((_command, _args, options) =>
    spawn(process.execPath, ["-e", script], options)) as SpawnFn;
}

async function drainAgent(spawnFn: SpawnFn, adapter: AdapterName, folder: string) {
  const events: OutputEvent[] = [];
  const run = createCliAdapter(spawnFn)(makeBackend({ id: "c", adapter }), {
    messages: [{ role: "user", content: "hello" }],
    attachments: [],
    signal: new AbortController().signal,
    folder,
  });
  for await (const event of run) events.push(event);
  return events;
}

test("the CLI adapter streams an agent's steps before its answer", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-agent-"));
  try {
    const events = await drainAgent(
      printsSample(sample("claude.jsonl", folder)),
      "claude-cli",
      folder,
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["step", "step", "text"],
    );
    const last = events.at(-1);
    assert.match(last?.type === "text" ? last.text : "", /printed `\?\? hello\.txt`/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Claude Code agents run commands in the foreground, since -p exits before background ones finish", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-agent-"));
  try {
    const envs: Record<string, string | undefined>[] = [];
    const recording =
      (inner: SpawnFn): SpawnFn =>
      (command, args, options) => {
        envs.push({ ...options.env });
        return inner(command, args, options);
      };
    await drainAgent(recording(printsSample(sample("claude.jsonl", folder))), "claude-cli", folder);
    const [claude] = envs;
    assert.equal(claude?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    // A full test suite gets an hour in the foreground, inside the agent's own two hours.
    assert.equal(claude?.BASH_DEFAULT_TIMEOUT_MS, String(60 * 60_000));
    assert.equal(claude?.BASH_MAX_TIMEOUT_MS, String(60 * 60_000));
    assert.equal(claude?.NO_COLOR, "1");

    // Chats have no tools to background, and other CLIs don't read these settings.
    const chat = buildInvocation(makeBackend({ id: "c", adapter: "claude-cli" }), "hi");
    assert.equal(chat.env, undefined);
    for (const adapter of ["agy", "codex", "copilot"] as const) {
      const agent = buildInvocation(makeBackend({ id: "c", adapter }), "hi", undefined, true);
      assert.equal(agent.env, undefined, adapter);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an agent out of monthly quota is a rate limit until next month", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-agent-"));
  try {
    await assert.rejects(
      drainAgent(printsSample(sample("copilot-quota.jsonl", folder), 1), "copilot", folder),
      (error: BackendError) =>
        error.kind === "rate_limit" &&
        (error.retryAfterMs ?? 0) > 0 &&
        /monthly quota/.test(error.message),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a fatal result on exit 0 still fails the run", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-agent-"));
  const result = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "You've hit your limit",
  });
  try {
    await assert.rejects(
      drainAgent(printsSample(result), "claude-cli", folder),
      (error: BackendError) => error.kind === "rate_limit",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
