// ─────────────────────────────────────────────────────────────
// ModelCaller adapter — OpenAI-compatible /chat/completions
// ─────────────────────────────────────────────────────────────
// Every major provider exposes an OpenAI-compatible endpoint:
// OpenAI, Anthropic (api.anthropic.com/v1), Groq, Together, xAI,
// Mistral, Fireworks, and every self-hosted gateway. So a single
// Bearer-auth, SSE-streaming adapter covers the whole surface and
// keeps this package dependency-light (no provider SDKs).

import type { ModelCaller, TokenUsage } from "ai-consensus-core";
import type { LoadedConfig, ResolvedProvider } from "./config.js";

/**
 * Build a ModelCaller that routes each request to the correct provider
 * based on the config's `providerByParticipant` map. "judge" is a
 * synthetic participant id that the engine uses for the synthesizer.
 */
export function createOpenAICompatibleCaller(config: LoadedConfig): ModelCaller {
  return async (req) => {
    const providerId = config.providerByParticipant[req.participantId];
    if (!providerId) {
      throw new Error(
        `ai-consensus-mcp: no provider mapping for participant "${req.participantId}".`,
      );
    }
    const provider = config.providers[providerId];
    if (!provider) {
      throw new Error(
        `ai-consensus-mcp: provider "${providerId}" resolved for "${req.participantId}" was not loaded.`,
      );
    }

    return callOpenAICompatible({
      provider,
      modelId: req.modelId,
      system: req.system,
      user: req.user,
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      signal: req.signal,
      onToken: req.onToken,
    });
  };
}

interface CallParams {
  provider: ResolvedProvider;
  modelId: string;
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
  signal: AbortSignal | undefined;
  onToken: ((token: string) => void) | undefined;
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

async function callOpenAICompatible(params: CallParams): Promise<{
  content: string;
  usage?: TokenUsage;
}> {
  const { provider, modelId, system, user, temperature, maxOutputTokens, signal, onToken } =
    params;

  const url = `${provider.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${provider.apiKey}`,
    ...provider.extraHeaders,
  };

  const body = JSON.stringify({
    model: modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    max_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!res.ok || !res.body) {
    const errText = await safeText(res);
    throw new Error(
      `${provider.id}: HTTP ${res.status} ${res.statusText} from ${url}${
        errText ? ` — ${truncate(errText, 500)}` : ""
      }`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: TokenUsage | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trimStart();
        if (data === "[DONE]") continue;

        let parsed: StreamChunk;
        try {
          parsed = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }

        const token = parsed.choices?.[0]?.delta?.content;
        if (typeof token === "string" && token.length > 0) {
          content += token;
          onToken?.(token);
        }
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens:
              parsed.usage.total_tokens ??
              (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0),
          };
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (content.length === 0) {
    throw new Error(
      `${provider.id}: empty response from ${modelId} (no content chunks received).`,
    );
  }

  return usage ? { content, usage } : { content };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
