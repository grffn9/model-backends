import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UsageLedger, windowStart } from "../src/usage.ts";
import type { CallRecord } from "../src/usage.ts";
import { makeAccount } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 23, 12);

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    ts: NOW,
    account: "main",
    backend: "b",
    task: "chat",
    status: "ok",
    inputTokens: 10,
    outputTokens: 20,
    usd: 0,
    weight: 1,
    latencyMs: 5,
    estimated: false,
    ...overrides,
  };
}

test("headroom reflects weighted requests inside the window", () => {
  const ledger = new UsageLedger(":memory:");
  const account = makeAccount("main", { limits: [{ window: "5h", requests: 10 }] });
  ledger.record(call({ weight: 3 }));
  ledger.record(call({ ts: NOW - 6 * 3_600_000, weight: 5 })); // Outside the window.
  assert.equal(ledger.headroom(account, NOW).headroom, 0.7);
  ledger.close();
});

test("failed calls with no output do not consume quota", () => {
  const ledger = new UsageLedger(":memory:");
  const account = makeAccount("main", { limits: [{ window: "day", requests: 2 }] });
  ledger.record(call({ status: "rate_limit" }));
  ledger.record(call({ status: "partial" }));
  assert.equal(ledger.headroom(account, NOW).headroom, 0.5);
  ledger.close();
});

test("the tightest limit sets headroom, across requests, tokens and dollars", () => {
  const ledger = new UsageLedger(":memory:");
  const account = makeAccount("main", {
    limits: [
      { window: "day", requests: 100 },
      { window: "month", usd: 1, tokens: 1000 },
    ],
  });
  ledger.record(call({ usd: 0.9, inputTokens: 100, outputTokens: 100 }));
  const usage = ledger.headroom(account, NOW);
  assert.ok(Math.abs(usage.headroom - 0.1) < 1e-9);
  assert.equal(usage.limits.length, 3);
  ledger.close();
});

test("monthly limits reset on the first of the month", () => {
  const ledger = new UsageLedger(":memory:");
  const account = makeAccount("main", { limits: [{ window: "month", requests: 2 }] });
  ledger.record(call({ ts: Date.UTC(2026, 9, 31, 23) }));
  ledger.record(call({ ts: Date.UTC(2026, 10, 1, 1) }));
  const usage = ledger.headroom(account, NOW);
  assert.equal(usage.headroom, 0.5);
  assert.equal(usage.limits[0]?.resetsAt, Date.UTC(2026, 11, 1));
  assert.equal(windowStart("month", NOW), Date.UTC(2026, 10, 1));
  ledger.close();
});

test("a model's own pause lasts until it expires, survives a restart and can be cleared", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "model-backends-ledger-"));
  const file = path.join(folder, "usage.sqlite");
  try {
    const ledger = new UsageLedger(file);
    ledger.setModelCooldown("agy-flash", NOW + 1000, "Provider limit reached");
    ledger.close();

    const reopened = new UsageLedger(file);
    assert.deepEqual(reopened.modelCooldown("agy-flash", NOW), {
      until: NOW + 1000,
      reason: "Provider limit reached",
    });
    assert.equal(reopened.modelCooldown("agy-flash", NOW + 2000), null);
    assert.equal(reopened.modelCooldown("agy-opus", NOW), null);
    assert.equal(reopened.headroom(makeAccount("main"), NOW).cooldownUntil, null);
    reopened.clearModelCooldowns(["agy-flash"]);
    assert.equal(reopened.modelCooldown("agy-flash", NOW), null);
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("cooldowns apply until they expire and can be cleared", () => {
  const ledger = new UsageLedger(":memory:");
  const account = makeAccount("main");
  ledger.setCooldown("main", NOW + 1000, "Provider limit reached");
  assert.equal(ledger.headroom(account, NOW).cooldownUntil, NOW + 1000);
  assert.equal(ledger.headroom(account, NOW + 2000).cooldownUntil, null);
  ledger.clearCooldown("main");
  assert.equal(ledger.headroom(account, NOW).cooldownUntil, null);
  ledger.close();
});
