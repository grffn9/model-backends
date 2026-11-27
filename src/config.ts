import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { EFFORT_SLOT } from "./effort.ts";
import { BUILTIN_ADAPTERS, EFFORTS } from "./types.ts";
import type {
  Account,
  AdapterName,
  Backend,
  Connections,
  Effort,
  LimitRule,
  LiveUsageConfig,
} from "./types.ts";

type Env = Record<string, string | undefined>;
type Raw = Record<string, unknown>;

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const WINDOWS = ["minute", "hour", "5h", "day", "week", "month"];
const DEFAULT_COMMANDS: Record<string, string> = {
  copilot: "copilot",
  agy: "agy",
  "claude-cli": "claude",
  codex: "codex",
};
/** Fields parseConnections reads from a backend. Anything else is left in extras for the app. */
const BACKEND_FIELDS = new Set([
  "id",
  "label",
  "account",
  "adapter",
  "model",
  "efforts",
  "price",
  "requiresEnv",
  "env",
  "command",
  "baseUrl",
  "apiKeyEnv",
  "extraBody",
]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid config: ${message}`);
    this.name = "ConfigError";
  }
}

export interface ParseOptions {
  /** Adapter names an app registered on top of the built-in ones. */
  adapters?: string[];
  /** Adapters, among those, that call an HTTP API and so need apiKeyEnv and baseUrl. */
  httpAdapters?: string[];
}

export interface ParsedConnections extends Connections {
  /** Each backend's fields this package does not read, by backend id, such as routing scores. */
  extras: Map<string, Raw>;
  /** The whole file after ${VAR} expansion, for the app's own top-level sections. */
  root: Raw;
}

function expand(value: unknown, env: Env): unknown {
  if (typeof value === "string") {
    return value.replace(
      VARIABLE,
      (_match, name: string, fallback?: string) => env[name] || fallback || "",
    );
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env)]));
  }
  return value;
}

function asRecord(value: unknown, where: string): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  return value as Raw;
}

function asList(value: unknown, where: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be a list`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`${where} must be a non-empty string`);
  }
  return value;
}

function parseLimit(value: unknown, where: string): LimitRule {
  const raw = asRecord(value, where);
  if (!WINDOWS.includes(String(raw.window))) {
    throw new ConfigError(`${where}.window must be one of ${WINDOWS.join(", ")}`);
  }
  const rule: LimitRule = { window: raw.window as LimitRule["window"] };
  for (const metric of ["requests", "tokens", "usd"] as const) {
    if (raw[metric] === undefined) continue;
    const amount = Number(raw[metric]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConfigError(`${where}.${metric} must be a positive number`);
    }
    rule[metric] = amount;
  }
  if (rule.requests === undefined && rule.tokens === undefined && rule.usd === undefined) {
    throw new ConfigError(`${where} needs requests, tokens or usd`);
  }
  return rule;
}

function parseLiveUsage(value: unknown, where: string): LiveUsageConfig | undefined {
  if (value === undefined) return undefined;
  const raw = asRecord(value, where);
  if (raw.source !== "copilot" && raw.source !== "claude" && raw.source !== "codex") {
    throw new ConfigError(`${where}.source must be copilot, claude or codex`);
  }
  // An empty folder, such as an unset ${VAR}, means the CLI's default sign-in.
  const configDir = raw.configDir === undefined ? "" : String(raw.configDir).trim();
  return configDir ? { source: raw.source, configDir } : { source: raw.source };
}

function parseAccounts(value: unknown): Map<string, Account> {
  const accounts = new Map<string, Account>();
  for (const [id, entry] of Object.entries(asRecord(value, "accounts"))) {
    const raw = asRecord(entry, `accounts.${id}`);
    const kind = String(raw.kind ?? "subscription");
    if (kind !== "subscription" && kind !== "api" && kind !== "free") {
      throw new ConfigError(`accounts.${id}.kind must be subscription, api or free`);
    }
    const limitScope = String(raw.limitScope ?? "account");
    if (limitScope !== "account" && limitScope !== "model") {
      throw new ConfigError(`accounts.${id}.limitScope must be account or model`);
    }
    const account: Account = {
      id,
      label: text(raw.label ?? id, `accounts.${id}.label`),
      kind,
      limits: asList(raw.limits, `accounts.${id}.limits`).map((limit, index) =>
        parseLimit(limit, `accounts.${id}.limits[${index}]`),
      ),
      limitScope,
    };
    const liveUsage = parseLiveUsage(raw.liveUsage, `accounts.${id}.liveUsage`);
    if (liveUsage) account.liveUsage = liveUsage;
    accounts.set(id, account);
  }
  return accounts;
}

function parseEfforts(value: unknown, where: string): Effort[] {
  const levels = asList(value, where).map(String);
  for (const level of levels) {
    if (!EFFORTS.includes(level as Effort)) {
      throw new ConfigError(`${where} has unknown level ${level}; use ${EFFORTS.join(", ")}`);
    }
  }
  return EFFORTS.filter((level) => levels.includes(level));
}

function parseBackend(
  raw: Raw,
  where: string,
  accounts: Map<string, Account>,
  adapters: string[],
  httpAdapters: Set<string>,
): Backend {
  const id = text(raw.id, `${where}.id`);
  where = `backend ${id}`;
  const account = text(raw.account, `${where}.account`);
  if (!accounts.has(account)) throw new ConfigError(`${where} uses unknown account ${account}`);
  const adapter = String(raw.adapter) as AdapterName;
  if (!adapters.includes(adapter)) {
    throw new ConfigError(`${where}.adapter must be one of ${adapters.join(", ")}`);
  }
  const apiKeyEnv = raw.apiKeyEnv === undefined ? undefined : text(raw.apiKeyEnv, where);
  if ((httpAdapters.has(adapter) || adapter === "gemini") && !apiKeyEnv) {
    throw new ConfigError(`${where} needs apiKeyEnv`);
  }
  if (httpAdapters.has(adapter) && !raw.baseUrl) throw new ConfigError(`${where} needs baseUrl`);
  if (raw.extraBody !== undefined && !httpAdapters.has(adapter)) {
    throw new ConfigError(`${where}.extraBody only works with HTTP adapters such as openai`);
  }
  const requiresEnv = asList(raw.requiresEnv, `${where}.requiresEnv`).map(String);
  // Claude API backends can run on an `ant auth login` sign-in instead, checked at availability.
  if (apiKeyEnv && adapter !== "anthropic" && !requiresEnv.includes(apiKeyEnv)) {
    requiresEnv.push(apiKeyEnv);
  }
  const price = raw.price === undefined ? {} : asRecord(raw.price, `${where}.price`);
  // A model may be empty until its requiresEnv variable is set.
  const model = String(raw.model ?? "");
  const efforts = parseEfforts(raw.efforts, `${where}.efforts`);
  if (model.includes(EFFORT_SLOT) && !efforts.length) {
    throw new ConfigError(`${where}.model with ${EFFORT_SLOT} needs efforts`);
  }
  const command = raw.command === undefined ? DEFAULT_COMMANDS[adapter] : String(raw.command);

  return {
    id,
    label: text(raw.label ?? id, `${where}.label`),
    account,
    adapter,
    model,
    efforts,
    price: { input: Number(price.input ?? 0), output: Number(price.output ?? 0) },
    requiresEnv,
    env: Object.fromEntries(
      Object.entries(raw.env === undefined ? {} : asRecord(raw.env, `${where}.env`)).map(
        ([key, envValue]) => [key, String(envValue)],
      ),
    ),
    ...(command ? { command } : {}),
    ...(raw.baseUrl === undefined ? {} : { baseUrl: String(raw.baseUrl).replace(/\/+$/, "") }),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(raw.extraBody === undefined
      ? {}
      : { extraBody: asRecord(raw.extraBody, `${where}.extraBody`) }),
  };
}

/**
 * Reads accounts and backends from YAML. ${VAR} reads the environment and ${VAR:-default}
 * supplies a fallback; merge keys (<<: *anchor) let backends share fields written once.
 */
export function parseConnections(
  source: string,
  env: Env = process.env,
  options: ParseOptions = {},
): ParsedConnections {
  const adapters = [...BUILTIN_ADAPTERS, ...(options.adapters ?? [])];
  const httpAdapters = new Set(["openai", ...(options.httpAdapters ?? [])]);
  // The alias cap stays as a guard against runaway expansion, raised so a large config fits.
  const root = asRecord(expand(parse(source, { merge: true, maxAliasCount: 1000 }), env), "config");
  const accounts = parseAccounts(root.accounts);
  const extras = new Map<string, Raw>();
  const backends = asList(root.backends, "backends").map((entry, index) => {
    const raw = asRecord(entry, `backends[${index}]`);
    const backend = parseBackend(raw, `backends[${index}]`, accounts, adapters, httpAdapters);
    if (extras.has(backend.id)) throw new ConfigError(`duplicate backend id ${backend.id}`);
    extras.set(
      backend.id,
      Object.fromEntries(Object.entries(raw).filter(([key]) => !BACKEND_FIELDS.has(key))),
    );
    return backend;
  });
  if (!backends.length) throw new ConfigError("at least one backend is required");
  return { accounts, backends, extras, root };
}

export function loadConnections(
  file: string,
  env: Env = process.env,
  options: ParseOptions = {},
): ParsedConnections {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`cannot read ${file}`);
  }
  return parseConnections(source, env, options);
}
