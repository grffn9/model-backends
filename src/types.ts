/** Reasoning effort levels, lowest first. Each backend lists the ones its model accepts. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type LimitWindow = "minute" | "hour" | "5h" | "day" | "week" | "month";

/** The adapters this package ships. Apps may register more under their own names. */
export const BUILTIN_ADAPTERS = [
  "copilot",
  "agy",
  "claude-cli",
  "codex",
  "openai",
  "gemini",
  "anthropic",
] as const;
export type BuiltinAdapter = (typeof BUILTIN_ADAPTERS)[number];
/** A built-in adapter name, or one an app registered itself. */
export type AdapterName = BuiltinAdapter | (string & {});

/** The adapters that drive a subscription's CLI rather than calling an HTTP API. */
export const CLI_ADAPTERS: readonly string[] = ["copilot", "agy", "claude-cli", "codex"];

/** A cap the user chose, such as a monthly API budget. Never a guess at a provider's limit. */
export interface LimitRule {
  window: LimitWindow;
  requests?: number;
  tokens?: number;
  usd?: number;
}

export type LiveUsageSource = "copilot" | "claude" | "codex";

/** Where to read an account's real usage from its provider, instead of estimating it. */
export interface LiveUsageConfig {
  source: LiveUsageSource;
  /**
   * Claude and Codex: the CLAUDE_CONFIG_DIR or CODEX_HOME folder whose sign-in to read.
   * Empty means the CLI's default, ~/.claude or ~/.codex.
   */
  configDir?: string;
}

/** Something that pays for tokens: a subscription, a metered API key or a free tier. */
export interface Account {
  id: string;
  label: string;
  kind: "subscription" | "api" | "free";
  /** Caps the user set, which the ledger checks. Empty means none. */
  limits: LimitRule[];
  liveUsage?: LiveUsageConfig;
  /**
   * What a provider limit error pauses: the whole account, or only the model that hit it, for
   * providers that keep a separate quota per model, as Antigravity does.
   */
  limitScope: "account" | "model";
}

/** One model reachable through one account, and how to reach it. */
export interface Backend {
  id: string;
  label: string;
  account: string;
  adapter: AdapterName;
  /** May contain {effort}, for providers whose model ids name the effort level. */
  model: string;
  /** Effort levels the model accepts, lowest first. Empty means the provider's default only. */
  efforts: Effort[];
  /** USD per million tokens. Zero for subscriptions and free tiers. */
  price: { input: number; output: number };
  /** Variables that must be set before the backend counts as available. */
  requiresEnv: string[];
  /** Added to a CLI's environment, such as CLAUDE_CONFIG_DIR for a second sign-in. */
  env: Record<string, string>;
  command?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** OpenAI-compatible only: extra request fields, such as OpenRouter's provider. */
  extraBody?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Attachment {
  name: string;
  mime: string;
  /** Base64 without a data: prefix. */
  data: string;
}

export interface GenerateInput {
  messages: ChatMessage[];
  attachments: Attachment[];
  /** One of the backend's efforts, or undefined for the provider's default. */
  effort?: Effort;
  signal: AbortSignal;
  maxOutputTokens?: number;
  /** Gemini only: ask for images as well as text. */
  images?: boolean;
  /**
   * CLI backends only: the folder to work in, with tools on. Unset, the CLI runs tool-free in
   * an empty sandbox folder.
   */
  folder?: string;
  /** Sent as the system prompt; CLIs, which take none, get it ahead of the prompt. */
  instructions?: string;
}

/**
 * One thing an agent did, such as "Edited src/login.ts", or what it said between tool calls
 * (tool "message"). Progress only: never part of the answer or sent back to a model.
 */
export interface StepEvent {
  type: "step";
  tool: string;
  summary: string;
}

export type OutputEvent =
  | StepEvent
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export type Adapter = (backend: Backend, input: GenerateInput) => AsyncIterable<OutputEvent>;

export type FailureKind =
  "rate_limit" | "auth" | "unavailable" | "timeout" | "bad_request" | "refused" | "cancelled";

export class BackendError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterMs?: number;

  constructor(kind: FailureKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A provider limit's window. "balance" is a prepaid credit balance with no total, such as Codex
 * credits: limit is the amount left, nothing counts as used, and remaining is 1 until it is gone.
 */
export type UsageWindow = LimitWindow | "balance";

export interface LimitUsage {
  window: UsageWindow;
  /** credits and percent come only from providers; the ledger counts requests, tokens and usd. */
  metric: "requests" | "tokens" | "usd" | "credits" | "percent";
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number | null;
  /**
   * Set when the limit belongs to one model, by the provider's id for it, such as one of
   * Codex's per-model limits. It stops only that model; unset, it covers the whole account.
   */
  model?: string;
  /**
   * Set when model is a family name rather than an id, such as Claude's "Fable" weekly limit.
   * It then covers every model whose id names that family, such as claude-fable-5-2.
   */
  modelFamily?: boolean;
}

export interface AccountHeadroom {
  account: string;
  /** Lowest remaining share across the account's limits, from 0 to 1. */
  headroom: number;
  limits: LimitUsage[];
  cooldownUntil: number | null;
  cooldownReason: string | null;
}

/** The accounts and backends read from a connections file. */
export interface Connections {
  accounts: Map<string, Account>;
  backends: Backend[];
}
