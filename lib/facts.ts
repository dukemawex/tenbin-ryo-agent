// Structural fact extraction from RYO envelopes. Pure functions.
//
// The `data` shape can evolve between tool versions, so each fact is matched
// against a priority list of plausible key names anywhere in the payload, and
// the exact JSON path it came from is recorded. Two rules:
//   1. A fact that is not found stays null. It becomes a visible gap. Nothing is defaulted.
//   2. Every number that is found carries its source: evidence id + JSON path.

export interface Fact<T = number | string> {
  value: T;
  evidence: string; // e.g. "E4"
  path: string; // e.g. "data.technicals.rsi_14"
}

export type NumFact = Fact<number> | null;
export type StrFact = Fact<string> | null;

type Walked = { key: string; path: string; value: unknown };

export function* walk(node: unknown, path = ""): Generator<Walked> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walk(node[i], `${path}[${i}]`);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      yield { key: k, path: here, value: v };
      yield* walk(v, here);
    }
  }
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "boolean" || v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "").replace(/^\$/, "").replace(/%$/, "");
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const depth = (p: string) => (p.match(/[.[]/g) ?? []).length;
const inHistory = (p: string) => /history|series|candles|ohlc|points|klines|sparkline/i.test(p);

/** Find the best match for any of `candidates` in `root`, preferring earlier candidates, then shallower paths. */
export function findNumber(root: unknown, candidates: readonly string[], evidence: string, prefix = "data"): NumFact {
  let best: { rank: number; d: number; path: string; value: number } | null = null;
  const lower = candidates.map((c) => c.toLowerCase());
  for (const w of walk(root, prefix)) {
    const rank = lower.indexOf(w.key.toLowerCase());
    if (rank < 0 || inHistory(w.path)) continue;
    const n = asNumber(w.value);
    if (n == null) continue;
    const d = depth(w.path);
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { rank, d, path: w.path, value: n };
  }
  return best ? { value: best.value, evidence, path: best.path } : null;
}

export function findString(root: unknown, candidates: readonly string[], evidence: string, prefix = "data"): StrFact {
  let best: { rank: number; d: number; path: string; value: string } | null = null;
  const lower = candidates.map((c) => c.toLowerCase());
  for (const w of walk(root, prefix)) {
    const rank = lower.indexOf(w.key.toLowerCase());
    if (rank < 0 || typeof w.value !== "string" || !w.value.trim()) continue;
    const d = depth(w.path);
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { rank, d, path: w.path, value: w.value.trim() };
  }
  return best ? { value: best.value, evidence, path: best.path } : null;
}

export const KEYS = {
  price: ["price_usd", "priceUsd", "current_price", "price", "last_price"],
  change24h: ["change_24h_pct", "price_change_24h_pct", "percent_change_24h", "change_24h", "price_change_percentage_24h", "pct_24h", "24h"],
  change7d: ["change_7d_pct", "price_change_7d_pct", "percent_change_7d", "change_7d", "price_change_percentage_7d", "pct_7d", "7d"],
  rsi: ["rsi_14", "rsi14", "rsi"],
  atrPct: ["atr_14_pct", "atr14_pct", "atr_pct", "atr_percent"],
  atrAbs: ["atr_14", "atr14", "atr"],
  volume: ["volume_24h_usd", "volume_24h", "total_volume", "volume"],
  marketCap: ["market_cap_usd", "market_cap", "marketcap"],
  fearGreed: ["fear_greed_value", "fear_and_greed", "fear_greed_index", "fear_greed", "fng_value", "fng"],
  fearGreedChange: ["fear_greed_change", "change", "delta"],
  verdict: ["verdict", "signal", "stance", "recommendation", "bias"],
  regime: ["regime", "market_regime", "phase", "market_phase", "sentiment_regime"],
} as const;

export interface TokenFacts {
  symbol: string;
  price: NumFact;
  change24h: NumFact;
  change7d: NumFact;
  rsi: NumFact;
  atrPct: NumFact; // ATR(14) as % of price (derived from absolute ATR when only that is published)
  volume: NumFact;
  marketCap: NumFact;
  verdict: StrFact;
  missing: string[];
  notes: string[];
}

export function tokenFacts(symbol: string, data: unknown, evidence: string): TokenFacts {
  const notes: string[] = [];
  const price = findNumber(data, KEYS.price, evidence);
  let atrPct = findNumber(data, KEYS.atrPct, evidence);
  if (!atrPct) {
    const atrAbs = findNumber(data, KEYS.atrAbs, evidence);
    if (atrAbs && price && price.value > 0) {
      // RYO publishes ATR either as % or absolute; derive % from the absolute value and price, recording both paths.
      atrPct = { value: (atrAbs.value / price.value) * 100, evidence, path: `${atrAbs.path} / ${price.path} * 100` };
      notes.push(`ATR% derived from absolute ATR (${atrAbs.path}) and price (${price.path})`);
    }
  }
  const f: TokenFacts = {
    symbol: symbol.toUpperCase(),
    price,
    change24h: findNumber(data, KEYS.change24h, evidence),
    change7d: findNumber(data, KEYS.change7d, evidence),
    rsi: findNumber(data, KEYS.rsi, evidence),
    atrPct,
    volume: findNumber(data, KEYS.volume, evidence),
    marketCap: findNumber(data, KEYS.marketCap, evidence),
    verdict: findString(data, KEYS.verdict, evidence),
    missing: [],
    notes,
  };
  if (f.rsi && (f.rsi.value < 0 || f.rsi.value > 100)) {
    notes.push(`RSI ${f.rsi.value} at ${f.rsi.path} is outside 0-100 and was discarded`);
    f.rsi = null;
  }
  for (const k of ["price", "change24h", "change7d", "rsi", "atrPct", "volume", "marketCap", "verdict"] as const) {
    if (f[k] == null) f.missing.push(k);
  }
  return f;
}

/** Symbols from scan_market: the first array of objects carrying a string `symbol` (or `ticker`). */
export function scanSymbols(data: unknown): { symbols: string[]; path: string | null } {
  const visit = (node: unknown, path: string): { symbols: string[]; path: string | null } | null => {
    if (Array.isArray(node)) {
      const syms = node
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>).symbol ?? (x as Record<string, unknown>).ticker : null))
        .filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9.$_-]{1,20}$/.test(s));
      if (syms.length) return { symbols: [...new Set(syms.map((s) => s.toUpperCase()))], path };
      for (let i = 0; i < node.length; i++) {
        const r = visit(node[i], `${path}[${i}]`);
        if (r) return r;
      }
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const r = visit(v, `${path}.${k}`);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(data, "data") ?? { symbols: [], path: null };
}

export interface MarketFacts {
  fearGreed: NumFact;
  fearGreedChange7d: NumFact;
  regime: StrFact;
  sentimentRegime: StrFact;
}

export function marketFacts(overview: { data: unknown; evidence: string } | null, shift: { data: unknown; evidence: string } | null): MarketFacts {
  return {
    fearGreed: overview ? findNumber(overview.data, KEYS.fearGreed, overview.evidence) : shift ? findNumber(shift.data, KEYS.fearGreed, shift.evidence) : null,
    fearGreedChange7d: shift ? findNumber(shift.data, ["fear_greed_change_7d", "fear_greed_change", "change_7d", "change", "delta"], shift.evidence) : null,
    regime: overview ? findString(overview.data, KEYS.regime, overview.evidence) : null,
    sentimentRegime: shift ? findString(shift.data, ["sentiment_regime", "combined_regime", "regime", "phase", "market_phase"], shift.evidence) : null,
  };
}

export const fmt = (f: NumFact, digits = 2, suffix = "") => (f ? `${f.value.toFixed(digits)}${suffix}` : "missing");
