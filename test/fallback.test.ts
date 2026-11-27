import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithFallback } from "../src/fallback.ts";
import type { FallbackOptions, RunEvent } from "../src/fallback.ts";
import { BackendError } from "../src/types.ts";
import type { Adapter } from "../src/types.ts";
import { UsageLedger } from "../src/usage.ts";
import { fails, makeAccount, makeBackend, replies } from "./helpers.ts";
import type { Script } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 27, 12);

function scripted(scripts: Record<string, Script>) {
  const calls: string[] = [];
  const adapter: Adapter = (backend, input) => {
    calls.push(backend.id);
    const script = scripts[backend.id];
    if (!script) throw new Error(`No script for ${backend.id}`);
    return script(input);
  };
  return { adapters: { openai: adapter }, calls };
}

async function run(
  options: Partial<FallbackOptions> & Pick<FallbackOptions, "backends" | "adapters">,
) {
  const events: RunEvent[] = [];
  for await (const event of runWithFallback({
    input: { messages: [{ role: "user", content: "hi" }], attachments: [] },
    env: {},
    hasCommand: () => true,
    now: () => NOW,
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

const text = (events: RunEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

test("the first backend that answers wins", async () => {
  const { adapters, calls } = scripted({ a: replies("from a"), b: replies("from b") });
  const events = await run({
    backends: [makeBackend({ id: "a" }), makeBackend({ id: "b" })],
    adapters,
  });
  assert.equal(text(events), "from a");
  assert.deepEqual(calls, ["a"]);
  assert.equal(events.at(-1)?.type, "done");
});

test("a limit falls back to the next backend and pauses the account until its reset", async () => {
  const ledger = new UsageLedger(":memory:");
  const accounts = new Map([
    ["one", makeAccount("one")],
    ["two", makeAccount("two")],
  ]);
  const backends = [
    makeBackend({ id: "a", account: "one" }),
    makeBackend({ id: "b", account: "two" }),
  ];
  const { adapters, calls } = scripted({
    a: fails(new BackendError("rate_limit", "Too many requests", 60_000)),
    b: replies("from b"),
  });
  const events = await run({ backends, adapters, accounts, ledger });
  assert.equal(text(events), "from b");
  assert.ok(events.some((event) => event.type === "fallback" && event.kind === "rate_limit"));
  assert.equal(ledger.headroom(makeAccount("one"), NOW).cooldownUntil, NOW + 60_000);

  // The next run skips the paused account without calling it.
  const again = await run({ backends, adapters, accounts, ledger });
  assert.equal(text(again), "from b");
  assert.deepEqual(calls, ["a", "b", "b"]);
  assert.ok(again.some((event) => event.type === "skip" && event.backend === "a"));
});

test("a per-model account pauses only the model that hit its limit", async () => {
  const ledger = new UsageLedger(":memory:");
  const accounts = new Map([["agy", makeAccount("agy", { limitScope: "model" })]]);
  const { adapters } = scripted({
    a: fails(new BackendError("rate_limit", "quota reached", 5_000)),
    b: replies("ok"),
  });
  await run({
    backends: [makeBackend({ id: "a", account: "agy" }), makeBackend({ id: "b", account: "agy" })],
    adapters,
    accounts,
    ledger,
  });
  assert.equal(ledger.modelCooldown("a", NOW)?.until, NOW + 5_000);
  assert.equal(ledger.headroom(makeAccount("agy"), NOW).cooldownUntil, null);
});

test("an account over a cap you set is skipped", async () => {
  const ledger = new UsageLedger(":memory:");
  const capped = makeAccount("api", { kind: "api", limits: [{ window: "month", usd: 1 }] });
  ledger.record({
    ts: NOW - 1000,
    account: "api",
    backend: "a",
    task: "chat",
    status: "ok",
    inputTokens: 0,
    outputTokens: 0,
    usd: 1.5,
    weight: 1,
    latencyMs: 1,
    estimated: false,
  });
  const { adapters, calls } = scripted({ a: replies("a"), b: replies("b") });
  await run({
    backends: [makeBackend({ id: "a", account: "api" }), makeBackend({ id: "b" })],
    adapters,
    accounts: new Map([
      ["api", capped],
      ["main", makeAccount("main")],
    ]),
    ledger,
  });
  assert.deepEqual(calls, ["b"]);
});

test("a backend missing its key is skipped with the reason", async () => {
  const { adapters, calls } = scripted({ b: replies("b") });
  const events = await run({
    backends: [makeBackend({ id: "a", requiresEnv: ["A_KEY"] }), makeBackend({ id: "b" })],
    adapters,
  });
  assert.deepEqual(calls, ["b"]);
  assert.deepEqual(events[0], { type: "skip", backend: "a", label: "a", reason: "Set A_KEY" });
});

test("a cancel stops the run instead of falling back", async () => {
  const { adapters, calls } = scripted({
    a: fails(new BackendError("cancelled", "Request cancelled")),
    b: replies("b"),
  });
  await assert.rejects(
    run({ backends: [makeBackend({ id: "a" }), makeBackend({ id: "b" })], adapters }),
    (error: BackendError) => error.kind === "cancelled",
  );
  assert.deepEqual(calls, ["a"]);
});

test("when every backend fails, the last failure is thrown", async () => {
  const { adapters } = scripted({ a: fails(new BackendError("auth", "Bad key")) });
  await assert.rejects(
    run({ backends: [makeBackend({ id: "a" })], adapters }),
    (error: BackendError) => error.kind === "auth",
  );
});

test("usage is priced and recorded without the prompt", async () => {
  const ledger = new UsageLedger(":memory:");
  const adapter: Adapter = async function* () {
    yield { type: "text", text: "hello" };
    yield { type: "usage", inputTokens: 1_000_000, outputTokens: 500_000 };
  };
  const events = await run({
    backends: [makeBackend({ id: "a", price: { input: 2, output: 10 } })],
    adapters: { openai: adapter },
    ledger,
    task: "code",
  });
  const done = events.at(-1);
  assert.equal(done?.type === "done" && done.usd, 7);
  const [call] = ledger.recent();
  assert.equal(call?.task, "code");
  assert.equal(call?.usd, 7);
  assert.ok(!JSON.stringify(call).includes("hi"));
});
