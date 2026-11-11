// Bring-your-own model: free OpenRouter models only (":free"), tried in order.
// The model is a red-team reviewer, not the decider:
//   - it sees the evidence table and the deterministic proposal,
//   - it must cite fact ids for every claim (claims citing unknown ids are dropped),
//   - numbers it quotes are checked against the cited facts,
//   - it may agree, downgrade (ENTER -> WATCH) or veto (-> PASS), never upgrade.
import { createHash } from "node:crypto";

export interface EvidenceRow {
  id: string; // F1, F2, ...
  symbol: string; // token or "MARKET"
  name: string;
  value: number | string;
  source: string; // "E4 data.technicals.rsi_14"
}

export interface Claim {
  claim: string;
  cites: string[];
  numbers_checked: boolean | null; // null = no numbers in claim
}

export interface Review {
  model: string | null;
  latency_ms: number;
  attempts: { model: string; error: string | null }[];
  action: "agree" | "downgrade" | "veto" | null;
  bull_case: Claim[];
  bear_case: Claim[];
  rationale: Claim[];
  would_change_mind: string[];
  dropped_claims: number;
  unverified_numbers: number;
  raw_sha256: string | null;
  error: string | null;
}

export function freeModels(): string[] {
  const list = (process.env.TENBIN_MODELS ?? "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Hard guarantee: only free models are ever called.
  return list.filter((m) => m.endsWith(":free"));
}

/** OpenRouter keys start with "sk-or-"; anything else is treated as not configured rather than sent upstream. */
export function modelKey(): string | null {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  return k && /^sk-or-[\w-]{20,}$/.test(k) ? k : null;
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

const NUM_RE = /-?\d+(?:\.\d+)?/g;

export function verifyClaims(raw: unknown, table: Map<string, EvidenceRow>): { claims: Claim[]; dropped: number; unverified: number } {
  const out: Claim[] = [];
  let dropped = 0;
  let unverified = 0;
  if (!Array.isArray(raw)) return { claims: out, dropped, unverified };
  for (const c of raw.slice(0, 6)) {
    const text = typeof c?.claim === "string" ? c.claim.trim().slice(0, 400) : "";
    const cites = Array.isArray(c?.cites) ? c.cites.filter((x: unknown) => typeof x === "string" && table.has(x)) : [];
    if (!text || cites.length === 0) {
      dropped++;
      continue;
    }
    // Numbers in the claim must match a cited value within 2% (or 0.5 absolute), else flagged.
    const WINDOWS = new Set([7, 14, 24]); // indicator windows like RSI(14) or 7d are labels, not measurements
    const nums: number[] = (text.match(NUM_RE) ?? []).map(Number).filter((n: number) => Math.abs(n) >= 1 && !WINDOWS.has(Math.abs(n)));
    const citedVals = cites.map((id: string) => table.get(id)!.value).filter((v: unknown): v is number => typeof v === "number");
    let checked: boolean | null = null;
    if (nums.length) {
      checked = nums.every((n: number) => citedVals.some((v: number) => Math.abs(Math.abs(v) - Math.abs(n)) <= Math.max(0.5, Math.abs(v) * 0.02))); // "a 12% drop" cites -12
      if (!checked) unverified++;
    }
    out.push({ claim: text, cites, numbers_checked: checked });
  }
  return { claims: out, dropped, unverified };
}

export function buildPrompt(table: EvidenceRow[], proposal: unknown): string {
  return [
    "You are the red-team reviewer for a PRACTICE (paper) buy-the-dip crypto agent. Nothing is ever traded.",
    "Below is an evidence table from RYO's live read-only research tools, and the deterministic policy's proposal.",
    "Rules: use ONLY the evidence table. Every claim must cite fact ids like F3. Do not invent numbers. If evidence is missing, say so.",
    "You may agree, downgrade (ENTER becomes WATCH) or veto (becomes PASS). You can never upgrade.",
    'Return ONLY JSON: {"action":"agree|downgrade|veto","bull_case":[{"claim":"...","cites":["F1"]}],"bear_case":[{"claim":"...","cites":["F2"]}],"rationale":[{"claim":"...","cites":["F1","F2"]}],"would_change_mind":["observable condition that would flip the call"]}',
    "Keep each list to at most 3 items and each claim under 30 words.",
    "",
    "EVIDENCE TABLE",
    ...table.map((r) => `${r.id} | ${r.symbol} | ${r.name} = ${typeof r.value === "number" ? +r.value.toPrecision(8) : JSON.stringify(r.value)} | ${r.source}`),
    "",
    "PROPOSAL",
    JSON.stringify(proposal),
  ].join("\n");
}

export async function review(table: EvidenceRow[], proposal: unknown, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<Review> {
  const f = opts.fetchImpl ?? fetch;
  const key = modelKey();
  const t0 = Date.now();
  const base: Review = { model: null, latency_ms: 0, attempts: [], action: null, bull_case: [], bear_case: [], rationale: [], would_change_mind: [], dropped_claims: 0, unverified_numbers: 0, raw_sha256: null, error: null };
  if (!key) return { ...base, error: "OPENROUTER_API_KEY missing or malformed; decision stands on the deterministic policy alone" };
  const map = new Map(table.map((r) => [r.id, r]));
  const prompt = buildPrompt(table, proposal);
  for (const model of freeModels()) {
    try {
      const res = await f("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Tenbin (RYO-CHAN Hackathon)" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 3000, temperature: 0.2, reasoning: { effort: "low" } }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      });
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (!res.ok || !content) {
        base.attempts.push({ model, error: body?.error?.message?.slice(0, 160) ?? `HTTP ${res.status} empty content` });
        continue;
      }
      const parsed = extractJson(content) as Record<string, unknown>;
      const action = parsed.action === "agree" || parsed.action === "downgrade" || parsed.action === "veto" ? parsed.action : null;
      if (!action) {
        base.attempts.push({ model, error: "no valid action in model JSON" });
        continue;
      }
      const bull = verifyClaims(parsed.bull_case, map);
      const bear = verifyClaims(parsed.bear_case, map);
      const rat = verifyClaims(parsed.rationale, map);
      base.attempts.push({ model, error: null });
      return {
        ...base,
        model,
        latency_ms: Date.now() - t0,
        action,
        bull_case: bull.claims,
        bear_case: bear.claims,
        rationale: rat.claims,
        would_change_mind: (Array.isArray(parsed.would_change_mind) ? parsed.would_change_mind : []).filter((s): s is string => typeof s === "string").slice(0, 4).map((s) => s.slice(0, 200)),
        dropped_claims: bull.dropped + bear.dropped + rat.dropped,
        unverified_numbers: bull.unverified + bear.unverified + rat.unverified,
        raw_sha256: createHash("sha256").update(content).digest("hex"),
      };
    } catch (e) {
      base.attempts.push({ model, error: String((e as Error).message ?? e).slice(0, 160) });
    }
  }
  return { ...base, latency_ms: Date.now() - t0, error: "every free model failed; decision stands on the deterministic policy alone" };
}
