import { checkBackend, findCommand, lookupOnce } from "./availability.ts";
import { modelHeadroom, providerHeadroom } from "./live-usage.ts";
import type { LiveUsage } from "./live-usage.ts";
import { BackendError } from "./types.ts";
import type {
  Account,
  Adapter,
  Backend,
  FailureKind,
  GenerateInput,
  OutputEvent,
  StepEvent,
} from "./types.ts";
import type { UsageLedger } from "./usage.ts";

type Env = Record<string, string | undefined>;

/** How long a limit pauses an account or model when the provider gives no reset time. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export type RunEvent =
  | { type: "attempt"; backend: string; label: string }
  | { type: "skip"; backend: string; label: string; reason: string }
  | {
      type: "fallback";
      from: string;
      kind: FailureKind;
      reason: string;
      /** Text from the failed backend was already sent; the next one answers in full. */
      restart: boolean;
    }
  | StepEvent
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string }
  | {
      type: "done";
      backend: string;
      label: string;
      inputTokens: number;
      outputTokens: number;
      usd: number;
      latencyMs: number;
    };

export interface FallbackOptions {
  /** Tried in this order. */
  backends: Backend[];
  adapters: Record<string, Adapter>;
  input: Omit<GenerateInput, "signal"> & { signal?: AbortSignal };
  /** With accounts, backends over a cap you set or on cooldown are skipped. */
  accounts?: Map<string, Account>;
  /** Records each call (never the prompt) and remembers limit cooldowns between runs. */
  ledger?: UsageLedger;
  /** The provider's real usage. A used-up account or model is skipped. */
  live?: LiveUsage;
  /** A label for the ledger's task column, such as "chat". Never prompt text. */
  task?: string;
  env?: Env;
  hasCommand?: (command: string) => boolean;
  now?: () => number;
}

/** Failures worth trying the next backend for. A cancel stops the run. */
const FALLS_BACK: ReadonlySet<FailureKind> = new Set([
  "rate_limit",
  "auth",
  "unavailable",
  "timeout",
  "bad_request",
  "refused",
]);

function skipReason(backend: Backend, options: FallbackOptions, now: number): string | null {
  const account = options.accounts?.get(backend.account);
  if (options.ledger) {
    const model = options.ledger.modelCooldown(backend.id, now);
    if (model) return model.reason;
    if (account) {
      const headroom = options.ledger.headroom(account, now);
      if (headroom.cooldownUntil !== null) return headroom.cooldownReason ?? "Paused";
      if (headroom.limits.length && headroom.headroom <= 0)
        return "Your cap for this account is used up";
    }
  }
  if (account && options.live) {
    const limits = options.live.get(account.id).limits;
    if (limits) {
      if (providerHeadroom(limits) <= 0) return "The provider reports no usage left";
      const own = modelHeadroom(limits, backend.model);
      if (own && own.remaining <= 0) return "The provider reports no usage left for this model";
    }
  }
  return null;
}

/**
 * Runs a prompt on the first backend that can take it, falling back to the next on a limit,
 * a sign-in problem or an outage. A limit pauses the account (or, for limitScope "model", the
 * model) until the provider's reset time, so later runs skip it too.
 */
export async function* runWithFallback(options: FallbackOptions): AsyncGenerator<RunEvent> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const hasCommand = lookupOnce(
    options.hasCommand ?? ((command) => findCommand(command, env) !== null),
  );
  const signal = options.input.signal ?? new AbortController().signal;
  const input: GenerateInput = { ...options.input, signal };
  let lastError: BackendError | null = null;

  for (const backend of options.backends) {
    const check = checkBackend(backend, env, hasCommand);
    const reason = check.available ? skipReason(backend, options, now()) : check.reason;
    const adapter = options.adapters[backend.adapter];
    if (reason || !adapter) {
      const why = reason ?? `No adapter named ${backend.adapter}`;
      yield { type: "skip", backend: backend.id, label: backend.label, reason: why };
      continue;
    }

    yield { type: "attempt", backend: backend.id, label: backend.label };
    const started = now();
    let sent = false;
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const event of adapter(backend, input) as AsyncIterable<OutputEvent>) {
        if (event.type === "usage") {
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          continue;
        }
        if (event.type === "text" || event.type === "image") sent = true;
        yield event;
      }
    } catch (error) {
      const failure =
        error instanceof BackendError
          ? error
          : new BackendError("unavailable", error instanceof Error ? error.message : "Failed");
      record(options, backend, sent ? "partial" : failure.kind, usage, now() - started);
      if (failure.kind === "rate_limit") pause(options, backend, failure, now());
      if (!FALLS_BACK.has(failure.kind)) throw failure;
      lastError = failure;
      yield {
        type: "fallback",
        from: backend.id,
        kind: failure.kind,
        reason: failure.message,
        restart: sent,
      };
      continue;
    }

    const usd =
      (usage.inputTokens * backend.price.input + usage.outputTokens * backend.price.output) / 1e6;
    const latencyMs = now() - started;
    record(options, backend, "ok", usage, latencyMs);
    yield { type: "done", backend: backend.id, label: backend.label, ...usage, usd, latencyMs };
    return;
  }

  throw lastError ?? new BackendError("unavailable", "No backend is available");
}

function record(
  options: FallbackOptions,
  backend: Backend,
  status: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
): void {
  options.ledger?.record({
    ts: (options.now ?? Date.now)(),
    account: backend.account,
    backend: backend.id,
    task: options.task ?? "chat",
    status,
    ...usage,
    usd:
      (usage.inputTokens * backend.price.input + usage.outputTokens * backend.price.output) / 1e6,
    weight: 1,
    latencyMs,
    estimated: false,
  });
}

function pause(options: FallbackOptions, backend: Backend, failure: BackendError, now: number) {
  if (!options.ledger) return;
  const until = now + (failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
  const reason = `Limit reached: ${failure.message}`;
  if (options.accounts?.get(backend.account)?.limitScope === "model") {
    options.ledger.setModelCooldown(backend.id, until, reason);
  } else {
    options.ledger.setCooldown(backend.account, until, reason);
  }
}
