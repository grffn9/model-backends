import type { Adapter, BuiltinAdapter } from "../types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { createCliAdapter } from "./cli.ts";
import { geminiAdapter } from "./gemini.ts";
import { openaiAdapter } from "./openai.ts";

/** Every built-in adapter by name, plus any an app adds or replaces. */
export function defaultAdapters(
  extra: Record<string, Adapter> = {},
): Record<BuiltinAdapter, Adapter> & Record<string, Adapter> {
  const cli = createCliAdapter();
  return {
    copilot: cli,
    agy: cli,
    "claude-cli": cli,
    codex: cli,
    openai: openaiAdapter,
    gemini: geminiAdapter,
    anthropic: anthropicAdapter,
    ...extra,
  };
}
