// ─────────────────────────────────────────────────────────────
// HTTP request limits — bound provider spend per request and in flight
// ─────────────────────────────────────────────────────────────
// Every `tools/call` on this server can fan out into participants × rounds
// paid LLM calls. Over HTTP the caller is remote, so the server — not the
// caller — must bound: request size, calls per request, prompt size,
// requested output tokens, and how many calls run at once.

/** Matches the MCP SDK's own default request-body cap. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** ≈25k tokens — far above real prompts, far below a 4 MB body. */
export const DEFAULT_MAX_PROMPT_CHARS = 100_000;
/** Per-response output ceiling a caller may request via `maxOutputTokens`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
/** Concurrent tool calls per handler (≈ per Node process / Workers isolate). */
export const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 4;

export type BodyReadResult =
  { kind: "ok"; text: string } | { kind: "too-large" } | { kind: "error" };

/** Read a request body as UTF-8, refusing (and cancelling) past `maxBytes`. */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  if (!request.body) return { kind: "ok", text: "" };

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "error" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { kind: "ok", text: new TextDecoder().decode(bytes) };
}

export interface ToolCallPolicy {
  maxPromptChars: number;
  maxOutputTokens: number;
}

export type ToolCallInspection =
  | { kind: "none" }
  | { kind: "single"; id: string | number | null }
  | { kind: "reject"; status: number; code: number; message: string; id: string | number | null };

interface MaybeRequest {
  id?: unknown;
  method?: unknown;
  params?: { arguments?: Record<string, unknown> };
}

function isToolCall(msg: unknown): msg is MaybeRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as MaybeRequest).method === "tools/call" &&
    "id" in msg
  );
}

function rpcId(msg: MaybeRequest): string | number | null {
  return typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
}

/**
 * Classify a parsed JSON-RPC body for spend policy. Batches may not carry
 * `tools/call` (one costly call per request keeps the in-flight cap exact);
 * a single call's prompt / maxOutputTokens must sit under the ceilings.
 * Anything malformed is left for the MCP transport to reject.
 */
export function inspectToolCalls(body: unknown, policy: ToolCallPolicy): ToolCallInspection {
  if (Array.isArray(body)) {
    if (body.some(isToolCall)) {
      return {
        kind: "reject",
        status: 400,
        code: -32600,
        message:
          "Invalid Request: JSON-RPC batches containing tools/call are not accepted over HTTP; send one tools/call per request",
        id: null,
      };
    }
    return { kind: "none" };
  }
  if (!isToolCall(body)) return { kind: "none" };

  const id = rpcId(body);
  const args = body.params?.arguments ?? {};
  const prompt = args["prompt"];
  if (typeof prompt === "string" && prompt.length > policy.maxPromptChars) {
    return {
      kind: "reject",
      status: 400,
      code: -32602,
      message: `Invalid params: prompt is ${prompt.length} characters; this server accepts at most ${policy.maxPromptChars}`,
      id,
    };
  }
  const maxOutputTokens = args["maxOutputTokens"];
  if (typeof maxOutputTokens === "number" && maxOutputTokens > policy.maxOutputTokens) {
    return {
      kind: "reject",
      status: 400,
      code: -32602,
      message: `Invalid params: maxOutputTokens ${maxOutputTokens} exceeds this server's ceiling of ${policy.maxOutputTokens}`,
      id,
    };
  }
  return { kind: "single", id };
}

/** Counting semaphore without queueing: callers over the cap are refused. */
export class InFlightLimiter {
  private active = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxConcurrentToolCalls must be a positive integer (got ${max})`);
    }
  }

  /** Returns a one-shot release function, or undefined when at capacity. */
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.max) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  get inFlight(): number {
    return this.active;
  }
}
