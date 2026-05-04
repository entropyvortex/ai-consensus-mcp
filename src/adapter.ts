// ─────────────────────────────────────────────────────────────
// ModelCaller adapters — OpenAI-compatible HTTP + MCP host sampling
// ─────────────────────────────────────────────────────────────
// Every major provider exposes an OpenAI-compatible endpoint:
// OpenAI, Anthropic (api.anthropic.com/v1), Groq, Together, xAI,
// Mistral, Fireworks, and every self-hosted gateway. So a single
// Bearer-auth, SSE-streaming adapter covers the whole surface and
// keeps this package dependency-light (no provider SDKs).
//
// On top of that, this module exposes a sampling-backed caller that
// uses MCP `sampling/createMessage` to ask the *calling host* (Claude
// Code, Cursor, Windsurf, etc.) to answer as a participant. This lets
// the human's coding agent take a seat at the consensus roundtable
// without configuring an extra provider.
//
// `createRoutedCaller` is the public entry point: it picks per-call
// between sampling (if the participant is in the host-sample set) and
// HTTP (otherwise).

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ModelCaller,
  ModelCallRequest,
  ModelCallResponse,
  TokenUsage,
} from "ai-consensus-core";
import type { HostSampleMeta, ResolvedProvider } from "./config.js";

// ── SamplingError ────────────────────────────────────────────
// callViaSampling has four distinct failure modes. Surfacing them as a
// typed Error lets callers branch on `code` instead of pattern-matching
// the message; `cause` carries the original host error so debuggers can
// walk the chain.

export type SamplingErrorCode =
  | "missing-entry" // routing bug — participant marked host-sample but no meta exists
  | "host-error" // server.createMessage() rejected (often: user denied sampling)
  | "unsupported-content" // host returned a non-text content block
  | "empty-response"; // host returned text, but the string is empty

export class SamplingError extends Error {
  readonly code: SamplingErrorCode;
  readonly participantId: string;
  /** Set only when `code === "unsupported-content"`. */
  readonly contentType?: string;

  constructor(args: {
    code: SamplingErrorCode;
    participantId: string;
    message: string;
    cause?: unknown;
    contentType?: string;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "SamplingError";
    this.code = args.code;
    this.participantId = args.participantId;
    if (args.contentType !== undefined) this.contentType = args.contentType;
  }
}

/**
 * Build a ModelCaller that routes each request to the correct provider
 * based on a `providerByParticipant` map. "judge" is a synthetic
 * participant id that the engine uses for the synthesizer.
 *
 * The provider map is taken per-call (not closed over the full LoadedConfig)
 * because preset runs may resolve a different participant set than the user's
 * raw config — the map handed in here is the authoritative routing for *this*
 * specific run.
 */
export function createOpenAICompatibleCaller(args: {
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
}): ModelCaller {
  const { providers, providerByParticipant } = args;
  return async (req) => {
    const providerId = providerByParticipant[req.participantId];
    if (!providerId) {
      throw new Error(
        `ai-consensus-mcp: no provider mapping for participant "${req.participantId}".`,
      );
    }
    const provider = providers[providerId];
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

/**
 * Build a ModelCaller that answers via MCP `sampling/createMessage`.
 *
 * The active `Server` instance is the bridge to whatever host invoked the
 * tool: when this caller fires, the host's LLM (whichever model it happens
 * to be running — Claude, Codex, etc.) receives the persona system prompt
 * plus the engine-built user prompt, and its completion comes back as the
 * participant's response.
 *
 * The host owns the model. We forward `modelHint` only as a soft preference
 * — hosts are free to ignore it. Streaming-token forwarding isn't part of
 * MCP sampling today, so `onToken` is left unused (the engine already drops
 * token-level events in this server).
 */
export function createSamplingCaller(args: {
  server: Server;
  hostSampleParticipants: Record<string, HostSampleMeta>;
}): ModelCaller {
  const { server, hostSampleParticipants } = args;
  return async (req) => {
    const meta = hostSampleParticipants[req.participantId];
    if (!meta) {
      throw new SamplingError({
        code: "missing-entry",
        participantId: req.participantId,
        message: `ai-consensus-mcp: participant "${req.participantId}" was routed to sampling but has no host-sample entry.`,
      });
    }
    return callViaSampling({ server, req, meta });
  };
}

/**
 * Build a ModelCaller that routes per-participant: host-sample participants
 * go to MCP sampling, everyone else to the OpenAI-compatible HTTP adapter.
 * The judge (synthetic id `"judge"`) always routes to its provider.
 */
export function createRoutedCaller(args: {
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
  hostSampleParticipants: Record<string, HostSampleMeta>;
  server: Server;
}): ModelCaller {
  const httpCaller = createOpenAICompatibleCaller({
    providers: args.providers,
    providerByParticipant: args.providerByParticipant,
  });
  const samplingCaller = createSamplingCaller({
    server: args.server,
    hostSampleParticipants: args.hostSampleParticipants,
  });
  return (req) => {
    if (args.hostSampleParticipants[req.participantId]) {
      return samplingCaller(req);
    }
    return httpCaller(req);
  };
}

interface SamplingCallArgs {
  server: Server;
  req: ModelCallRequest;
  meta: HostSampleMeta;
}

async function callViaSampling(args: SamplingCallArgs): Promise<ModelCallResponse> {
  const { server, req, meta } = args;

  // MCP sampling carries the system prompt as a top-level field, not as a
  // message. Hosts that respect it inject it into their own model call;
  // hosts that don't get the same content as a leading user message via
  // model context, which is degraded but not wrong.
  const params = {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: req.user },
      },
    ],
    systemPrompt: req.system,
    maxTokens: req.maxOutputTokens,
    temperature: req.temperature,
    ...(meta.modelHint ? { modelPreferences: { hints: [{ name: meta.modelHint }] } } : {}),
  };

  const requestOptions = req.signal ? { signal: req.signal } : undefined;

  let result;
  try {
    result = await server.createMessage(params, requestOptions);
  } catch (err) {
    throw new SamplingError({
      code: "host-error",
      participantId: req.participantId,
      cause: err,
      message: `ai-consensus-mcp: host sampling failed for participant "${req.participantId}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  // We never request tools, so the response is `CreateMessageResult` whose
  // `content` is a single discriminated block (text / image / audio). Only
  // text is meaningful for consensus; non-text blocks surface as an error
  // so the engine records the participant call as failed rather than crashing.
  if (result.content.type !== "text") {
    throw new SamplingError({
      code: "unsupported-content",
      participantId: req.participantId,
      contentType: result.content.type,
      message: `ai-consensus-mcp: host sampling for participant "${req.participantId}" returned a "${result.content.type}" block; only text is supported.`,
    });
  }
  const content = result.content.text;
  if (content.length === 0) {
    throw new SamplingError({
      code: "empty-response",
      participantId: req.participantId,
      message: `ai-consensus-mcp: host sampling returned no text for participant "${req.participantId}".`,
    });
  }

  return { content };
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
  choices?: {
    delta?: { content?: string | null };
  }[];
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
  const { provider, modelId, system, user, temperature, maxOutputTokens, signal, onToken } = params;

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

  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
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
    throw new Error(`${provider.id}: empty response from ${modelId} (no content chunks received).`);
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
