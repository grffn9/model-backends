import { applyEffort } from "../effort.ts";
import { BackendError } from "../types.ts";
import type { Adapter, GenerateInput } from "../types.ts";
import { errorFromFetch, errorFromStatus, readSse } from "./http.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface StreamChunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

function buildContents({ messages, attachments }: GenerateInput): unknown[] {
  return messages.map((message, index) => {
    const parts: Part[] = [];
    if (index === messages.length - 1) {
      for (const file of attachments) {
        parts.push({ inlineData: { mimeType: file.mime, data: file.data } });
      }
    }
    parts.push({ text: message.content });
    return { role: message.role === "assistant" ? "model" : "user", parts };
  });
}

export const geminiAdapter: Adapter = async function* (backend, input) {
  const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : undefined;
  if (!apiKey) throw new BackendError("auth", `${backend.apiKeyEnv} is not set`);
  const { model, effort } = applyEffort(backend, input.effort);
  const generationConfig: Record<string, unknown> = {};
  if (input.images) generationConfig.responseModalities = ["TEXT", "IMAGE"];
  if (input.maxOutputTokens) generationConfig.maxOutputTokens = input.maxOutputTokens;
  if (effort) generationConfig.thinkingConfig = { thinkingLevel: effort };

  try {
    const url = `${BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        ...(input.instructions?.trim()
          ? { systemInstruction: { parts: [{ text: input.instructions.trim() }] } }
          : {}),
        contents: buildContents(input),
        generationConfig,
      }),
      signal: input.signal,
    });
    if (!response.ok || !response.body) {
      throw errorFromStatus(
        response.status,
        await response.text(),
        response.headers.get("retry-after"),
      );
    }

    let usage: { inputTokens: number; outputTokens: number } | null = null;
    for await (const payload of readSse(response.body)) {
      const chunk = JSON.parse(payload) as StreamChunk;
      if (chunk.error) {
        throw new BackendError("unavailable", chunk.error.message ?? "Stream error");
      }
      if (chunk.promptFeedback?.blockReason) {
        throw new BackendError("refused", `Blocked by Gemini: ${chunk.promptFeedback.blockReason}`);
      }
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.text) yield { type: "text", text: part.text };
        if (part.inlineData) {
          yield { type: "image", mime: part.inlineData.mimeType, data: part.inlineData.data };
        }
      }
      if (candidate?.finishReason === "SAFETY") {
        throw new BackendError("refused", "Blocked by Gemini safety filters");
      }
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    }
    if (usage) yield { type: "usage", ...usage };
  } catch (error) {
    throw errorFromFetch(error, input.signal);
  }
};
