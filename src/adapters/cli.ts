import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { applyEffort } from "../effort.ts";
import { withoutSecrets } from "../secret-env.ts";
import { AgentStream } from "./agent-stream.ts";
import { BackendError } from "../types.ts";
import type { Adapter, Backend, ChatMessage, Effort } from "../types.ts";

/**
 * The longest prompt passed as an argument. Windows caps a whole command line at 32,767
 * characters and Linux one argument at 128 KiB, so this fits both with room for the flags.
 */
const ARG_PROMPT_LIMIT = 30_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Working in a folder can mean implementing a feature end to end, so it gets far longer. */
const AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
/**
 * An agent run is one `claude -p` turn: a command left running in the background is never
 * reported back, because the CLI exits when the turn ends. So Claude Code runs every command in
 * the foreground, and a long one, such as a full test suite, gets up to an hour to finish.
 */
const CLAUDE_COMMAND_TIMEOUT_MS = String(60 * 60_000);
const CLAUDE_AGENT_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  BASH_DEFAULT_TIMEOUT_MS: CLAUDE_COMMAND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS: CLAUDE_COMMAND_TIMEOUT_MS,
};
/** Held back so a short "limit reached" reply on exit 0 is not shown as an answer. */
const HOLD_BACK_CHARS = 400;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/** Antigravity says "Individual quota reached … RESOURCE_EXHAUSTED (code 429)". */
const RATE_LIMIT =
  /usage limit|rate limit|limit reached|hit your limit|quota (?:exceeded|exhausted|reached)|resource_exhausted|exceeded your [\w -]{0,30}(?:quota|limit)|too many requests|out of (?:credits|premium requests)|spend cap/i;
const MONTHLY_LIMIT = /monthly (?:quota|limit)/i;
/** A Go-style duration, as in Antigravity's "Resets in 4h48m33s". */
const RESETS_IN = /resets in (?=\d)(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/i;
const AUTH =
  /not logged in|please log ?in|sign in again|run .*login|unauthori[sz]ed|authentication (?:failed|required)|invalid api key/i;

/** agy has no flag to disable tools and auto-approves edits in -p runs, so deny them per session. */
const AGY_DENY_ALL_TOOLS = JSON.stringify({
  permissions: {
    deny: ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "mcp(*)", "mcp(*/*)"],
  },
});
/**
 * Codex has no single switch for tools, so every default-on feature that gives the model a tool
 * is turned off. Set with -c rather than --disable, which fails on a name a later release drops.
 */
const CODEX_TOOL_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "sleep_tool",
  "code_mode_host",
  "multi_agent",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "tool_suggest",
  "skill_search",
  "hooks",
];
const CODEX_TOOLS_OFF = [
  ...CODEX_TOOL_FEATURES.map((feature) => `features.${feature}=false`),
  "web_search=disabled",
];

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** A CLI's environment: no secrets (Copilot keeps its GitHub token), then the backend's own. */
export function childEnv(
  backend: Backend,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    NO_COLOR: "1",
    ...withoutSecrets(base, { keepGithubTokens: backend.adapter === "copilot" }),
  };
  for (const [key, value] of Object.entries(backend.env)) {
    if (value) env[key] = value;
  }
  return env;
}

/** The prompt a CLI reads on stdin. CLIs take no system prompt, so instructions lead it. */
export function flatten(messages: ChatMessage[], instructions?: string): string {
  const preamble = instructions?.trim()
    ? `Follow these instructions from the user:\n${instructions.trim()}\n\n`
    : "";
  if (messages.length === 1) return preamble + (messages[0]?.content ?? "");
  const turns = messages.map(
    (message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`,
  );
  return `${preamble}Continue this conversation. Reply only as the assistant.\n\n${turns.join("\n\n")}`;
}

/**
 * A chat invocation disables tools, so a routed prompt can only produce text. An agent
 * invocation runs in a folder the user picked, with tools on and approvals skipped, since no
 * one is there to approve them; it uses the CLI's own setup, as running it there by hand would.
 * Agents print JSON lines, so each step can be shown as it happens (see agent-stream.ts);
 * `json` says the CLI will print them. `env` is added to the CLI's environment.
 */
export function buildInvocation(
  backend: Backend,
  prompt: string,
  requestedEffort?: Effort,
  agent = false,
): { args: string[]; stdin?: string; json: boolean; env?: Record<string, string> } {
  const { model, effort } = applyEffort(backend, requestedEffort);
  const effortArgs = (flag: string) => (effort ? [flag, effort] : []);
  switch (backend.adapter) {
    case "copilot":
      return {
        args: [
          ...(agent ? ["--output-format", "json"] : ["-s"]),
          "--no-auto-update",
          ...(agent
            ? ["--allow-all-tools"]
            : ["--no-custom-instructions", "--disable-builtin-mcps", "--available-tools="]),
          "--model",
          model,
          ...effortArgs("--reasoning-effort"),
        ],
        stdin: prompt,
        json: agent,
      };
    case "claude-cli":
      return {
        args: [
          "-p",
          "--model",
          model,
          ...effortArgs("--effort"),
          ...(agent
            ? ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]
            : [
                "--output-format",
                "text",
                "--tools",
                "",
                "--strict-mcp-config",
                "--disable-slash-commands",
              ]),
          // Keeps these runs out of the user's own Claude Code session list.
          "--no-session-persistence",
        ],
        stdin: prompt,
        json: agent,
        ...(agent ? { env: CLAUDE_AGENT_ENV } : {}),
      };
    case "codex":
      // -c values that aren't valid TOML are read as plain strings, so no quotes are needed.
      return {
        args: [
          "exec",
          "--model",
          model,
          ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
          ...(agent
            ? ["--json", "--dangerously-bypass-approvals-and-sandbox"]
            : [
                ...CODEX_TOOLS_OFF.flatMap((setting) => ["-c", setting]),
                "--sandbox",
                "read-only",
                "--ignore-user-config",
                "--ignore-rules",
              ]),
          // Standard speed: some models default to Fast, which spends credits twice as fast.
          "-c",
          "service_tier=default",
          "--skip-git-repo-check",
          // Keeps these runs out of the user's own Codex session list.
          "--ephemeral",
          "--color",
          "never",
          "-",
        ],
        stdin: prompt,
        json: agent,
      };
    case "agy": {
      // agy takes its prompt as an argument, which streams a chat's text as it comes. A longer
      // prompt, such as a long conversation, goes on stdin as a stream-json message instead,
      // which agy accepts only with JSON output, so that chat's answer arrives whole.
      const onStdin = prompt.length > ARG_PROMPT_LIMIT;
      const json = agent || onStdin;
      return {
        args: [
          "--model",
          model,
          ...effortArgs("--effort"),
          ...(json ? ["--output-format", "stream-json"] : []),
          ...(agent
            ? ["--dangerously-skip-permissions"]
            : ["--disable-slash-commands", "--settings", AGY_DENY_ALL_TOOLS]),
          ...(onStdin ? ["--input-format", "stream-json", "-p", ""] : ["-p", prompt]),
        ],
        ...(onStdin
          ? { stdin: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` }
          : {}),
        json,
      };
    }
    default:
      throw new BackendError("bad_request", `${backend.adapter} is not a CLI adapter`);
  }
}

/** An empty folder, so CLIs pick up no repo files or project instructions. */
function sandboxDir(): string {
  const folder = path.join(os.tmpdir(), "model-backends-sandbox");
  mkdirSync(folder, { recursive: true });
  return folder;
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

function msUntilNextMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now;
}

/** How long until a limit resets, when the CLI says, as in "Resets in 4h48m33s". */
function resetsInMs(output: string): number | undefined {
  const match = RESETS_IN.exec(output);
  if (!match) return undefined;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  const ms = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return ms > 0 ? Math.round(ms) : undefined;
}

export function classifyFailure(
  output: string,
  command: string,
  code: number | null,
  now: number = Date.now(),
) {
  const detail = output.replace(ANSI, "").trim().replace(/\s+/g, " ").slice(0, 300);
  const message = `${command} exited with ${code}: ${detail || "no output"}`;
  if (RATE_LIMIT.test(output)) {
    return new BackendError(
      "rate_limit",
      message,
      resetsInMs(output) ?? (MONTHLY_LIMIT.test(output) ? msUntilNextMonth(now) : undefined),
    );
  }
  if (AUTH.test(output)) return new BackendError("auth", message);
  return new BackendError("unavailable", message);
}

export function createCliAdapter(
  spawn: SpawnFn = crossSpawn as unknown as SpawnFn,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  agentTimeoutMs: number = AGENT_TIMEOUT_MS,
): Adapter {
  return async function* (backend, input) {
    if (input.attachments.length) {
      throw new BackendError("unavailable", `${backend.label} cannot read attachments`);
    }
    const agent = Boolean(input.folder);
    const { args, stdin, json, env } = buildInvocation(
      backend,
      flatten(input.messages, input.instructions),
      input.effort,
      agent,
    );
    const command = backend.command ?? backend.adapter;
    const child = spawn(command, args, {
      cwd: input.folder || sandboxDir(),
      env: { ...childEnv(backend), ...env },
      windowsHide: true,
    });

    let spawnError: Error | undefined;
    let stderr = "";
    let timedOut = false;
    const closed = new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        spawnError = error;
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    child.stdin.on("error", () => {}); // The CLI may exit before reading all of stdin.
    child.stdin.end(stdin ?? "");

    const stop = () => killTree(child);
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      agent ? agentTimeoutMs : timeoutMs,
    );
    timer.unref();
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();

    const stream = json ? new AgentStream(backend.adapter, input.folder) : null;
    let held = "";
    let released = false;
    try {
      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        const clean = chunk.replace(ANSI, "");
        if (stream) {
          yield* stream.push(clean);
          continue;
        }
        if (released) {
          yield { type: "text", text: clean };
          continue;
        }
        held += clean;
        if (held.length > HOLD_BACK_CHARS) {
          released = true;
          yield { type: "text", text: held };
        }
      }
      const code = await closed;

      if (input.signal.aborted) throw new BackendError("cancelled", "Request cancelled");
      if (timedOut) throw new BackendError("timeout", `${command} timed out`);
      if (spawnError) throw new BackendError("unavailable", `Could not start ${command}`);
      if (stream) {
        const outcome = stream.finish();
        yield* outcome.steps;
        const { text } = outcome;
        if (code !== 0 || outcome.fatal || (!text.trim() && outcome.errors.length)) {
          throw classifyFailure(`${outcome.errors.join("\n")}\n${stderr}\n${text}`, command, code);
        }
        if (text.length <= HOLD_BACK_CHARS && RATE_LIMIT.test(text)) {
          throw classifyFailure(text, command, code);
        }
        if (!text.trim()) throw new BackendError("unavailable", `${command} returned no output`);
        yield { type: "text", text };
        return;
      }
      if (code !== 0) throw classifyFailure(`${stderr}\n${held}`, command, code);
      if (!released) {
        if (RATE_LIMIT.test(held)) throw classifyFailure(held, command, code);
        if (!held.trim()) throw new BackendError("unavailable", `${command} returned no output`);
        yield { type: "text", text: held };
      }
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null) stop();
    }
  };
}
