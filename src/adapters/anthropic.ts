import Anthropic from "@anthropic-ai/sdk";
import { WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";
import { claudeCredential } from "../claude-auth.ts";
import { applyEffort } from "../effort.ts";
import { BackendError } from "../types.ts";
import type { Adapter, Effort, GenerateInput } from "../types.ts";
import { parseRetryAfter } from "./http.ts";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
const isClaudeEffort = (effort: Effort): effort is ClaudeEffort =>
  CLAUDE_EFFORTS.includes(effort as ClaudeEffort);

/** Models that accept the server-side refusal fallback. */
const HAS_SERVER_FALLBACK = /^claude-(opus-5(-5)?|sonnet-5-5|fable-5-[12])$/;

export function buildMessages({
  messages,
  attachments,
}: GenerateInput): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message, index) => {
    if (index !== messages.length - 1 || !attachments.length) {
      return { role: message.role, content: message.content };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const file of attachments) {
      if (IMAGE_TYPES.includes(file.mime as ImageType)) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: file.mime as ImageType, data: file.data },
        });
      } else if (file.mime === "application/pdf") {
        content.push({
          type: "document",
          title: file.name,
          source: { type: "base64", media_type: "application/pdf", data: file.data },
        });
      } else if (file.mime.startsWith("text/")) {
        const text = Buffer.from(file.data, "base64").toString("utf8");
        content.push({ type: "text", text: `File ${file.name}:\n${text}` });
      } else {
        throw new BackendError("unavailable", `Claude cannot read ${file.mime} files`);
      }
    }
    content.push({ type: "text", text: message.content });
    return { role: message.role, content };
  });
}

function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new BackendError("cancelled", "Request cancelled");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new BackendError(
      "rate_limit",
      error.message,
      parseRetryAfter(error.headers?.get("retry-after")),
    );
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    // An `ant auth login` token that has expired and can no longer be refreshed.
    error instanceof WorkloadIdentityError
  ) {
    return new BackendError("auth", error.message);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new BackendError("unavailable", error.message);
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new BackendError("bad_request", error.message);
  }
  if (error instanceof Anthropic.APIError) {
    return new BackendError("unavailable", error.message);
  }
  return new BackendError("unavailable", error instanceof Error ? error.message : "Claude failed");
}

export const anthropicAdapter: Adapter = async function* (backend, input) {
  const credential = claudeCredential(backend);
  if (credential.type === "none") throw new BackendError("auth", credential.reason);
  // Naming the profile keeps the SDK from reading ANTHROPIC_API_KEY or another credential instead.
  const client = new Anthropic(
    credential.type === "api-key"
      ? { apiKey: credential.apiKey, maxRetries: 1 }
      : { profile: credential.profile, maxRetries: 1 },
  );
  const { model, effort } = applyEffort(backend, input.effort);
  if (effort && !isClaudeEffort(effort)) {
    throw new BackendError("bad_request", `Claude does not accept ${effort} effort`);
  }
  // Models without effort levels, such as Haiku 4.5, take neither adaptive thinking nor effort.
  const thinking = effort
    ? { thinking: { type: "adaptive" as const }, output_config: { effort } }
    : {};

  try {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: input.maxOutputTokens ?? 64_000,
        ...thinking,
        ...(input.instructions?.trim() ? { system: input.instructions.trim() } : {}),
        messages: buildMessages(input),
        ...(HAS_SERVER_FALLBACK.test(model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal: input.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new BackendError("refused", "Claude declined this request");
    }
    yield {
      type: "usage",
      inputTokens:
        final.usage.input_tokens +
        (final.usage.cache_read_input_tokens ?? 0) +
        (final.usage.cache_creation_input_tokens ?? 0),
      outputTokens: final.usage.output_tokens,
    };
  } catch (error) {
    const failure = toBackendError(error);
    if (credential.type === "sign-in" && failure.kind === "auth") {
      throw new BackendError(
        "auth",
        `${failure.message} (run "ant auth login --profile ${credential.profile}" to sign in again)`,
      );
    }
    throw failure;
  }
};
