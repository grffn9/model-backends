import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  claudeReader,
  codexReader,
  copilotReader,
  LiveUsage,
  LiveUsageError,
  parseClaudeUsage,
  parseCodexUsage,
  modelHeadroom,
  parseCopilotQuota,
  providerHeadroom,
  RateLimitError,
} from "../src/live-usage.ts";
import type { LiveReader } from "../src/live-usage.ts";
import type { LimitUsage } from "../src/types.ts";
import { makeAccount } from "./helpers.ts";

/** The shape GitHub returns for an enterprise seat whose monthly credits are used up. */
const copilotExhausted = {
  copilot_plan: "enterprise",
  quota_reset_date: "2026-12-01",
  quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { quota_id: "chat", unlimited: true, entitlement: 0, remaining: 0 },
    premium_interactions: {
      quota_id: "premium_interactions",
      unlimited: false,
      has_quota: false,
      overage_permitted: false,
      entitlement: 5000,
      remaining: 0,
      credits_used: 5000,
      percent_remaining: 0,
    },
  },
};

/** The shape Claude returns behind /usage in Claude Code. */
const claudeUsage = {
  five_hour: { utilization: 6.0, resets_at: "2026-11-23T23:10:00.153887+00:00" },
  seven_day: { utilization: 19.0, resets_at: "2026-11-28T02:00:00.153912+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
};

test("Copilot credits map to a monthly limit with GitHub's reset date", () => {
  assert.deepEqual(parseCopilotQuota(copilotExhausted), [
    {
      window: "month",
      metric: "credits",
      used: 5000,
      limit: 5000,
      remaining: 0,
      resetsAt: Date.UTC(2026, 11, 1),
    },
  ]);
});

test("Copilot credits left are a share of the allowance", () => {
  const body = structuredClone(copilotExhausted);
  Object.assign(body.quota_snapshots.premium_interactions, { remaining: 1250, credits_used: 3750 });
  const [limit] = parseCopilotQuota(body);
  assert.equal(limit?.used, 3750);
  assert.equal(limit?.remaining, 0.25);
});

test("an unlimited Copilot plan has no limit", () => {
  const body = structuredClone(copilotExhausted);
  body.quota_snapshots.premium_interactions.unlimited = true;
  assert.deepEqual(parseCopilotQuota(body), []);
});

test("a Copilot reply without a credit quota is rejected", () => {
  assert.throws(() => parseCopilotQuota({ login: "someone" }), LiveUsageError);
});

test("Claude usage maps to percent of the 5-hour and weekly windows", () => {
  assert.deepEqual(parseClaudeUsage(claudeUsage), [
    {
      window: "5h",
      metric: "percent",
      used: 6,
      limit: 100,
      remaining: 0.94,
      resetsAt: Date.parse("2026-11-23T23:10:00.153Z"),
    },
    {
      window: "week",
      metric: "percent",
      used: 19,
      limit: 100,
      remaining: 0.81,
      resetsAt: Date.parse("2026-11-28T02:00:00.153Z"),
    },
  ]);
});

test("Claude usage over 100% leaves no headroom", () => {
  const [limit] = parseClaudeUsage({ five_hour: { utilization: 104, resets_at: null } });
  assert.equal(limit?.remaining, 0);
  assert.equal(limit?.resetsAt, null);
});

/** A weekly limit of one Claude model family, as Claude's limits[] lists it. */
const scopedLimit = (name: unknown, percent: unknown, id: unknown = null) => ({
  kind: "weekly_scoped",
  group: "weekly",
  percent,
  severity: "normal",
  resets_at: "2026-11-28T02:00:00+00:00",
  scope: { model: { id, display_name: name }, surface: null },
  is_active: false,
});

test("Claude's model-scoped weekly limits are read with the model each one covers", () => {
  const body = {
    ...claudeUsage,
    seven_day_opus: { utilization: 40, resets_at: "2026-11-28T02:00:00+00:00" },
    seven_day_sonnet: { utilization: 100, resets_at: "2026-11-28T02:00:00+00:00" },
    limits: [
      { kind: "session", percent: 6, resets_at: null, scope: null },
      { kind: "weekly_all", percent: 19, resets_at: null, scope: null },
      scopedLimit("Fable", 75),
      scopedLimit("Haiku 5.5", 10, "claude-haiku-5-5"),
    ],
  };
  const scoped = parseClaudeUsage(body).filter((limit) => limit.model);
  assert.deepEqual(scoped[0], {
    window: "week",
    metric: "percent",
    used: 75,
    limit: 100,
    remaining: 0.25,
    resetsAt: Date.parse("2026-11-28T02:00:00Z"),
    model: "Fable",
    modelFamily: true,
  });
  assert.deepEqual(
    scoped.map((limit) => [limit.model, limit.modelFamily, limit.remaining]),
    [
      ["Fable", true, 0.25],
      ["claude-haiku-5-5", undefined, 0.9],
      ["Opus", true, 0.6],
      ["Sonnet", true, 0],
    ],
  );
});

test("Claude's scoped limits with no usage or no model are left out, and none is read twice", () => {
  const body = {
    ...claudeUsage,
    seven_day_opus: { utilization: 30, resets_at: null },
    seven_day_sonnet: { utilization: null, resets_at: null },
    limits: [
      scopedLimit("Fable", null),
      scopedLimit(" ", 50),
      { ...scopedLimit("Fable", 50), scope: null },
      { ...scopedLimit("Fable", 50), kind: "weekly_all" },
      scopedLimit("opus", 20),
      "junk",
    ],
  };
  assert.deepEqual(
    parseClaudeUsage(body).map((limit) => [limit.model, limit.used]),
    [
      [undefined, 6],
      [undefined, 19],
      ["opus", 20],
    ],
  );
});

test("a Claude reply without usage windows is rejected", () => {
  assert.throws(() => parseClaudeUsage({ error: "nope" }), LiveUsageError);
});

/** The shape ChatGPT returns behind /status in the Codex CLI, for a plan with bought credits. */
const codexUsage = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: 1_795_000_000,
    },
    secondary_window: {
      used_percent: 100,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: 1_795_100_000,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "2431.5" },
};

test("Codex usage maps to percent of its plan windows plus the credit balance", () => {
  assert.deepEqual(parseCodexUsage(codexUsage), [
    {
      window: "5h",
      metric: "percent",
      used: 42,
      limit: 100,
      remaining: 0.58,
      resetsAt: 1_795_000_000_000,
    },
    {
      window: "week",
      metric: "percent",
      used: 100,
      limit: 100,
      remaining: 0,
      resetsAt: 1_795_100_000_000,
    },
    { window: "balance", metric: "credits", used: 0, limit: 2431.5, remaining: 1, resetsAt: null },
  ]);
});

test("a Codex plan with no 5-hour window or no credits shows only what it has", () => {
  const body = structuredClone(codexUsage) as Record<string, unknown>;
  body.rate_limit = { ...codexUsage.rate_limit, primary_window: null };
  body.credits = { has_credits: false, unlimited: false, balance: "0" };
  assert.deepEqual(
    parseCodexUsage(body).map((limit) => [limit.window, limit.limit, limit.remaining]),
    [
      ["week", 100, 0],
      ["balance", 0, 0],
    ],
  );
  delete body.credits;
  assert.deepEqual(
    parseCodexUsage(body).map((limit) => limit.window),
    ["week"],
  );
});

test("unlimited Codex credits mean no limit applies", () => {
  const body = { ...codexUsage, credits: { has_credits: true, unlimited: true, balance: null } };
  assert.deepEqual(parseCodexUsage(body), []);
});

/** Per-model limits as Codex's usage reply lists them, after the plan's own windows. */
const sparkLimit = {
  limit_name: "gpt-5.3-codex-spark",
  metered_feature: "codex_bengalfox",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18_000,
      reset_after_seconds: 600,
      reset_at: 1_795_000_600,
    },
    secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: 0 },
  },
};

test("Codex's per-model limits are read with the model each one belongs to", () => {
  const body = { ...codexUsage, additional_rate_limits: [sparkLimit] };
  const limits = parseCodexUsage(body);
  assert.deepEqual(
    limits.map((limit) => [limit.model, limit.window]),
    [
      [undefined, "5h"],
      [undefined, "week"],
      [undefined, "balance"],
      ["gpt-5.3-codex-spark", "5h"],
      ["gpt-5.3-codex-spark", "week"],
    ],
  );
  assert.deepEqual(limits[3], {
    window: "5h",
    metric: "percent",
    used: 100,
    limit: 100,
    remaining: 0,
    resetsAt: 1_795_000_600_000,
    model: "gpt-5.3-codex-spark",
  });
  assert.equal(limits[4]?.resetsAt, null);
});

test("per-model limits with no name or no windows are left out", () => {
  const body = {
    ...codexUsage,
    additional_rate_limits: [
      { ...sparkLimit, limit_name: " " },
      { ...sparkLimit, limit_name: "gpt-6-luna", rate_limit: null },
      { ...sparkLimit, limit_name: "codex" },
      "junk",
    ],
  };
  assert.deepEqual(
    parseCodexUsage(body).map((limit) => limit.model),
    [undefined, undefined, undefined],
  );
});

test("per-model limits still apply when Codex credits are unlimited", () => {
  const body = {
    ...codexUsage,
    credits: { has_credits: true, unlimited: true, balance: null },
    additional_rate_limits: [sparkLimit],
  };
  assert.deepEqual(
    parseCodexUsage(body).map((limit) => [limit.model, limit.window]),
    [
      ["gpt-5.3-codex-spark", "5h"],
      ["gpt-5.3-codex-spark", "week"],
    ],
  );
});

test("a Codex reply without windows or credits is rejected", () => {
  assert.throws(() => parseCodexUsage({ detail: "Unauthorized" }), LiveUsageError);
});

const window = (remaining: number): LimitUsage => ({
  window: "5h",
  metric: "percent",
  used: (1 - remaining) * 100,
  limit: 100,
  remaining,
  resetsAt: null,
});
const balance = (left: number): LimitUsage => ({
  window: "balance",
  metric: "credits",
  used: 0,
  limit: left,
  remaining: left > 0 ? 1 : 0,
  resetsAt: null,
});

test("headroom is the tightest window, or full with no limits", () => {
  assert.equal(providerHeadroom([]), 1);
  assert.equal(providerHeadroom([window(0.6), window(0.25)]), 0.25);
});

test("a used-up plan window means no headroom, whatever credits are left", () => {
  assert.equal(providerHeadroom([window(0), balance(2431.5)]), 0);
  assert.equal(providerHeadroom([window(0), balance(0)]), 0);
});

test("credits never make a plan window look fuller than it is", () => {
  assert.equal(providerHeadroom([window(0.05), balance(2431.5)]), 0.05);
  assert.equal(providerHeadroom([window(0.5), balance(0)]), 0.5);
});

test("a credit balance alone sets headroom when there are no plan windows", () => {
  assert.equal(providerHeadroom([balance(2431.5)]), 1);
  assert.equal(providerHeadroom([balance(0)]), 0);
});

const modelWindow = (model: string, remaining: number): LimitUsage => ({
  ...window(remaining),
  model,
});

test("one model's used-up limit leaves the account's headroom alone", () => {
  assert.equal(providerHeadroom([window(0.6), modelWindow("gpt-5.3-codex-spark", 0)]), 0.6);
  assert.equal(providerHeadroom([modelWindow("gpt-5.3-codex-spark", 0)]), 1);
});

test("a model's headroom is its tightest own limit, matched without case, or null", () => {
  const limits = [
    window(0.2),
    modelWindow("GPT-5.3-Codex-Spark", 0.5),
    modelWindow("gpt-5.3-codex-spark", 0.1),
    modelWindow("gpt-6-luna", 0),
  ];
  assert.equal(modelHeadroom(limits, "gpt-5.3-codex-spark")?.remaining, 0.1);
  assert.equal(modelHeadroom(limits, "gpt-6-luna")?.remaining, 0);
  assert.equal(modelHeadroom(limits, "gpt-5.6-terra"), null);
});

test("a model family's limit covers every model id that names the family", () => {
  const fable = { ...modelWindow("Fable", 0), modelFamily: true };
  const limits = [window(0.5), fable, modelWindow("claude-haiku-5-5", 0.3)];
  assert.equal(modelHeadroom(limits, "claude-fable-5-2"), fable);
  assert.equal(modelHeadroom(limits, "CLAUDE-FABLE-5"), fable);
  assert.equal(modelHeadroom(limits, "claude-fable-5.2"), fable);
  assert.equal(modelHeadroom(limits, "claude-opus-5-5"), null);
  assert.equal(modelHeadroom(limits, "claude-fables-5"), null);
  assert.equal(modelHeadroom(limits, "claude-haiku-5-5")?.remaining, 0.3);
  assert.equal(providerHeadroom(limits), 0.5);
  // Without modelFamily, a one-word name must still match the whole id.
  assert.equal(modelHeadroom([modelWindow("spark", 0)], "gpt-5.3-codex-spark"), null);
});

const NOW = Date.UTC(2026, 10, 23, 12);
const signal = new AbortController().signal;

/** A fetch that records each request and answers with the given status and JSON body. */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const offline = (async () => {
  throw new TypeError("fetch failed");
}) as typeof globalThis.fetch;

/** Answers commands from a table, so no real CLI or keychain is touched. */
function fakeRun(outputs: Record<string, string | null> = {}) {
  const runs: string[] = [];
  const run = async (command: string, args: string[]) => {
    const line = [command, ...args].join(" ");
    runs.push(line);
    return outputs[line] ?? null;
  };
  return { run, runs };
}

const copilotAccount = makeAccount("ghcp", { liveUsage: { source: "copilot" } });

test("Copilot usage is read with a GitHub token from the environment", async () => {
  const { fetch, requests } = fakeFetch(200, copilotExhausted);
  const { run, runs } = fakeRun();
  const read = copilotReader({ fetch, run, env: { GH_TOKEN: "env-token" } });
  const [limit] = await read(copilotAccount, signal);
  assert.equal(limit?.metric, "credits");
  assert.equal(requests[0]?.url, "https://api.github.com/copilot_internal/user");
  assert.equal(requests[0]?.headers.authorization, "token env-token");
  assert.deepEqual(runs, []);
});

test("COPILOT_GITHUB_TOKEN wins over the other GitHub tokens, as in the Copilot CLI", async () => {
  const { fetch, requests } = fakeFetch(200, copilotExhausted);
  const env = { GITHUB_TOKEN: "c", GH_TOKEN: "b", COPILOT_GITHUB_TOKEN: "a" };
  await copilotReader({ fetch, run: fakeRun().run, env })(copilotAccount, signal);
  assert.equal(requests[0]?.headers.authorization, "token a");
});

test("Copilot usage falls back to the gh sign-in", async () => {
  const { fetch, requests } = fakeFetch(200, copilotExhausted);
  const { run } = fakeRun({ "gh auth token": "gh-token" });
  await copilotReader({ fetch, run, env: {} })(copilotAccount, signal);
  assert.equal(requests[0]?.headers.authorization, "token gh-token");
});

test("Copilot usage without any GitHub sign-in says how to add one", async () => {
  const { fetch } = fakeFetch(200, copilotExhausted);
  await assert.rejects(
    copilotReader({ fetch, run: fakeRun().run, env: {} })(copilotAccount, signal),
    { name: "LiveUsageError", message: /gh auth login/ },
  );
});

test("a rejected GitHub token and an outage are reported plainly", async () => {
  const env = { GH_TOKEN: "t" };
  const { run } = fakeRun();
  await assert.rejects(
    copilotReader({ fetch: fakeFetch(401, {}).fetch, run, env })(copilotAccount, signal),
    { name: "LiveUsageError", message: "GitHub rejected the token in GH_TOKEN" },
  );
  await assert.rejects(copilotReader({ fetch: offline, run, env })(copilotAccount, signal), {
    name: "LiveUsageError",
    message: /Could not reach GitHub/,
  });
});

const claudeAccount = (configDir?: string) =>
  makeAccount("max", { liveUsage: { source: "claude", configDir } });

function claudeFiles(files: Record<string, unknown>) {
  const reads: string[] = [];
  const readText = async (file: string) => {
    reads.push(file);
    return file in files ? JSON.stringify(files[file]) : null;
  };
  return { readText, reads };
}

const signIn = (accessToken: string, expiresAt = NOW + 3_600_000) => ({
  claudeAiOauth: { accessToken, refreshToken: "never-sent", expiresAt },
});

test("Claude usage is read with the Claude Code sign-in in the account's folder", async () => {
  const folder = path.join("profiles", "max");
  const { readText } = claudeFiles({ [path.join(folder, ".credentials.json")]: signIn("abc") });
  const { fetch, requests } = fakeFetch(200, claudeUsage);
  const read = claudeReader({ fetch, readText, run: fakeRun().run, now: () => NOW });
  const limits = await read(claudeAccount(folder), signal);
  assert.deepEqual(
    limits.map((limit) => [limit.window, limit.used]),
    [
      ["5h", 6],
      ["week", 19],
    ],
  );
  assert.equal(requests[0]?.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(requests[0]?.headers.authorization, "Bearer abc");
  assert.equal(requests[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("Claude usage without a folder reads the default ~/.claude sign-in", async () => {
  const home = path.join("home", "me");
  const { readText, reads } = claudeFiles({
    [path.join(home, ".claude", ".credentials.json")]: signIn("abc"),
  });
  const { fetch } = fakeFetch(200, claudeUsage);
  const read = claudeReader({ fetch, readText, homedir: () => home, now: () => NOW });
  await read(claudeAccount(), signal);
  assert.deepEqual(reads, [path.join(home, ".claude", ".credentials.json")]);
});

test("on macOS the default Claude sign-in comes from the keychain", async () => {
  const { readText } = claudeFiles({});
  const { run, runs } = fakeRun({
    "security find-generic-password -s Claude Code-credentials -w": JSON.stringify(signIn("kc")),
  });
  const { fetch, requests } = fakeFetch(200, claudeUsage);
  const read = claudeReader({ fetch, readText, run, platform: "darwin", now: () => NOW });
  await read(claudeAccount(), signal);
  assert.equal(runs.length, 1);
  assert.equal(requests[0]?.headers.authorization, "Bearer kc");
});

test("an expired Claude sign-in is not sent and says how to refresh it", async () => {
  const { readText } = claudeFiles({
    [path.join("p", ".credentials.json")]: signIn("old", NOW - 1),
  });
  const { fetch, requests } = fakeFetch(200, claudeUsage);
  const read = claudeReader({ fetch, readText, run: fakeRun().run, now: () => NOW });
  await assert.rejects(read(claudeAccount("p"), signal), {
    name: "LiveUsageError",
    message: /expired.*claude/i,
  });
  assert.equal(requests.length, 0);
});

test("a missing or rejected Claude sign-in is reported plainly", async () => {
  const run = fakeRun().run;
  const missing = claudeReader({
    fetch: fakeFetch(200, claudeUsage).fetch,
    readText: claudeFiles({}).readText,
    run,
    platform: "win32",
    now: () => NOW,
  });
  await assert.rejects(missing(claudeAccount("p"), signal), {
    name: "LiveUsageError",
    message: /No Claude Code sign-in/,
  });

  const rejected = claudeReader({
    fetch: fakeFetch(401, {}).fetch,
    readText: claudeFiles({ [path.join("p", ".credentials.json")]: signIn("abc") }).readText,
    run,
    now: () => NOW,
  });
  await assert.rejects(rejected(claudeAccount("p"), signal), {
    name: "LiveUsageError",
    message: /expired.*claude/i,
  });
});

const codexAccount = (configDir?: string) =>
  makeAccount("codex", {
    liveUsage: configDir ? { source: "codex", configDir } : { source: "codex" },
  });

/** An access token shaped like the JWT Codex stores, expiring at `exp` (ms). */
const jwt = (exp: number) =>
  `head.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url")}.sig`;

/** auth.json as `codex login` leaves it after a ChatGPT sign-in. */
const codexSignIn = (accessToken = jwt(NOW + 3_600_000)) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: accessToken,
    refresh_token: "never-sent",
    account_id: "acct-1",
  },
  last_refresh: "2026-11-23T11:00:00Z",
});

test("Codex usage is read with the ChatGPT sign-in in CODEX_HOME", async () => {
  const folder = path.join("profiles", "codex");
  const token = jwt(NOW + 3_600_000);
  const { readText } = claudeFiles({ [path.join(folder, "auth.json")]: codexSignIn(token) });
  const { fetch, requests } = fakeFetch(200, codexUsage);
  const read = codexReader({ fetch, readText, now: () => NOW });
  const limits = await read(codexAccount(folder), signal);
  assert.deepEqual(
    limits.map((limit) => limit.window),
    ["5h", "week", "balance"],
  );
  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requests[0]?.headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0]?.headers["chatgpt-account-id"], "acct-1");
});

test("Codex usage without a folder reads the default ~/.codex sign-in", async () => {
  const home = path.join("home", "me");
  const { readText, reads } = claudeFiles({
    [path.join(home, ".codex", "auth.json")]: codexSignIn(),
  });
  const read = codexReader({
    fetch: fakeFetch(200, codexUsage).fetch,
    readText,
    homedir: () => home,
    now: () => NOW,
  });
  await read(codexAccount(), signal);
  assert.deepEqual(reads, [path.join(home, ".codex", "auth.json")]);
});

test("a missing, API-key or expired Codex sign-in is not sent and says what to do", async () => {
  const { fetch, requests } = fakeFetch(200, codexUsage);
  const reader = (file: unknown) =>
    codexReader({
      fetch,
      readText: claudeFiles(file ? { [path.join("c", "auth.json")]: file } : {}).readText,
      now: () => NOW,
    })(codexAccount("c"), signal);

  await assert.rejects(reader(null), {
    name: "LiveUsageError",
    message: /No Codex sign-in.*codex login/,
  });
  await assert.rejects(reader({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null }), {
    name: "LiveUsageError",
    message: /API key.*codex login/,
  });
  await assert.rejects(reader(codexSignIn(jwt(NOW - 1000))), {
    name: "LiveUsageError",
    message: /expired.*codex/i,
  });
  assert.equal(requests.length, 0);
});

test("a rejected Codex sign-in and an outage are reported plainly", async () => {
  const files = claudeFiles({ [path.join("c", "auth.json")]: codexSignIn() }).readText;
  const read = (fetch: typeof globalThis.fetch) =>
    codexReader({ fetch, readText: files, now: () => NOW })(codexAccount("c"), signal);
  await assert.rejects(read(fakeFetch(401, {}).fetch), { message: /expired.*codex/i });
  await assert.rejects(read(fakeFetch(503, {}).fetch), { message: "OpenAI returned HTTP 503" });
  await assert.rejects(read(offline), { message: "Could not reach OpenAI" });
});

const rateLimited = (headers: Record<string, string> = {}) => fakeFetch(429, {}, headers).fetch;

test("a Claude 429 says usage checks are rate-limited and when to retry", async () => {
  const readText = claudeFiles({ [path.join("p", ".credentials.json")]: signIn("abc") }).readText;
  const read = (fetch: typeof globalThis.fetch) =>
    claudeReader({ fetch, readText, run: fakeRun().run, now: () => NOW })(
      claudeAccount("p"),
      signal,
    );

  const seconds = await read(rateLimited({ "retry-after": "120" })).catch((error) => error);
  assert.ok(seconds instanceof RateLimitError);
  assert.ok(seconds instanceof LiveUsageError);
  assert.match(seconds.message, /Claude is limiting how often usage can be checked/);
  assert.equal(seconds.retryAfterMs, 120_000);

  const date = new Date(NOW + 300_000).toUTCString();
  const dated = await read(rateLimited({ "retry-after": date })).catch((error) => error);
  assert.equal(dated.retryAfterMs, 300_000);

  const bare = await read(rateLimited()).catch((error) => error);
  assert.ok(bare instanceof RateLimitError);
  assert.equal(bare.retryAfterMs, null);
});

test("a 429 from GitHub or OpenAI is a rate limit too", async () => {
  const copilot = copilotReader({
    fetch: rateLimited({ "retry-after": "60" }),
    env: { GH_TOKEN: "t" },
  });
  const fromGitHub = await copilot(copilotAccount, signal).catch((error) => error);
  assert.ok(fromGitHub instanceof RateLimitError);
  assert.equal(fromGitHub.retryAfterMs, 60_000);

  const codex = codexReader({
    fetch: rateLimited(),
    readText: async () => JSON.stringify(codexSignIn()),
    now: () => NOW,
  });
  const fromOpenAI = await codex(codexAccount("c"), signal).catch((error) => error);
  assert.ok(fromOpenAI instanceof RateLimitError);
  assert.match(fromOpenAI.message, /OpenAI is limiting/);
});

/** A reader that answers from a queue, recording each call. */
function scriptedReader(answers: (LimitUsage[] | Error)[]) {
  let calls = 0;
  const reader: LiveReader = async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer as LimitUsage[];
  };
  return { reader, calls: () => calls };
}

const credits = (used: number): LimitUsage[] => [
  {
    window: "month",
    metric: "credits",
    used,
    limit: 100,
    remaining: 1 - used / 100,
    resetsAt: null,
  },
];

function clock(start = NOW) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

test("live usage is read at most once per refresh interval", async () => {
  const time = clock();
  const { reader, calls } = scriptedReader([credits(10), credits(20)]);
  const live = new LiveUsage({ copilot: reader }, { ttlMs: 60_000, now: time.now });
  await Promise.all([live.refresh([copilotAccount]), live.refresh([copilotAccount])]);
  assert.equal(calls(), 1);
  assert.deepEqual(live.get("ghcp"), {
    limits: credits(10),
    checkedAt: NOW,
    error: null,
    retryAt: null,
  });

  time.advance(30_000);
  await live.refresh([copilotAccount]);
  assert.equal(calls(), 1);
  time.advance(30_000);
  await live.refresh([copilotAccount]);
  assert.equal(live.get("ghcp").limits?.[0]?.used, 20);
});

test("a forced read skips the interval, as after switching billing source", async () => {
  const time = clock();
  const { reader, calls } = scriptedReader([credits(5000), credits(0)]);
  const live = new LiveUsage({ copilot: reader }, { ttlMs: 60_000, now: time.now });
  await live.refresh([copilotAccount]);
  time.advance(5_000);
  await live.refresh([copilotAccount], true);
  assert.equal(calls(), 2);
  assert.equal(live.get("ghcp").limits?.[0]?.used, 0);
});

test("a failed read keeps the last good numbers for a while and says why", async () => {
  const time = clock();
  const { reader } = scriptedReader([credits(10), new LiveUsageError("GitHub returned HTTP 502")]);
  const live = new LiveUsage({ copilot: reader }, { ttlMs: 0, maxAgeMs: 600_000, now: time.now });
  await live.refresh([copilotAccount]);
  time.advance(60_000);
  await live.refresh([copilotAccount]);
  assert.deepEqual(live.get("ghcp"), {
    limits: credits(10),
    checkedAt: NOW,
    error: "GitHub returned HTTP 502",
    retryAt: null,
  });

  time.advance(600_000);
  assert.equal(live.get("ghcp").limits, null);
});

const limited = (retryAfterMs: number | null = null) =>
  new RateLimitError("Claude is limiting how often usage can be checked", retryAfterMs);

test("a rate-limited account is not asked again, even when forced, until the retry time", async () => {
  const time = clock();
  const { reader, calls } = scriptedReader([credits(10), limited(600_000), credits(20)]);
  const live = new LiveUsage(
    { copilot: reader },
    { ttlMs: 60_000, maxAgeMs: 3_600_000, now: time.now },
  );
  await live.refresh([copilotAccount]);
  time.advance(60_000);
  await live.refresh([copilotAccount]);
  assert.deepEqual(live.get("ghcp"), {
    limits: credits(10),
    checkedAt: NOW,
    error: "Claude is limiting how often usage can be checked",
    retryAt: NOW + 660_000,
  });

  time.advance(300_000);
  await live.refresh([copilotAccount], true);
  assert.equal(calls(), 2);

  time.advance(300_000);
  await live.refresh([copilotAccount]);
  assert.equal(calls(), 3);
  assert.equal(live.get("ghcp").limits?.[0]?.used, 20);
  assert.equal(live.get("ghcp").retryAt, null);
  assert.equal(live.get("ghcp").error, null);
});

test("without a retry time, each 429 in a row doubles the wait, up to a cap", async () => {
  const time = clock();
  const { reader, calls } = scriptedReader([
    limited(),
    limited(),
    limited(),
    credits(1),
    limited(),
  ]);
  const live = new LiveUsage(
    { copilot: reader },
    { ttlMs: 60_000, maxBackoffMs: 200_000, now: time.now },
  );
  await live.refresh([copilotAccount]);
  assert.equal(live.get("ghcp").retryAt, NOW + 120_000);
  time.advance(120_000);
  await live.refresh([copilotAccount]);
  assert.equal(live.get("ghcp").retryAt, NOW + 120_000 + 200_000);
  time.advance(200_000);
  await live.refresh([copilotAccount]);
  assert.equal(calls(), 3);

  // A good read starts the doubling over.
  time.advance(200_000);
  await live.refresh([copilotAccount]);
  time.advance(60_000);
  await live.refresh([copilotAccount]);
  assert.equal(calls(), 5);
  assert.equal(live.get("ghcp").retryAt, time.now() + 120_000);
});

test("a retry time shorter than the refresh interval still waits the interval", async () => {
  const time = clock();
  const { reader } = scriptedReader([limited(1_000)]);
  const live = new LiveUsage({ copilot: reader }, { ttlMs: 60_000, now: time.now });
  await live.refresh([copilotAccount]);
  assert.equal(live.get("ghcp").retryAt, NOW + 60_000);
});

test("Claude usage is read every 5 minutes by default, other providers every minute", async () => {
  const time = clock();
  const claude = scriptedReader([credits(1)]);
  const copilot = scriptedReader([credits(1)]);
  const live = new LiveUsage({ claude: claude.reader, copilot: copilot.reader }, { now: time.now });
  const accounts = [claudeAccount("p"), copilotAccount];
  await live.refresh(accounts);
  time.advance(60_000);
  await live.refresh(accounts);
  assert.equal(claude.calls(), 1);
  assert.equal(copilot.calls(), 2);
  time.advance(240_000);
  await live.refresh(accounts);
  assert.equal(claude.calls(), 2);
});

test("a read that never answers times out instead of holding up the dashboard", async () => {
  const hang: LiveReader = () => new Promise(() => {});
  const live = new LiveUsage({ copilot: hang }, { timeoutMs: 5 });
  await live.refresh([copilotAccount]);
  assert.match(live.get("ghcp").error ?? "", /did not answer/);
});

test("accounts without live usage, or with no reader for it, are never read", async () => {
  const { reader, calls } = scriptedReader([credits(1)]);
  const live = new LiveUsage({ copilot: reader });
  await live.refresh([makeAccount("plain"), claudeAccount("p")]);
  assert.equal(calls(), 0);
  assert.deepEqual(live.get("plain"), {
    limits: null,
    checkedAt: null,
    error: null,
    retryAt: null,
  });
});
