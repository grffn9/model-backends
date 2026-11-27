import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Account, AccountHeadroom, LimitUsage, LimitWindow } from "./types.ts";

const ROLLING_MS: Record<Exclude<LimitWindow, "month">, number> = {
  minute: 60_000,
  hour: 3_600_000,
  "5h": 18_000_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Calls that consumed quota. Failed calls with no output are logged but not counted. */
const COUNTED = "('ok','partial')";

export interface CallRecord {
  ts: number;
  account: string;
  backend: string;
  task: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  weight: number;
  latencyMs: number;
  estimated: boolean;
}

interface WindowRow {
  requests: number | null;
  tokens: number | null;
  usd: number | null;
  oldest: number | null;
}

export function windowStart(window: LimitWindow, now: number): number {
  if (window === "month") {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  return now - ROLLING_MS[window];
}

function windowReset(window: LimitWindow, now: number, oldest: number | null): number | null {
  if (window === "month") {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return oldest === null ? null : oldest + ROLLING_MS[window];
}

export class UsageLedger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        account TEXT NOT NULL,
        backend TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        usd REAL NOT NULL,
        weight REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        estimated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calls_account_ts ON calls (account, ts);
      CREATE TABLE IF NOT EXISTS cooldowns (
        account TEXT PRIMARY KEY,
        until INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_cooldowns (
        backend TEXT PRIMARY KEY,
        until INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
    `);
  }

  record(call: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls
          (ts, account, backend, task, status, input_tokens, output_tokens, usd, weight,
           latency_ms, estimated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.ts,
        call.account,
        call.backend,
        call.task,
        call.status,
        Math.round(call.inputTokens),
        Math.round(call.outputTokens),
        call.usd,
        call.weight,
        Math.round(call.latencyMs),
        call.estimated ? 1 : 0,
      );
  }

  setCooldown(account: string, until: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO cooldowns (account, until, reason) VALUES (?, ?, ?)
         ON CONFLICT (account) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
      )
      .run(account, until, reason);
  }

  clearCooldown(account: string): void {
    this.db.prepare("DELETE FROM cooldowns WHERE account = ?").run(account);
  }

  /** Pauses one backend's model, for providers that keep a separate quota per model. */
  setModelCooldown(backend: string, until: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO model_cooldowns (backend, until, reason) VALUES (?, ?, ?)
         ON CONFLICT (backend) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
      )
      .run(backend, until, reason);
  }

  modelCooldown(
    backend: string,
    now: number = Date.now(),
  ): { until: number; reason: string } | null {
    const row = this.db
      .prepare("SELECT until, reason FROM model_cooldowns WHERE backend = ? AND until > ?")
      .get(backend, now) as { until: number; reason: string } | undefined;
    return row ? { until: row.until, reason: row.reason } : null;
  }

  clearModelCooldowns(backends: string[]): void {
    const statement = this.db.prepare("DELETE FROM model_cooldowns WHERE backend = ?");
    for (const backend of backends) statement.run(backend);
  }

  headroom(account: Account, now: number = Date.now()): AccountHeadroom {
    const query = this.db.prepare(
      `SELECT SUM(weight) AS requests, SUM(input_tokens + output_tokens) AS tokens,
              SUM(usd) AS usd, MIN(ts) AS oldest
       FROM calls WHERE account = ? AND ts >= ? AND status IN ${COUNTED}`,
    );
    const limits: LimitUsage[] = [];
    for (const rule of account.limits) {
      const row = query.get(account.id, windowStart(rule.window, now)) as unknown as WindowRow;
      for (const metric of ["requests", "tokens", "usd"] as const) {
        const limit = rule[metric];
        if (limit === undefined) continue;
        const used = row[metric] ?? 0;
        limits.push({
          window: rule.window,
          metric,
          used,
          limit,
          remaining: Math.max(0, 1 - used / limit),
          resetsAt: windowReset(rule.window, now, row.oldest),
        });
      }
    }

    const cooldown = this.db
      .prepare("SELECT until, reason FROM cooldowns WHERE account = ? AND until > ?")
      .get(account.id, now) as { until: number; reason: string } | undefined;

    return {
      account: account.id,
      headroom: limits.length ? Math.min(...limits.map((limit) => limit.remaining)) : 1,
      limits,
      cooldownUntil: cooldown?.until ?? null,
      cooldownReason: cooldown?.reason ?? null,
    };
  }

  recent(limit = 20): CallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ts, account, backend, task, status, input_tokens AS inputTokens,
                output_tokens AS outputTokens, usd, weight, latency_ms AS latencyMs, estimated
         FROM calls ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as (Omit<CallRecord, "estimated"> & { estimated: number })[];
    return rows.map((row) => ({ ...row, estimated: row.estimated === 1 }));
  }

  close(): void {
    this.db.close();
  }
}
