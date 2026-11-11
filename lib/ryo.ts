// RYO research-layer client (REST). Read-only by construction: the only POST is
// `tools/<name>/call`, which is how RYO's REST contract *reads* a tool.
//
// Coping with failure is a first-class feature here:
//  - per-attempt timeout, exponential backoff with full jitter
//  - honours Retry-After and X-RateLimit-* headers
//  - never retries 4xx argument errors (except 408/429)
//  - every attempt is recorded in a CallRecord so the receipt shows exactly what happened
//  - a body that is not the documented envelope is reported as a failure, never guessed at
import { createHash } from "node:crypto";

export const TOOLS = [
  "market_overview",
  "scan_market",
  "analyze_token",
  "deep_analysis",
  "compare_tokens",
  "monitor_market_sentiment_shift",
] as const;
export type ToolName = (typeof TOOLS)[number];

export type EnvelopeStatus = "ok" | "partial" | "unavailable";
export type DataMode = "live" | "mixed" | "simulated" | "unknown";

export interface Envelope {
  schema_version?: string;
  tool: string;
  status: EnvelopeStatus;
  data_mode: DataMode;
  as_of?: string | null;
  request?: Record<string, unknown>;
  data: unknown;
  summary?: { headline?: string; key_points?: string[]; [k: string]: unknown } | null;
  availability?: Record<string, unknown> | null;
  warnings?: unknown[] | null;
}

export interface Attempt {
  n: number;
  http_status: number | null;
  error: string | null;
  waited_ms: number;
  latency_ms: number;
  trace_id: string | null;
}

export interface CallRecord {
  id: string; // short evidence id used in receipts, e.g. "E3"
  tool: ToolName;
  args: Record<string, unknown>;
  outcome: "ok" | "partial" | "unavailable" | "failed";
  data_mode: DataMode | null;
  as_of: string | null;
  fetched_at: string;
  attempts: Attempt[];
  rate_limit: { limit: number | null; remaining: number | null; reset: string | null };
  body_sha256: string | null;
  headline: string | null;
  warnings: string[];
  error: string | null;
}

export interface CallResult {
  record: CallRecord;
  envelope: Envelope | null;
}

export interface RyoClientOptions {
  baseUrl?: string;
  key?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

export class MissingCredentialError extends Error {
  constructor() {
    super("RYO_MCP_KEY is not set. Live runs need the builder credential issued by the hackathon organiser.");
    this.name = "MissingCredentialError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.tool === "string" &&
    (o.status === "ok" || o.status === "partial" || o.status === "unavailable") &&
    typeof o.data_mode === "string" &&
    "data" in o
  );
}

/** REST wraps the envelope as {tool, result, latency_ms}; MCP text content is the envelope itself. */
export function unwrapEnvelope(body: unknown): Envelope | null {
  if (isEnvelope(body)) return body;
  if (body && typeof body === "object" && "result" in body) {
    const r = (body as { result: unknown }).result;
    if (isEnvelope(r)) return r;
  }
  return null;
}

function num(h: string | null): number | null {
  if (h == null) return null;
  const n = Number(h);
  return Number.isFinite(n) ? n : null;
}

/** Retry-After may be seconds or an HTTP date. */
export function retryAfterMs(h: string | null, now: Date): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now.getTime()) : null;
}

export class RyoClient {
  readonly baseUrl: string;
  private readonly key: string | undefined;
  private readonly f: typeof fetch;
  private readonly o: Required<Omit<RyoClientOptions, "baseUrl" | "key" | "fetchImpl">>;
  private seq = 0;
  readonly calls: CallRecord[] = [];

  constructor(opts: RyoClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.RYO_MCP_URL ?? "https://app-ryochan.com/api/mcp").replace(/\/+$/, "");
    this.key = opts.key ?? process.env.RYO_MCP_KEY ?? undefined;
    this.f = opts.fetchImpl ?? fetch;
    this.o = {
      maxAttempts: opts.maxAttempts ?? 4,
      timeoutMs: opts.timeoutMs ?? 45_000,
      baseDelayMs: opts.baseDelayMs ?? 800,
      maxDelayMs: opts.maxDelayMs ?? 20_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      now: opts.now ?? (() => new Date()),
    };
  }

  get hasKey(): boolean {
    return !!this.key && this.key.trim().length > 0;
  }

  /** Unauthenticated health probe. */
  async health(): Promise<{ ok: boolean; body: unknown; http_status: number | null; error: string | null }> {
    try {
      const res = await this.f(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => null);
      return { ok: res.ok && (body as { status?: string })?.status === "ok", body, http_status: res.status, error: null };
    } catch (e) {
      return { ok: false, body: null, http_status: null, error: String((e as Error).message ?? e) };
    }
  }

  /** Quota and identity; does not spend tool-call quota. Never returns the key itself. */
  async whoami(): Promise<{ ok: boolean; quota: unknown; tools: unknown; http_status: number | null; error: string | null }> {
    if (!this.hasKey) throw new MissingCredentialError();
    try {
      const res = await this.f(`${this.baseUrl}/whoami`, {
        headers: { Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return {
        ok: res.ok,
        quota: body?.quota ?? null,
        tools: body?.tools ?? null,
        http_status: res.status,
        error: res.ok ? null : String((body as { code?: string })?.code ?? res.statusText),
      };
    } catch (e) {
      return { ok: false, quota: null, tools: null, http_status: null, error: String((e as Error).message ?? e) };
    }
  }

  async call(tool: ToolName, args: Record<string, unknown> = {}): Promise<CallResult> {
    if (!this.hasKey) throw new MissingCredentialError();
    const id = `E${++this.seq}`;
    const attempts: Attempt[] = [];
    const record: CallRecord = {
      id,
      tool,
      args,
      outcome: "failed",
      data_mode: null,
      as_of: null,
      fetched_at: this.o.now().toISOString(),
      attempts,
      rate_limit: { limit: null, remaining: null, reset: null },
      body_sha256: null,
      headline: null,
      warnings: [],
      error: null,
    };
    let envelope: Envelope | null = null;
    let waited = 0;

    for (let n = 1; n <= this.o.maxAttempts; n++) {
      const t0 = Date.now();
      let status: number | null = null;
      let retryHint: number | null = null;
      try {
        const res = await this.f(`${this.baseUrl}/tools/${tool}/call`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        status = res.status;
        record.rate_limit = {
          limit: num(res.headers.get("x-ratelimit-limit")),
          remaining: num(res.headers.get("x-ratelimit-remaining")),
          reset: res.headers.get("x-ratelimit-reset"),
        };
        retryHint = retryAfterMs(res.headers.get("retry-after"), this.o.now());
        const text = await res.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        const trace = (body as { trace_id?: string } | null)?.trace_id ?? null;
        if (res.ok) {
          const env = unwrapEnvelope(body);
          if (env) {
            envelope = env;
            record.body_sha256 = createHash("sha256").update(text).digest("hex");
            attempts.push({ n, http_status: status, error: null, waited_ms: waited, latency_ms: Date.now() - t0, trace_id: trace });
            break;
          }
          attempts.push({ n, http_status: status, error: "response is not a RYO envelope", waited_ms: waited, latency_ms: Date.now() - t0, trace_id: trace });
          record.error = "response is not a RYO envelope";
          break; // a malformed 200 will not fix itself on retry
        }
        const code = (body as { code?: string; message?: string } | null)?.code ?? res.statusText;
        attempts.push({ n, http_status: status, error: String(code), waited_ms: waited, latency_ms: Date.now() - t0, trace_id: trace });
        record.error = `HTTP ${status} ${code}`;
        if (!RETRYABLE.has(status)) break; // 400/401/403/404: retrying will not help
      } catch (e) {
        const msg = String((e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message ?? e);
        attempts.push({ n, http_status: status, error: msg, waited_ms: waited, latency_ms: Date.now() - t0, trace_id: null });
        record.error = msg;
      }
      if (n < this.o.maxAttempts) {
        const backoff = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (n - 1));
        const jittered = Math.floor(this.o.random() * backoff);
        const wait = retryHint != null ? Math.min(this.o.maxDelayMs * 3, Math.max(retryHint, jittered)) : jittered;
        waited = wait;
        await this.o.sleep(wait);
      }
    }

    if (envelope) {
      record.outcome = envelope.status;
      record.data_mode = (["live", "mixed", "simulated", "unknown"].includes(envelope.data_mode) ? envelope.data_mode : "unknown") as DataMode;
      record.as_of = envelope.as_of ?? null;
      record.headline = typeof envelope.summary?.headline === "string" ? envelope.summary.headline : null;
      record.warnings = (envelope.warnings ?? []).map((w) => (typeof w === "string" ? w : JSON.stringify(w))).slice(0, 12);
      record.error = null;
    }
    this.calls.push(record);
    return { record, envelope };
  }
}
