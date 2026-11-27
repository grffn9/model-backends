/**
 * Reads the JSON lines each CLI prints in agent mode and turns them into steps for the session,
 * plus the final answer. Each CLI has its own format; samples are in test/fixtures/agent-stream.
 */
import path from "node:path";
import type { AdapterName, StepEvent as Step } from "../types.ts";

/** What one line of a CLI's output means. */
type Parsed =
  | { type: "tool"; tool: string; summary: string }
  | { type: "message"; text: string }
  | { type: "result"; text: string }
  /** fatal: the CLI says the run failed. Other errors may be retries it recovers from. */
  | { type: "error"; message: string; fatal: boolean };

type LineParser = (event: Record<string, unknown>) => Parsed[];

export interface StreamOutcome {
  /** Steps from a last line that had no newline after it. */
  steps: Step[];
  /** The final answer: the CLI's result, else the agent's last message. */
  text: string;
  errors: string[];
  fatal: boolean;
}

const SUMMARY_LENGTH = 160;
const MESSAGE_LENGTH = 200;
const RAW_LIMIT = 8000;

type Args = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function pick(args: Args, keys: string[]): string {
  for (const key of keys) {
    const value = str(args[key]);
    if (value) return value;
  }
  return "";
}

const PATH_KEYS = [
  "file_path",
  "path",
  "Path",
  "filePath",
  "TargetFile",
  "AbsolutePath",
  "target_file",
  "notebook_path",
];
const COMMAND_KEYS = ["command", "CommandLine", "cmd", "script"];
const PATTERN_KEYS = ["pattern", "Pattern", "query", "Query", "SearchPath"];
const URL_KEYS = ["url", "Url", "URL"];

const COMMAND_TOOLS =
  /^(bash|powershell|shell|run_command|run_in_terminal|exec_command|terminal)$/i;
const WRITE_TOOLS = /^(write|write_file|write_to_file|create|create_file)$/i;
const EDIT_TOOLS =
  /^(edit|multiedit|notebookedit|edit_file|replace_file_content|multi_replace_file_content|str_replace|str_replace_editor|insert)$/i;
const READ_TOOLS = /^(read|view|read_file|view_file|view_file_outline)$/i;
const SEARCH_TOOLS =
  /^(grep|glob|rg|search|find|find_by_name|grep_search|codebase_search|list_dir|ls)$/i;
const FETCH_TOOLS = /^(webfetch|web_fetch|read_url|read_url_content|fetch)$/i;
const WEB_SEARCH_TOOLS = /^(websearch|web_search|search_web)$/i;
const PLAN_TOOLS = /^(todowrite|update_plan|todo|todo_list|manage_todo_list)$/i;
const AGENT_TOOLS = /^(task|agent|subagent|run_subagent)$/i;

/** A path inside the folder is shown relative to it, so steps stay short. */
function shortPath(file: string, folder?: string): string {
  if (!folder || !path.isAbsolute(file)) return file;
  const relative = path.relative(folder, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

const SHELL_WRAPPER =
  /^("[^"]+"|\S+)\s+(?:-NoProfile\s+|-NonInteractive\s+|-NoLogo\s+)*(?:-Command|-lc|-c)\s+([\s\S]+)$/i;
const SHELLS = /(?:^|[\\/])(?:powershell|pwsh|bash|sh|zsh|cmd)(?:\.exe)?$/i;

/**
 * Codex runs commands through a shell, as `powershell.exe -Command "…"` or `bash -lc '…'`. Only
 * the command is shown; a closing quote is dropped when there is one, since the step is a summary.
 */
export function unwrapShell(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  if (!match || !SHELLS.test((match[1] as string).replaceAll('"', ""))) return command;
  const body = (match[2] as string).trim();
  const quote = body[0];
  if (quote !== "'" && quote !== '"') return body;
  return body.length > 1 && body.endsWith(quote) ? body.slice(1, -1) : body.slice(1);
}

/** Copilot's apply_patch takes the patch as text; its file headers name what it changes. */
function patchFiles(patch: string): { verb: string; file: string }[] {
  const verbs: Record<string, string> = { Add: "Created", Update: "Edited", Delete: "Deleted" };
  return [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
    verb: verbs[match[1] as string] as string,
    file: (match[2] as string).trim(),
  }));
}

/** A short line for one tool call, such as "Edited src/login.ts" or "Ran `npm test`". */
export function describeTool(name: string, rawArgs: unknown, folder?: string): string {
  const args: Args = isObject(rawArgs) ? rawArgs : {};
  const file = shortPath(pick(args, PATH_KEYS), folder);
  const command = pick(args, COMMAND_KEYS);
  const pattern = pick(args, PATTERN_KEYS);
  const url = pick(args, URL_KEYS);
  const line = (text: string) => oneLine(text, SUMMARY_LENGTH);

  if (typeof rawArgs === "string" && /apply_patch/i.test(name)) {
    const files = patchFiles(rawArgs);
    if (files.length) {
      return line(files.map(({ verb, file: f }) => `${verb} ${shortPath(f, folder)}`).join(", "));
    }
  }
  if (COMMAND_TOOLS.test(name) && command) return line(`Ran \`${unwrapShell(command)}\``);
  if (WRITE_TOOLS.test(name) && file) return line(`Wrote ${file}`);
  if (EDIT_TOOLS.test(name) && file) return line(`Edited ${file}`);
  if (READ_TOOLS.test(name) && file) return line(`Read ${file}`);
  if (SEARCH_TOOLS.test(name)) {
    if (pattern) return line(`Searched for \`${pattern}\``);
    if (file) return line(`Listed ${file}`);
  }
  if (FETCH_TOOLS.test(name) && url) return line(`Fetched ${url}`);
  if (WEB_SEARCH_TOOLS.test(name) && pattern) return line(`Searched the web for ${pattern}`);
  if (PLAN_TOOLS.test(name)) return "Updated its plan";
  if (AGENT_TOOLS.test(name)) {
    const task = pick(args, ["description", "prompt"]);
    return line(task ? `Started a subagent: ${task}` : "Started a subagent");
  }
  if (/intent/i.test(name) && str(args.intent)) return line(str(args.intent));
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const label = mcp ? `${mcp[1]} ${mcp[2]}` : name;
  const detail = file || (command && `\`${command}\``) || pattern || url;
  return line(detail ? `Used ${label}: ${detail}` : `Used ${label}`);
}

const tool = (name: string, args: unknown, folder?: string): Parsed => ({
  type: "tool",
  tool: name || "tool",
  summary: describeTool(name, args, folder),
});

/** Claude Code: `--output-format stream-json --verbose`. */
function claudeParser(folder?: string): LineParser {
  return (event) => {
    if (event.type === "assistant" && isObject(event.message)) {
      // A subagent's own replies go back to the main agent, not to you.
      const subagent = Boolean(event.parent_tool_use_id);
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      return content.flatMap((block): Parsed[] => {
        if (!isObject(block)) return [];
        if (block.type === "tool_use") return [tool(str(block.name), block.input, folder)];
        if (block.type === "text" && !subagent && str(block.text).trim()) {
          return [{ type: "message", text: str(block.text) }];
        }
        return [];
      });
    }
    if (event.type === "result") {
      if (event.is_error === true || event.subtype !== "success") {
        const status = event.api_error_status ? ` (${String(event.api_error_status)})` : "";
        const message = str(event.result) || str(event.subtype) || "Claude Code reported an error";
        return [{ type: "error", message: `${message}${status}`, fatal: true }];
      }
      return [{ type: "result", text: str(event.result) }];
    }
    return [];
  };
}

/** Antigravity: `--output-format stream-json`. A step streams in as updates to its index. */
function agyParser(folder?: string): LineParser {
  const seen = new Set<number>();
  const text = new Map<number, string>();
  return (event) => {
    if (event.event === "step_update" && isObject(event.step_update)) {
      const update = event.step_update;
      const index = typeof update.step_index === "number" ? update.step_index : -1;
      if (update.step_type === "tool") {
        if (seen.has(index)) return [];
        seen.add(index);
        const info = isObject(update.tool_info) ? update.tool_info : {};
        return [tool(str(update.tool_name) || str(info.name), info.parameters, folder)];
      }
      if (update.step_type === "agent_response") {
        const sofar = (text.get(index) ?? "") + str(update.text_delta);
        text.set(index, sofar);
        if (update.state === "DONE" && sofar.trim()) return [{ type: "message", text: sofar }];
      }
      return [];
    }
    if (event.event === "result" && isObject(event.result)) {
      const result = event.result;
      if (result.status === "SUCCESS") return [{ type: "result", text: str(result.response) }];
      const error = isObject(result.error) ? str(result.error.message) : str(result.error);
      const message = error || str(result.response) || `Antigravity ended: ${str(result.status)}`;
      return [{ type: "error", message, fatal: true }];
    }
    if (event.event === "error") {
      const error = isObject(event.error) ? str(event.error.message) : str(event.error);
      return [{ type: "error", message: error || str(event.message), fatal: false }];
    }
    return [];
  };
}

/** Codex: `exec --json`. Items start and complete; each is shown once. */
function codexParser(folder?: string): LineParser {
  const seen = new Set<string>();
  return (event) => {
    if (
      (event.type === "item.started" || event.type === "item.completed") &&
      isObject(event.item)
    ) {
      const item = event.item;
      if (item.type === "agent_message") {
        return event.type === "item.completed" && str(item.text).trim()
          ? [{ type: "message", text: str(item.text) }]
          : [];
      }
      const id = str(item.id);
      if (id && seen.has(id)) return [];
      if (id) seen.add(id);
      switch (item.type) {
        case "command_execution":
          return [{ ...tool("shell", { command: str(item.command) }), tool: "command_execution" }];
        case "file_change": {
          const verbs: Record<string, string> = { add: "Created", delete: "Deleted" };
          const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
          const summary = changes
            .map(
              (change) =>
                `${verbs[str(change.kind)] ?? "Edited"} ${shortPath(str(change.path), folder)}`,
            )
            .join(", ");
          return [
            {
              type: "tool",
              tool: "file_change",
              summary: oneLine(summary || "Edited files", SUMMARY_LENGTH),
            },
          ];
        }
        case "mcp_tool_call":
          return [
            {
              type: "tool",
              tool: "mcp_tool_call",
              summary: `Used ${str(item.server)} ${str(item.tool)}`.trim(),
            },
          ];
        case "web_search":
          return [tool("web_search", { query: str(item.query) }, folder)];
        case "todo_list":
          return [{ type: "tool", tool: "todo_list", summary: "Updated its plan" }];
        default:
          return [];
      }
    }
    if (event.type === "turn.failed") {
      const error = isObject(event.error) ? str(event.error.message) : "";
      return [{ type: "error", message: error || "Codex turn failed", fatal: true }];
    }
    if (event.type === "error") {
      return [{ type: "error", message: str(event.message), fatal: false }];
    }
    return [];
  };
}

/** Copilot: `--output-format json`, the same events as its session log. */
function copilotParser(folder?: string): LineParser {
  return (event) => {
    const data = isObject(event.data) ? event.data : {};
    if (event.type === "tool.execution_start") {
      return [tool(str(data.toolName), data.arguments, folder)];
    }
    if (event.type === "assistant.message" && str(data.content).trim()) {
      const text = str(data.content);
      return [data.phase === "final_answer" ? { type: "result", text } : { type: "message", text }];
    }
    if (event.type === "session.error") {
      return [
        { type: "error", message: str(data.message) || "Copilot reported an error", fatal: false },
      ];
    }
    return [];
  };
}

const PARSERS: Partial<Record<AdapterName, (folder?: string) => LineParser>> = {
  "claude-cli": claudeParser,
  agy: agyParser,
  codex: codexParser,
  copilot: copilotParser,
};

/**
 * Feeds a CLI's stdout through its parser. What the agent says is held until the next thing
 * happens: followed by a tool call it was narration, shown as a step; left at the end, and with
 * no result from the CLI, it is the answer. Output that is not JSON is kept as plain text, so a
 * CLI that ignores the JSON flag still gets its answer through.
 */
export class AgentStream {
  private readonly parse: LineParser;
  private buffer = "";
  private held: string | null = null;
  private result: string | null = null;
  private parsedAny = false;
  private raw = "";
  private readonly errors: string[] = [];
  private fatal = false;

  constructor(adapter: AdapterName, folder?: string) {
    const make = PARSERS[adapter];
    if (!make) throw new Error(`${adapter} has no agent stream format`);
    this.parse = make(folder);
  }

  /** Steps to show now, from a chunk of stdout. */
  push(chunk: string): Step[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.line(line));
  }

  private line(line: string): Step[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      event = undefined;
    }
    if (!isObject(event)) {
      if (this.raw.length < RAW_LIMIT) this.raw += `${line}\n`;
      return [];
    }
    this.parsedAny = true;
    const steps: Step[] = [];
    for (const parsed of this.parse(event)) {
      switch (parsed.type) {
        case "tool":
          steps.push(...this.flushHeld());
          steps.push({ type: "step", tool: parsed.tool, summary: parsed.summary });
          break;
        case "message":
          steps.push(...this.flushHeld());
          this.held = parsed.text;
          break;
        case "result":
          this.result = parsed.text;
          break;
        case "error":
          if (parsed.message) this.errors.push(parsed.message);
          if (parsed.fatal) this.fatal = true;
          break;
      }
    }
    return steps;
  }

  private flushHeld(): Step[] {
    if (this.held === null) return [];
    const summary = oneLine(this.held, MESSAGE_LENGTH);
    this.held = null;
    return summary ? [{ type: "step", tool: "message", summary }] : [];
  }

  finish(): StreamOutcome {
    const steps = this.buffer ? this.line(this.buffer) : [];
    this.buffer = "";
    const text = this.fatal
      ? ""
      : (this.result ?? this.held ?? (this.parsedAny ? "" : this.raw.trim()));
    return { steps, text, errors: [...this.errors], fatal: this.fatal };
  }
}
