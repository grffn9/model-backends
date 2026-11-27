import { BackendError } from "../types.ts";

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function errorFromStatus(
  status: number,
  detail: string,
  retryAfter?: string | null,
): BackendError {
  const message = `HTTP ${status}: ${detail.replace(/\s+/g, " ").slice(0, 300)}`;
  if (status === 401 || status === 403) return new BackendError("auth", message);
  if (status === 402 || status === 429) {
    return new BackendError("rate_limit", message, parseRetryAfter(retryAfter));
  }
  if (status === 404 || status === 408 || status >= 500) {
    return new BackendError("unavailable", message);
  }
  return new BackendError("bad_request", message);
}

export function errorFromFetch(error: unknown, signal: AbortSignal): BackendError {
  if (error instanceof BackendError) return error;
  if (signal.aborted) return new BackendError("cancelled", "Request cancelled");
  return new BackendError(
    "unavailable",
    error instanceof Error ? error.message : "Network request failed",
  );
}

/** Yields the data payload of each server-sent event. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const reader = body.getReader();

  const takeLine = (line: string): string | null => {
    if (line === "") {
      const payload = data.length ? data.join("\n") : null;
      data = [];
      return payload;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      if (done) lines.push("");
      for (const line of lines) {
        const payload = takeLine(line);
        if (payload !== null) yield payload;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
