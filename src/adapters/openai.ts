import { applyEffort } from "../effort.ts";
import { BackendError } from "../types.ts";
import type { Adapter, GenerateInput } from "../types.ts";
import { errorFromFetch, errorFromStatus, readSse } from "./http.ts";

interface StreamChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

function buildMessages({ messages, attachments, instructions }: GenerateInput): unknown[] {
  const images = attachments.filter((file) => file.mime.startsWith("image/"));
  const turns = messages.map((message, index) => {
    if (index !== messages.length - 1 || !images.length) return message;
    return {
      role: message.role,
      content: [
        ...images.map((file) => ({
          type: "image_url",
          image_url: { url: `data:${file.mime};base64,${file.data}` },
        })),
        { type: "text", text: message.content },
      ],
    };
  });
  const system = instructions?.trim();
  return system ? [{ role: "system", content: system }, ...turns] : turns;
}

/** Works with any OpenAI-compatible host: DeepSeek, OpenRouter, Groq, Together and others. */
export const openaiAdapter: Adapter = async function* (backend, input) {
  const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : undefined;
  if (!apiKey) throw new BackendError("auth", `${backend.apiKeyEnv} is not set`);
  const { model, effort } = applyEffort(backend, input.effort);

  try {
    const response = await fetch(`${backend.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        // Extras go first so they can add fields but never replace the ones below.
        ...backend.extraBody,
        model,
        messages: buildMessages(input),
        stream: true,
        stream_options: { include_usage: true },
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
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

    for await (const payload of readSse(response.body)) {
      if (payload === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue; // Hosts may send keep-alive comments as data.
      }
      if (chunk.error) {
        throw new BackendError("unavailable", chunk.error.message ?? "Stream error");
      }
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield { type: "text", text };
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }
  } catch (error) {
    throw errorFromFetch(error, input.signal);
  }
};
