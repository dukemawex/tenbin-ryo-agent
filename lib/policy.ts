// Deterministic practice-trade policy. Pure, no I/O, no model.
// The model may *veto* or *downgrade* what this policy proposes, never upgrade it.
import type { MarketFacts, NumFact, TokenFacts } from "./facts";

export type Verdict = "ENTER" | "WATCH" | "PASS" | "ABSTAIN";

export interface RuleHit {
  rule: string;
  passed: boolean | null; // null = could not be evaluated (missing evidence)
  detail: string;
  inputs: { name: string; value: number | string | null; evidence: string | null; path: string | null }[];
}

export interface Plan {
  entry: number;
  stop: number;
  target: number;
  size_usd: number;
  risk_usd: number;
  stop_atr_mult: number;
  r_multiple_target: number;
}

export interface TokenDecision {
  symbol: string;
  verdict: Verdict;
  dip_score: number; // 0..3
  quality: number; // 0..1 evidence quality
  rules: RuleHit[];
  plan: Plan | null;
  reasons: string[];
}

export const POLICY = {
  rsiOversold: 35,
  drawdown7dPct: -8,
  stopAtrMult: 1.5,
  targetR: 2,
  riskPerTradePct: 1,
  maxPositionPct: 20,
  minQualityToEnter: 0.6,
  extremeFear: 15,
  bearishVerdict: /\b(bear|bearish|avoid|sell|strong[_ ]sell|downtrend|negative)\b/i,
  riskOffRegime: /\b(risk[-_ ]?off|capitulation|crash|bear)\b/i,
} as const;

const inp = (name: string, f: NumFact | { value: string; evidence: string; path: string } | null) => ({
  name,
  value: f ? f.value : null,
  evidence: f ? f.evidence : null,
  path: f ? f.path : null,
});

export function evidenceQuality(t: TokenFacts, status: "ok" | "partial" | "unavailable" | "failed", dataMode: string | null): number {
  if (status === "failed" || status === "unavailable") return 0;
  if (dataMode === "simulated" || dataMode === "unknown") return 0; // simulated presented as live is the one thing we never accept
  const required = [t.price, t.rsi, t.atrPct, t.change7d];
  const have = required.filter(Boolean).length / required.length;
  const statusW = status === "ok" ? 1 : 0.6;
  const modeW = dataMode === "mixed" ? 0.85 : 1;
  return Math.round(have * statusW * modeW * 100) / 100;
}

export function regimeMultiplier(m: MarketFacts): { mult: number; rule: RuleHit } {
  const reasons: string[] = [];
  let mult = 1;
  if (m.fearGreed && m.fearGreed.value <= POLICY.extremeFear) {
    mult *= 0.5;
    reasons.push(`Fear & Greed ${m.fearGreed.value} ≤ ${POLICY.extremeFear}: extreme fear, half size`);
  }
  const reg = [m.regime?.value, m.sentimentRegime?.value].filter(Boolean).join(" / ");
  if (reg && POLICY.riskOffRegime.test(reg)) {
    mult *= 0.5;
    reasons.push(`regime "${reg}" reads risk-off, half size`);
  }
  if (!m.fearGreed && !m.regime && !m.sentimentRegime) {
    mult *= 0.5;
    reasons.push("no market regime evidence available, half size");
  }
  return {
    mult,
    rule: {
      rule: "regime_gate",
      passed: mult === 1 ? true : null,
      detail: reasons.length ? reasons.join("; ") : "regime evidence does not call for a size cut",
      inputs: [inp("fear_greed", m.fearGreed), inp("fear_greed_change_7d", m.fearGreedChange7d), inp("regime", m.regime), inp("sentiment_regime", m.sentimentRegime)],
    },
  };
}

export function decideToken(
  t: TokenFacts,
  ctx: { status: "ok" | "partial" | "unavailable" | "failed"; dataMode: string | null; deepVerdict: TokenFacts["verdict"]; equityUsd: number; regimeMult: number },
): TokenDecision {
  const rules: RuleHit[] = [];
  const reasons: string[] = [];
  const quality = evidenceQuality(t, ctx.status, ctx.dataMode);

  const oversold = t.rsi ? t.rsi.value <= POLICY.rsiOversold : null;
  rules.push({ rule: "rsi_oversold", passed: oversold, detail: t.rsi ? `RSI(14) ${t.rsi.value.toFixed(1)} vs ≤ ${POLICY.rsiOversold}` : "RSI missing", inputs: [inp("rsi_14", t.rsi)] });

  const dipped = t.change7d ? t.change7d.value <= POLICY.drawdown7dPct : null;
  rules.push({ rule: "seven_day_dip", passed: dipped, detail: t.change7d ? `7d ${t.change7d.value.toFixed(2)}% vs ≤ ${POLICY.drawdown7dPct}%` : "7d change missing", inputs: [inp("change_7d_pct", t.change7d)] });

  const bounce = t.change24h ? t.change24h.value > 0 : null;
  rules.push({ rule: "day_bounce_confirmation", passed: bounce, detail: t.change24h ? `24h ${t.change24h.value.toFixed(2)}% (needs > 0)` : "24h change missing", inputs: [inp("change_24h_pct", t.change24h)] });

  const dip_score = [oversold, dipped, bounce].filter((x) => x === true).length;

  const verdictText = ctx.deepVerdict?.value ?? t.verdict?.value ?? null;
  const vetoed = verdictText ? POLICY.bearishVerdict.test(verdictText) : null;
  rules.push({
    rule: "ryo_verdict_not_bearish",
    passed: vetoed == null ? null : !vetoed,
    detail: verdictText ? `RYO verdict "${verdictText}"` : "no RYO verdict available",
    inputs: [inp("verdict", ctx.deepVerdict ?? t.verdict)],
  });

  rules.push({ rule: "evidence_quality", passed: quality >= POLICY.minQualityToEnter, detail: `quality ${quality} vs ≥ ${POLICY.minQualityToEnter} (status ${ctx.status}, data_mode ${ctx.dataMode ?? "n/a"})`, inputs: [] });

  let verdict: Verdict;
  if (quality === 0 || !t.price) {
    verdict = "ABSTAIN";
    reasons.push(ctx.dataMode === "simulated" ? "RYO marked this data as simulated, so no decision is made on it" : "not enough live evidence to decide");
  } else if (vetoed) {
    verdict = "PASS";
    reasons.push(`RYO's own verdict is bearish ("${verdictText}")`);
  } else if (dip_score >= 2 && quality >= POLICY.minQualityToEnter && t.atrPct) {
    verdict = "ENTER";
    reasons.push(`dip score ${dip_score}/3 with evidence quality ${quality}`);
  } else if (dip_score >= 1) {
    verdict = "WATCH";
    reasons.push(`dip score ${dip_score}/3 is not enough to enter${!t.atrPct ? " (no ATR, so no stop can be set)" : ""}`);
  } else {
    verdict = "PASS";
    reasons.push("no dip signal");
  }

  let plan: Plan | null = null;
  if (verdict === "ENTER" && t.price && t.atrPct) {
    const entry = t.price.value;
    const stopDistPct = (t.atrPct.value * POLICY.stopAtrMult) / 100;
    const stop = entry * (1 - stopDistPct);
    const target = entry * (1 + stopDistPct * POLICY.targetR);
    const risk_usd = (ctx.equityUsd * POLICY.riskPerTradePct) / 100 * quality * ctx.regimeMult;
    const size_usd = Math.min(risk_usd / stopDistPct, (ctx.equityUsd * POLICY.maxPositionPct) / 100);
    plan = { entry, stop, target, size_usd: round2(size_usd), risk_usd: round2(Math.min(risk_usd, size_usd * stopDistPct)), stop_atr_mult: POLICY.stopAtrMult, r_multiple_target: POLICY.targetR };
    rules.push({ rule: "atr_sizing", passed: true, detail: `stop ${POLICY.stopAtrMult}×ATR (${(stopDistPct * 100).toFixed(2)}%), risk ${POLICY.riskPerTradePct}% × quality ${quality} × regime ${ctx.regimeMult}`, inputs: [inp("price", t.price), inp("atr_14_pct", t.atrPct)] });
  }
  return { symbol: t.symbol, verdict, dip_score, quality, rules, plan, reasons };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rank candidates: ENTER first, then by dip score, quality, and deeper RSI. */
export function rank(ds: TokenDecision[], facts: Map<string, TokenFacts>): TokenDecision[] {
  const order: Record<Verdict, number> = { ENTER: 0, WATCH: 1, PASS: 2, ABSTAIN: 3 };
  return [...ds].sort(
    (a, b) =>
      order[a.verdict] - order[b.verdict] ||
      b.dip_score - a.dip_score ||
      b.quality - a.quality ||
      (facts.get(a.symbol)?.rsi?.value ?? 100) - (facts.get(b.symbol)?.rsi?.value ?? 100),
  );
}

export interface Position {
  id: string;
  symbol: string;
  opened_at: string;
  opened_run: string;
  entry: number;
  stop: number;
  target: number;
  size_usd: number;
  status: "open" | "closed";
  closed_at?: string;
  closed_run?: string;
  exit_price?: number;
  exit_reason?: "stop" | "target" | "time" | "invalidated";
  pnl_usd?: number;
  evidence: string; // receipt-local evidence id for the entry price
}

export const MAX_HOLD_DAYS = 7;

/** Mark an open practice position against a fresh price. Returns the closed position, or null if still open. */
export function markPosition(p: Position, price: number, now: Date, runId: string): Position | null {
  let reason: Position["exit_reason"] | null = null;
  if (price <= p.stop) reason = "stop";
  else if (price >= p.target) reason = "target";
  else if (now.getTime() - Date.parse(p.opened_at) > MAX_HOLD_DAYS * 864e5) reason = "time";
  if (!reason) return null;
  const units = p.size_usd / p.entry;
  return { ...p, status: "closed", closed_at: now.toISOString(), closed_run: runId, exit_price: price, exit_reason: reason, pnl_usd: round2(units * (price - p.entry)) };
}
