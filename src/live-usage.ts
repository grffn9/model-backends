import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withoutSecrets } from "./secret-env.ts";
import type { Account, LimitUsage, LimitWindow, LiveUsageSource } from "./types.ts";

type Env = Record<string, string | undefined>;
type Raw = Record<string, unknown>;

/** A reading that failed in a way worth showing the user, such as a missing sign-in. */
export class LiveUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveUsageError";
  }
}

/** The provider is turning reads away for asking too often (HTTP 429). */
export class RateLimitError extends LiveUsageError {
  /** How long the provider asked us to wait, from its Retry-After header, if it said. */
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

const isRecord = (value: unknown): value is Raw =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const share = (value: number) => Math.min(1, Math.max(0, value));

function parseTime(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Reads GitHub's Copilot quota. It covers the billing source selected in GitHub settings, so
 * credits from another source show up only after switching to it there.
 */
export function parseCopilotQuota(body: unknown): LimitUsage[] {
  const snapshots = isRecord(body) ? body.quota_snapshots : undefined;
  const credits = isRecord(snapshots) ? snapshots.premium_interactions : undefined;
  if (!isRecord(body) || !isRecord(credits)) {
    throw new LiveUsageError("GitHub's reply had no Copilot credit quota");
  }
  if (credits.unlimited === true) return [];

  const limit = Number(credits.entitlement);
  const remaining = Math.max(0, Number(credits.remaining ?? credits.quota_remaining));
  if (!(limit > 0) || !Number.isFinite(remaining)) {
    throw new LiveUsageError("GitHub's reply had no Copilot credit allowance");
  }
  const reported = Number(credits.credits_used);
  return [
    {
      window: "month",
      metric: "credits",
      used: Number.isFinite(reported) ? reported : limit - remaining,
      limit,
      remaining: share(remaining / limit),
      resetsAt: parseTime(body.quota_reset_date_utc ?? body.quota_reset_date),
    },
  ];
}

const CLAUDE_WINDOWS: [string, LimitWindow][] = [
  ["five_hour", "5h"],
  ["seven_day", "week"],
];

/** Older weekly limits of one Claude model family, each in a field of its own. */
const CLAUDE_FAMILY_WINDOWS: [string, string][] = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
];

/** A percent-of-window limit, or null when the provider gave no usable number. */
function percentLimit(
  window: LimitWindow,
  value: unknown,
  resetsAt: unknown,
  // Number(null) is 0, so a missing reading must be caught before converting.
): LimitUsage | null {
  if (value === null || value === undefined || value === "") return null;
  const used = Number(value);
  if (!Number.isFinite(used)) return null;
  return {
    window,
    metric: "percent",
    used,
    limit: 100,
    remaining: share((100 - used) / 100),
    resetsAt: parseTime(resetsAt),
  };
}

/**
 * Claude's weekly limits for one model family. limits[] lists them as weekly_scoped entries
 * whose scope names the model: by id when Claude gives one, otherwise by its family name,
 * such as "Fable". The older seven_day_opus and seven_day_sonnet fields count only when
 * limits[] has no entry for that family.
 */
function parseClaudeModelLimits(body: Raw): LimitUsage[] {
  const found: LimitUsage[] = [];
  const add = (limit: LimitUsage | null, model: string, family: boolean) => {
    const name = model.trim();
    if (!limit || !name) return;
    if (found.some((entry) => entry.model?.toLowerCase() === name.toLowerCase())) return;
    found.push(family ? { ...limit, model: name, modelFamily: true } : { ...limit, model: name });
  };
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    if (!isRecord(entry) || entry.kind !== "weekly_scoped" || !isRecord(entry.scope)) continue;
    const model = entry.scope.model;
    if (!isRecord(model)) continue;
    const limit = percentLimit("week", entry.percent, entry.resets_at);
    if (typeof model.id === "string" && model.id.trim()) add(limit, model.id, false);
    else if (typeof model.display_name === "string") add(limit, model.display_name, true);
  }
  for (const [key, family] of CLAUDE_FAMILY_WINDOWS) {
    const entry = body[key];
    if (isRecord(entry))
      add(percentLimit("week", entry.utilization, entry.resets_at), family, true);
  }
  return found;
}

/**
 * Reads Claude's subscription usage, a percentage of each rolling window, then any weekly
 * limit of a single model family.
 */
export function parseClaudeUsage(body: unknown): LimitUsage[] {
  const limits: LimitUsage[] = [];
  for (const [key, window] of CLAUDE_WINDOWS) {
    const entry = isRecord(body) ? body[key] : undefined;
    if (!isRecord(entry)) continue;
    const limit = percentLimit(window, entry.utilization, entry.resets_at);
    if (limit) limits.push(limit);
  }
  const modelLimits = isRecord(body) ? parseClaudeModelLimits(body) : [];
  if (!limits.length && !modelLimits.length) {
    throw new LiveUsageError("Claude's reply had no usage windows");
  }
  return [...limits, ...modelLimits];
}

/** Window lengths in seconds, for naming a provider's window by its length. */
const WINDOW_SECONDS: [LimitWindow, number][] = [
  ["minute", 60],
  ["hour", 3_600],
  ["5h", 18_000],
  ["day", 86_400],
  ["week", 604_800],
  ["month", 2_592_000],
];

/** The named window closest in length, so an odd length still gets a sensible label. */
function windowFor(seconds: number): LimitWindow {
  const distance = (length: number) => Math.abs(Math.log(seconds / length));
  return WINDOW_SECONDS.reduce((best, entry) =>
    distance(entry[1]) < distance(best[1]) ? entry : best,
  )[0];
}

function parseCodexWindow(value: unknown): LimitUsage | null {
  if (!isRecord(value)) return null;
  const used = Number(value.used_percent);
  const seconds = Number(value.limit_window_seconds);
  if (!Number.isFinite(used) || !(seconds > 0)) return null;
  const resetAt = Number(value.reset_at);
  return {
    window: windowFor(seconds),
    metric: "percent",
    used,
    limit: 100,
    remaining: share((100 - used) / 100),
    resetsAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null,
  };
}

function parseCodexWindows(rateLimit: unknown): (LimitUsage | null)[] {
  return isRecord(rateLimit)
    ? [parseCodexWindow(rateLimit.primary_window), parseCodexWindow(rateLimit.secondary_window)]
    : [];
}

/**
 * Codex's limits for single models, each named by the model id the CLI runs it as. The name
 * "codex" is the plan itself, which the CLI treats the same way.
 */
function parseCodexModelLimits(value: unknown): LimitUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const model = isRecord(entry) && typeof entry.limit_name === "string" ? entry.limit_name : "";
    if (!model.trim() || model.trim().toLowerCase() === "codex") return [];
    return parseCodexWindows((entry as Raw).rate_limit)
      .filter((limit): limit is LimitUsage => limit !== null)
      .map((limit) => ({ ...limit, model: model.trim() }));
  });
}

/**
 * Reads Codex's usage: percent of each plan window, then the credit balance that pays once a
 * window runs out, then any limits a single model has of its own. Unlimited credits mean no
 * plan limit applies, though a model's own limit still does.
 */
export function parseCodexUsage(body: unknown): LimitUsage[] {
  const rateLimit = isRecord(body) ? body.rate_limit : undefined;
  const credits = isRecord(body) ? body.credits : undefined;
  const modelLimits = parseCodexModelLimits(isRecord(body) ? body.additional_rate_limits : null);
  if (isRecord(credits) && credits.unlimited === true) return modelLimits;
  const limits = parseCodexWindows(rateLimit);
  const left = isRecord(credits) ? Number.parseFloat(String(credits.balance)) : NaN;
  if (Number.isFinite(left)) {
    const balance = Math.max(0, left);
    limits.push({
      window: "balance",
      metric: "credits",
      used: 0,
      limit: balance,
      remaining: balance > 0 ? 1 : 0,
      resetsAt: null,
    });
  }
  const found = limits.filter((limit): limit is LimitUsage => limit !== null);
  if (!found.length && !modelLimits.length) {
    throw new LiveUsageError("OpenAI's reply had no Codex usage");
  }
  return [...found, ...modelLimits];
}

/**
 * The lowest remaining share across an account's provider limits. Plan windows decide it: a
 * credit balance is paid overflow, so routing never spends it once a window runs out, and it
 * never makes a window look fuller than it is. It counts only for an account with no windows.
 * A single model's own limit is left out: it stops only that model, as modelHeadroom says.
 */
export function providerHeadroom(limits: LimitUsage[]): number {
  const accountLimits = limits.filter((limit) => limit.model === undefined);
  const windows = accountLimits.filter((limit) => limit.window !== "balance");
  if (windows.length) return Math.min(...windows.map((limit) => limit.remaining));
  return accountLimits.find((limit) => limit.window === "balance")?.remaining ?? 1;
}

/** The words of a model id or name, so "claude-fable-5.2" and "Fable 5.2" line up. */
const modelWords = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);

/**
 * Whether a model limit covers a backend's model id, in any case: the same id, or for a family
 * limit, an id whose words include the family's, such as Fable for claude-fable-5-2.
 */
export function limitCoversModel(limit: LimitUsage, model: string): boolean {
  if (!limit.model) return false;
  if (limit.model.toLowerCase() === model.toLowerCase()) return true;
  if (!limit.modelFamily) return false;
  const family = modelWords(limit.model);
  const words = modelWords(model);
  if (!family.length) return false;
  return words.some((_word, start) => family.every((part, i) => words[start + i] === part));
}

/** A model's tightest own limit, or null if it has none. */
export function modelHeadroom(limits: LimitUsage[], model: string): LimitUsage | null {
  return limits.reduce<LimitUsage | null>(
    (tightest, limit) =>
      limitCoversModel(limit, model) && (!tightest || limit.remaining < tightest.remaining)
        ? limit
        : tightest,
    null,
  );
}

export type LiveReader = (account: Account, signal: AbortSignal) => Promise<LimitUsage[]>;

/** Seams for tests. Each defaults to the real thing. */
export interface ReaderDeps {
  fetch?: typeof fetch;
  env?: Env;
  /** Runs a command and resolves to its trimmed output, or null if it fails. */
  run?: (command: string, args: string[]) => Promise<string | null>;
  /** Resolves to a file's text, or null if it cannot be read. */
  readText?: (file: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  now?: () => number;
}

const COPILOT_URL = "https://api.github.com/copilot_internal/user";
const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Checked in the order the Copilot CLI checks them, so both read the same account. */
const GITHUB_TOKEN_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_EXPIRED = "Claude sign-in expired. Run claude once to refresh it";
/** What the Codex CLI's /status reads. Not a documented API, so it may change. */
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_EXPIRED = "Codex sign-in expired. Run codex once to refresh it";
const COMMAND_TIMEOUT_MS = 10_000;
/**
 * These commands only read a stored sign-in, so they get no keys or tokens. gh runs only when
 * no GitHub token variable is set, so it loses nothing it would read.
 */
function runCommand(command: string, args: string[]): Promise<string | null> {
  const env = withoutSecrets(process.env);
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** How long a Retry-After header asks to wait: seconds, or an HTTP date. Null if unreadable. */
function retryAfterMs(header: string | null, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : null;
}

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  provider: string,
  now: () => number = Date.now,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers, signal });
  } catch {
    throw new LiveUsageError(`Could not reach ${provider}`);
  }
  if (response.status === 429) {
    throw new RateLimitError(
      `${provider} is limiting how often usage can be checked`,
      retryAfterMs(response.headers.get("retry-after"), now()),
    );
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  return { status: response.status, body };
}

/** Reads Copilot credits with the same GitHub sign-in the Copilot CLI would use. */
export function copilotReader(deps: ReaderDeps = {}): LiveReader {
  const fetchFn = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  const now = deps.now ?? Date.now;
  return async (_account, signal) => {
    const envName = GITHUB_TOKEN_ENV.find((name) => env[name]?.trim());
    const token = envName ? env[envName]?.trim() : await run("gh", ["auth", "token"]);
    if (!token) {
      throw new LiveUsageError("Run gh auth login, or set GH_TOKEN, to read Copilot usage");
    }
    const { status, body } = await getJson(
      fetchFn,
      COPILOT_URL,
      { authorization: `token ${token}`, accept: "application/json" },
      signal,
      "GitHub",
      now,
    );
    if (status === 401) {
      throw new LiveUsageError(
        envName
          ? `GitHub rejected the token in ${envName}`
          : "GitHub rejected the gh sign-in. Run gh auth login",
      );
    }
    if (status !== 200) throw new LiveUsageError(`GitHub returned HTTP ${status}`);
    return parseCopilotQuota(body);
  };
}

function parseSignIn(text: string | null): { token: string; expiresAt: number | null } | null {
  if (!text) return null;
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: Raw }).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    const expiresAt = Number(oauth.expiresAt);
    return { token: oauth.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  } catch {
    return null;
  }
}

/**
 * Reads Claude subscription usage with the Claude Code sign-in in the account's config folder.
 * It never refreshes the sign-in, because that would replace the tokens Claude Code relies on.
 */
export function claudeReader(deps: ReaderDeps = {}): LiveReader {
  const fetchFn = deps.fetch ?? fetch;
  const run = deps.run ?? runCommand;
  const read = deps.readText ?? readText;
  const platform = deps.platform ?? process.platform;
  const homedir = deps.homedir ?? os.homedir;
  const now = deps.now ?? Date.now;
  return async (account, signal) => {
    const custom = account.liveUsage?.configDir?.trim();
    const folder = custom || path.join(homedir(), ".claude");
    let text = await read(path.join(folder, ".credentials.json"));
    // On macOS, Claude Code keeps the default sign-in in the keychain instead of a file.
    if (text === null && !custom && platform === "darwin") {
      text = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    }
    const signIn = parseSignIn(text);
    if (!signIn) {
      throw new LiveUsageError(`No Claude Code sign-in in ${folder}. Run claude to log in`);
    }
    if (signIn.expiresAt !== null && signIn.expiresAt <= now()) {
      throw new LiveUsageError(CLAUDE_EXPIRED);
    }
    const { status, body } = await getJson(
      fetchFn,
      CLAUDE_URL,
      { authorization: `Bearer ${signIn.token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal,
      "Claude",
      now,
    );
    if (status === 401 || status === 403) throw new LiveUsageError(CLAUDE_EXPIRED);
    if (status !== 200) throw new LiveUsageError(`Claude returned HTTP ${status}`);
    return parseClaudeUsage(body);
  };
}

/** When a JWT access token expires, from its exp claim, or null if it can't be read. */
function jwtExpiry(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const exp = Number((claims as Raw).exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

type CodexSignIn = { token: string; accountId: string | null } | "api-key" | null;

/** Reads auth.json as `codex login` writes it. An API-key sign-in has no ChatGPT usage. */
function parseCodexSignIn(text: string | null): CodexSignIn {
  if (!text) return null;
  try {
    const auth = JSON.parse(text) as Raw;
    const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
    if (typeof tokens?.access_token === "string" && tokens.access_token) {
      const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
      return { token: tokens.access_token, accountId };
    }
    return auth.OPENAI_API_KEY ? "api-key" : null;
  } catch {
    return null;
  }
}

/**
 * Reads Codex plan usage and credits with the ChatGPT sign-in in the account's CODEX_HOME.
 * Like the Claude reader, it never refreshes the sign-in: the Codex CLI owns those tokens.
 */
export function codexReader(deps: ReaderDeps = {}): LiveReader {
  const fetchFn = deps.fetch ?? fetch;
  const read = deps.readText ?? readText;
  const homedir = deps.homedir ?? os.homedir;
  const now = deps.now ?? Date.now;
  return async (account, signal) => {
    const folder = account.liveUsage?.configDir?.trim() || path.join(homedir(), ".codex");
    const signIn = parseCodexSignIn(await read(path.join(folder, "auth.json")));
    if (signIn === "api-key") {
      throw new LiveUsageError(
        "Codex is signed in with an API key, which has no ChatGPT usage or credits. Run codex login",
      );
    }
    if (!signIn) throw new LiveUsageError(`No Codex sign-in in ${folder}. Run codex login`);
    const expiresAt = jwtExpiry(signIn.token);
    if (expiresAt !== null && expiresAt <= now()) throw new LiveUsageError(CODEX_EXPIRED);
    const headers: Record<string, string> = {
      authorization: `Bearer ${signIn.token}`,
      accept: "application/json",
    };
    if (signIn.accountId) headers["chatgpt-account-id"] = signIn.accountId;
    const { status, body } = await getJson(fetchFn, CODEX_URL, headers, signal, "OpenAI", now);
    if (status === 401 || status === 403) throw new LiveUsageError(CODEX_EXPIRED);
    if (status !== 200) throw new LiveUsageError(`OpenAI returned HTTP ${status}`);
    return parseCodexUsage(body);
  };
}

export interface LiveReading {
  /** The provider's limits, or null when there is no recent good reading. */
  limits: LimitUsage[] | null;
  checkedAt: number | null;
  error: string | null;
  /** While the provider is rate-limiting reads, when it will next be asked. */
  retryAt: number | null;
}

/**
 * Claude's usage endpoint turns reads away (HTTP 429) when asked about once a minute, and
 * Claude Code itself reads the same sign-in's usage, so Claude is asked less often.
 */
const SOURCE_TTL_MS: Partial<Record<LiveUsageSource, number>> = { claude: 5 * 60_000 };

export interface LiveUsageOptions {
  /** How long a reading is reused before the provider is asked again. */
  ttlMs?: number;
  /** A refresh interval per source, overriding ttlMs. Defaults to slower reads of Claude. */
  sourceTtlMs?: Partial<Record<LiveUsageSource, number>>;
  /** The longest wait after repeated 429s when the provider gives no Retry-After. */
  maxBackoffMs?: number;
  /** How long the last good reading still counts while new reads fail. */
  maxAgeMs?: number;
  /** How long one read may take. */
  timeoutMs?: number;
  now?: () => number;
}

interface Entry extends LiveReading {
  attemptedAt: number;
  pending: Promise<void> | null;
  /** 429s in a row, to double the wait when the provider doesn't say how long. */
  rateLimits: number;
}

export function defaultReaders(): Record<LiveUsageSource, LiveReader> {
  return { copilot: copilotReader(), claude: claudeReader(), codex: codexReader() };
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LiveUsageError("The provider did not answer in time"));
    }, ms);
    timer.unref();
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Caches each account's provider usage so the dashboard and router can read it cheaply. */
export class LiveUsage {
  private readonly readers: Partial<Record<LiveUsageSource, LiveReader>>;
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly sourceTtlMs: Partial<Record<LiveUsageSource, number>>;
  private readonly maxBackoffMs: number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    readers: Partial<Record<LiveUsageSource, LiveReader>>,
    options: LiveUsageOptions = {},
  ) {
    this.readers = readers;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.sourceTtlMs = options.sourceTtlMs ?? SOURCE_TTL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads every stale account, or every account with force, such as right after the user
   * switches a billing source. Failures are kept per account, never thrown. An account whose
   * provider is rate-limiting reads waits out the limit even when forced, since asking again
   * early only extends it.
   */
  async refresh(accounts: Account[], force = false): Promise<void> {
    await Promise.all(accounts.map((account) => this.refreshOne(account, force)));
  }

  private refreshOne(account: Account, force: boolean): Promise<void> {
    const source = account.liveUsage?.source;
    const reader = source ? this.readers[source] : undefined;
    if (!reader) return Promise.resolve();
    const now = this.now();
    const entry = this.entries.get(account.id) ?? {
      limits: null,
      checkedAt: null,
      error: null,
      retryAt: null,
      attemptedAt: -Infinity,
      pending: null,
      rateLimits: 0,
    };
    if (entry.pending) return entry.pending;
    if (entry.retryAt !== null && now < entry.retryAt) return Promise.resolve();
    const ttl = this.sourceTtlMs[source as LiveUsageSource] ?? this.ttlMs;
    if (!force && now - entry.attemptedAt < ttl) return Promise.resolve();

    entry.attemptedAt = now;
    this.entries.set(account.id, entry);
    entry.pending = withTimeout((signal) => reader(account, signal), this.timeoutMs)
      .then(
        (limits) => {
          entry.limits = limits;
          entry.checkedAt = this.now();
          entry.error = null;
          entry.retryAt = null;
          entry.rateLimits = 0;
        },
        (error: unknown) => {
          entry.error = error instanceof Error ? error.message : "Could not read usage";
          entry.retryAt = null;
          if (error instanceof RateLimitError) {
            entry.rateLimits += 1;
            const backoff = Math.min(ttl * 2 ** entry.rateLimits, this.maxBackoffMs);
            entry.retryAt = this.now() + Math.max(ttl, error.retryAfterMs ?? backoff);
          } else {
            entry.rateLimits = 0;
          }
        },
      )
      .finally(() => {
        entry.pending = null;
      });
    return entry.pending;
  }

  get(accountId: string): LiveReading {
    const entry = this.entries.get(accountId);
    if (!entry) return { limits: null, checkedAt: null, error: null, retryAt: null };
    const now = this.now();
    const recent = entry.checkedAt !== null && now - entry.checkedAt < this.maxAgeMs;
    return {
      limits: recent ? entry.limits : null,
      checkedAt: entry.checkedAt,
      error: entry.error,
      retryAt: entry.retryAt !== null && entry.retryAt > now ? entry.retryAt : null,
    };
  }
}
