import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConnections, parseConnections } from "../src/config.ts";

const example = path.resolve(import.meta.dirname, "..", "examples", "connections.yaml");

test("the example config parses, with one backend for every built-in adapter", () => {
  const { accounts, backends } = loadConnections(example, {});
  assert.ok(accounts.size >= 5);
  const adapters = new Set(backends.map((backend) => backend.adapter));
  for (const name of ["copilot", "agy", "claude-cli", "codex", "openai", "gemini", "anthropic"]) {
    assert.ok(adapters.has(name), name);
  }
});

test("the example config carries no guessed limit for any subscription", () => {
  const { accounts } = loadConnections(example, {});
  for (const account of accounts.values()) {
    if (account.kind === "subscription") assert.deepEqual(account.limits, [], account.id);
  }
});

test("variables expand, CLIs get their default command and keys become required", () => {
  const source = [
    "accounts: { a: { kind: api }, s: {} }",
    "backends:",
    '  - { id: o, account: a, adapter: openai, model: "${MODEL:-m1}", baseUrl: "https://x.test/v1/", apiKeyEnv: K }',
    '  - { id: c, account: s, adapter: claude-cli, model: m, env: { CLAUDE_CONFIG_DIR: "${DIR}" } }',
  ].join("\n");
  const { backends } = parseConnections(source, { DIR: "/home/me/.claude-2" });
  const [openai, cli] = backends;
  assert.equal(openai?.model, "m1");
  assert.equal(openai?.baseUrl, "https://x.test/v1");
  assert.deepEqual(openai?.requiresEnv, ["K"]);
  assert.equal(cli?.command, "claude");
  assert.equal(cli?.env.CLAUDE_CONFIG_DIR, "/home/me/.claude-2");
});

test("fields the package does not read are kept for the app", () => {
  const { extras, root } = parseConnections(
    [
      "router: { reserve: 0.1 }",
      "accounts: { a: {} }",
      "backends:",
      "  - { id: c, account: a, adapter: copilot, model: m, skills: { code: 8 } }",
    ].join("\n"),
    {},
  );
  assert.deepEqual(extras.get("c"), { skills: { code: 8 } });
  assert.deepEqual(root.router, { reserve: 0.1 });
});

test("an app can register its own adapter names", () => {
  const source = "accounts: { a: {} }\nbackends: [{ id: x, account: a, adapter: mine, model: m }]";
  assert.throws(() => parseConnections(source, {}), ConfigError);
  assert.equal(parseConnections(source, {}, { adapters: ["mine"] }).backends[0]?.adapter, "mine");
});

test("mistakes are reported with where they are", () => {
  const bad = (backends: string) => () =>
    parseConnections(`accounts: { a: { kind: api } }\nbackends: ${backends}`, {});
  assert.throws(bad("[]"), /at least one backend/);
  assert.throws(bad("[{ id: x, account: nope, adapter: openai }]"), /unknown account nope/);
  assert.throws(bad("[{ id: x, account: a, adapter: openai, apiKeyEnv: K }]"), /needs baseUrl/);
  assert.throws(bad("[{ id: x, account: a, adapter: gemini }]"), /needs apiKeyEnv/);
  assert.throws(
    bad("[{ id: x, account: a, adapter: codex, model: m }, { id: x, account: a, adapter: codex }]"),
    /duplicate backend id x/,
  );
  assert.throws(bad('[{ id: x, account: a, adapter: agy, model: "m-{effort}" }]'), /needs efforts/);
  assert.throws(
    () => parseConnections("accounts: { a: { limits: [{ window: month }] } }\nbackends: []", {}),
    /needs requests, tokens or usd/,
  );
});
