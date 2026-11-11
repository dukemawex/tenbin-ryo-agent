// One agent run: gather evidence from all six RYO tools, decide with a deterministic policy,
// let a free model red-team the pick, record practice trades, and seal a hash-chained receipt.
import { randomBytes } from "node:crypto";
import { MissingCredentialError, RyoClient, type CallResult } from "./ryo";
import { fmt, marketFacts, scanSymbols, tokenFacts, findString, type TokenFacts } from "./facts";
import { decideToken, markPosition, rank, regimeMultiplier, round2, type Position, type TokenDecision, type Verdict } from "./policy";
import { review as modelReview, type EvidenceRow, type Review } from "./llm";
import { sealReceipt, type ChangeItem, type Receipt } from "./receipt";
import type { LedgerState, Store } from "./store";

export interface RunOptions {
  store: Store;
  client?: RyoClient;
  shortlist?: number;
  deepCount?: number;
  equityUsd?: number;
  maxOpen?: number;
  skipModel?: boolean;
  now?: () => Date;
  log?: (s: string) => void;
}

type State = LedgerState & { last_shortlist?: string[] };

export async function runAgent(opts: RunOptions): Promise<Receipt> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const client = opts.client ?? new RyoClient();
  if (!client.hasKey) throw new MissingCredentialError();
  const N = opts.shortlist ?? Number(process.env.TENBIN_SHORTLIST ?? 5);
  const equity = opts.equityUsd ?? Number(process.env.TENBIN_PAPER_EQUITY_USD ?? 10000);
  const started = now();
  const id = `run_${started.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;

  if (!(await opts.store.lock(280))) throw new Error("another run is in progress (ledger lock held)");
  try {
    const state = (await opts.store.load()) as State;
    const prev = state.index[0] ? await opts.store.receipt(state.index[0].id) : null;

    log("health + quota");
    const health = await client.health();
    const who = await client.whoami();

    // 1. Market context: two independent tools, so one failing does not block the other.
    log("market_overview + monitor_market_sentiment_shift");
    const [ov, shift] = await Promise.all([client.call("market_overview"), client.call("monitor_market_sentiment_shift", { time_window: "7d" })]);
    const usable = (r: CallResult) => (r.envelope && r.record.outcome !== "unavailable" && r.record.data_mode !== "simulated" ? r : null);
    const mf = marketFacts(
      usable(ov) ? { data: ov.envelope!.data, evidence: ov.record.id } : null,
      usable(shift) ? { data: shift.envelope!.data, evidence: shift.record.id } : null,
    );
    const regime = regimeMultiplier(mf);

    // 2. Shortlist from scan_market; on failure fall back to the previous run's shortlist (and say so).
    log("scan_market");
    const scan = await client.call("scan_market", { top_n: N });
    let shortlist: string[] = [];
    let shortlistSource: string | null = null;
    if (usable(scan)) {
      const s = scanSymbols(scan.envelope!.data);
      shortlist = s.symbols.slice(0, N);
      shortlistSource = s.path ? `${scan.record.id} ${s.path}` : null;
    }
    if (!shortlist.length && state.last_shortlist?.length) {
      shortlist = state.last_shortlist.slice(0, N);
      shortlistSource = `scan_market unavailable (${scan.record.error ?? scan.record.outcome}); reused previous run's shortlist`;
    }
    const openSyms = state.positions.filter((p) => p.status === "open").map((p) => p.symbol);
    const candidates = [...new Set([...shortlist, ...openSyms])];

    // 3. Quick read on every candidate.
    const facts = new Map<string, TokenFacts>();
    const analyses = new Map<string, CallResult>();
    for (const sym of candidates) {
      log(`analyze_token ${sym}`);
      const r = await client.call("analyze_token", { symbol: sym });
      analyses.set(sym, r);
      facts.set(sym, r.envelope ? tokenFacts(sym, r.envelope.data, r.record.id) : tokenFacts(sym, null, r.record.id));
    }
    const decide = (sym: string, deepVerdict: TokenFacts["verdict"] = null) => {
      const r = analyses.get(sym)!;
      return decideToken(facts.get(sym)!, { status: r.record.outcome, dataMode: r.record.data_mode, deepVerdict, equityUsd: equity, regimeMult: regime.mult });
    };
    let decisions: TokenDecision[] = rank(shortlist.map((s) => decide(s)), facts);

    // 4. Deep evidence only on the finalists (budget-aware), merged into the facts.
    const finalists = decisions.filter((d) => d.verdict === "ENTER" || d.verdict === "WATCH").slice(0, opts.deepCount ?? 2);
    const deepVerdicts = new Map<string, TokenFacts["verdict"]>();
    for (const d of finalists) {
      log(`deep_analysis ${d.symbol}`);
      const r = await client.call("deep_analysis", { symbol: d.symbol, include_perp: true });
      if (usable(r)) {
        const deep = tokenFacts(d.symbol, r.envelope!.data, r.record.id);
        const base = facts.get(d.symbol)!;
        for (const k of ["price", "change24h", "change7d", "rsi", "atrPct", "volume", "marketCap"] as const) if (!base[k] && deep[k]) (base as unknown as Record<string, unknown>)[k] = deep[k];
        base.missing = base.missing.filter((k) => !(base as unknown as Record<string, unknown>)[k]);
        deepVerdicts.set(d.symbol, findString(r.envelope!.data, ["verdict", "overall_verdict", "signal", "stance", "bias"], r.record.id));
      }
    }
    decisions = rank(shortlist.map((s) => decide(s, deepVerdicts.get(s) ?? null)), facts);

    // 5. Head-to-head on the top candidates (2-4) for the model's context.
    let compareHeadline: { value: string; evidence: string } | null = null;
    const top = decisions.filter((d) => d.verdict !== "ABSTAIN").slice(0, 3).map((d) => d.symbol);
    if (top.length >= 2) {
      log(`compare_tokens ${top.join(", ")}`);
      const c = await client.call("compare_tokens", { symbols: top.join(", "), intent: "swing" });
      if (usable(c) && c.record.headline) compareHeadline = { value: c.record.headline, evidence: c.record.id };
    }

    // 6. Mark open practice positions.
    const closed: Position[] = [];
    let positions = state.positions.filter((p) => p.status === "open");
    for (const p of [...positions]) {
      const price = facts.get(p.symbol)?.price;
      if (!price) continue; // no fresh price: position stays open, and the receipt shows the gap
      const c = markPosition(p, price.value, now(), id);
      if (c) {
        closed.push(c);
        positions = positions.filter((x) => x.id !== p.id);
      }
    }

    // 7. Evidence table for the model and the receipt.
    const evidence: EvidenceRow[] = [];
    const add = (symbol: string, name: string, f: { value: number | string; evidence: string; path: string } | null) => {
      if (!f) return;
      evidence.push({ id: `F${evidence.length + 1}`, symbol, name, value: f.value, source: `${f.evidence} ${f.path}` });
    };
    add("MARKET", "fear_greed", mf.fearGreed);
    add("MARKET", "fear_greed_change_7d", mf.fearGreedChange7d);
    add("MARKET", "regime", mf.regime);
    add("MARKET", "sentiment_regime", mf.sentimentRegime);
    if (compareHeadline) evidence.push({ id: `F${evidence.length + 1}`, symbol: top.join("/"), name: "compare_tokens_headline", value: compareHeadline.value, source: `${compareHeadline.evidence} summary.headline` });
    for (const d of decisions) {
      const t = facts.get(d.symbol)!;
      add(d.symbol, "price_usd", t.price);
      add(d.symbol, "rsi_14", t.rsi);
      add(d.symbol, "change_24h_pct", t.change24h);
      add(d.symbol, "change_7d_pct", t.change7d);
      add(d.symbol, "atr_14_pct", t.atrPct);
      add(d.symbol, "ryo_verdict", deepVerdicts.get(d.symbol) ?? t.verdict);
      const hl = analyses.get(d.symbol)?.record.headline;
      if (hl) evidence.push({ id: `F${evidence.length + 1}`, symbol: d.symbol, name: "ryo_headline", value: hl, source: `${analyses.get(d.symbol)!.record.id} summary.headline` });
    }

    // 8. Model red-team on the pick (ENTER, else best WATCH). It may only downgrade or veto.
    const pickD = decisions.find((d) => d.verdict === "ENTER") ?? decisions.find((d) => d.verdict === "WATCH") ?? null;
    let rv: Review | null = null;
    if (pickD && !opts.skipModel) {
      log(`model review ${pickD.symbol}`);
      rv = await modelReview(evidence, { symbol: pickD.symbol, verdict: pickD.verdict, dip_score: pickD.dip_score, quality: pickD.quality, reasons: pickD.reasons, plan: pickD.plan, rules: pickD.rules.map((r) => ({ rule: r.rule, passed: r.passed, detail: r.detail })) });
    }
    const finalOf = (d: TokenDecision): Verdict => {
      if (!rv || !pickD || d.symbol !== pickD.symbol || !rv.action || rv.action === "agree") return d.verdict;
      if (rv.action === "veto") return d.verdict === "ABSTAIN" ? "ABSTAIN" : "PASS";
      return d.verdict === "ENTER" ? "WATCH" : d.verdict;
    };
    const finalDecisions = decisions.map((d) => ({ ...d, model_action: pickD && d.symbol === pickD.symbol ? rv?.action ?? null : null, final: finalOf(d) }));

    // 9. Open a practice position for a final ENTER (max open positions, one per symbol).
    const opened: Position[] = [];
    const maxOpen = opts.maxOpen ?? 3;
    for (const d of finalDecisions) {
      if (d.final !== "ENTER" || !d.plan) continue;
      if (positions.length >= maxOpen || positions.some((p) => p.symbol === d.symbol)) continue;
      const p: Position = { id: `${id}:${d.symbol}`, symbol: d.symbol, opened_at: now().toISOString(), opened_run: id, entry: d.plan.entry, stop: d.plan.stop, target: d.plan.target, size_usd: d.plan.size_usd, status: "open", evidence: facts.get(d.symbol)!.price!.evidence };
      opened.push(p);
      positions.push(p);
    }
    const realized = round2(state.realized_pnl_usd + closed.reduce((s, p) => s + (p.pnl_usd ?? 0), 0));

    // 10. What changed since the last run, sorted by importance.
    const changes = diff(prev, { finalDecisions, opened, closed, mf, calls: client.calls, shortlist });

    const pick = finalDecisions.find((d) => d.final === "ENTER") ?? finalDecisions.find((d) => d.final === "WATCH") ?? null;
    const failed = client.calls.filter((c) => c.outcome === "failed" || c.outcome === "unavailable").length;
    const degraded = client.calls.filter((c) => c.outcome === "partial" || c.data_mode === "mixed" || c.data_mode === "simulated").length;
    const headline = headlineFor(pick, facts, finalDecisions.length, failed, closed);

    const receipt = sealReceipt({
      id,
      version: 1,
      started_at: started.toISOString(),
      finished_at: now().toISOString(),
      mode: "live",
      ryo: { base_url: client.baseUrl, health: health.body, quota: who.quota, calls: client.calls, calls_failed: failed, calls_degraded: degraded },
      market: { rule: regime.rule, size_multiplier: regime.mult },
      shortlist: { symbols: shortlist, source: shortlistSource },
      evidence,
      decisions: finalDecisions,
      review: rv,
      pick: pick ? { symbol: pick.symbol, verdict: pick.final } : null,
      ledger: { opened, closed, open_after: positions, equity_usd: round2(equity + realized), realized_pnl_usd: realized },
      changes,
      headline,
      prev_hash: state.head,
    });

    const all = [...state.positions.filter((p) => p.status === "closed"), ...closed, ...positions];
    const next: State = {
      positions: all.slice(-200),
      index: [{ id, at: receipt.finished_at, headline, hash: receipt.hash, pick: pick ? `${pick.final} ${pick.symbol}` : null }, ...state.index].slice(0, 200),
      head: receipt.hash,
      realized_pnl_usd: realized,
      last_shortlist: shortlist.length ? shortlist : state.last_shortlist,
    };
    await opts.store.save(receipt, next);
    return receipt;
  } finally {
    await opts.store.unlock();
  }
}

function headlineFor(pick: { symbol: string; final: Verdict; dip_score: number } | null, facts: Map<string, TokenFacts>, n: number, failed: number, closed: Position[]): string {
  const tail = [closed.length ? `${closed.length} practice position(s) closed` : "", failed ? `${failed} RYO call(s) failed` : ""].filter(Boolean).join("; ");
  if (!pick) return `No practice entry across ${n} candidates${tail ? `; ${tail}` : ""}`;
  const t = facts.get(pick.symbol)!;
  return `${pick.final} ${pick.symbol} (practice): RSI ${fmt(t.rsi, 1)}, 7d ${fmt(t.change7d, 1, "%")}, dip ${pick.dip_score}/3${tail ? `; ${tail}` : ""}`;
}

export function diff(
  prev: Receipt | null,
  cur: { finalDecisions: (TokenDecision & { final: Verdict })[]; opened: Position[]; closed: Position[]; mf: ReturnType<typeof marketFacts>; calls: RyoClient["calls"]; shortlist: string[] },
): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const p of cur.closed)
    out.push({ importance: 100, kind: "position_closed", symbol: p.symbol, text: `Practice ${p.symbol} closed on ${p.exit_reason} at ${p.exit_price} (P&L ${p.pnl_usd} USD paper)`, cites: [p.evidence] });
  for (const p of cur.opened)
    out.push({ importance: 90, kind: "position_opened", symbol: p.symbol, text: `Practice ${p.symbol} opened at ${p.entry}, stop ${p.stop.toPrecision(6)}, target ${p.target.toPrecision(6)}, size ${p.size_usd} USD paper`, cites: [p.evidence] });
  const prevV = new Map((prev?.decisions ?? []).map((d) => [d.symbol, d.final]));
  for (const d of cur.finalDecisions) {
    const before = prevV.get(d.symbol);
    if (before && before !== d.final) {
      const up = (v: Verdict) => ({ ENTER: 3, WATCH: 2, PASS: 1, ABSTAIN: 0 })[v];
      out.push({ importance: 70 + (up(d.final) - up(before)) * 2, kind: "verdict_flip", symbol: d.symbol, text: `${d.symbol}: ${before} → ${d.final} (${d.reasons.join("; ")})`, cites: d.rules.flatMap((r) => r.inputs.map((i) => i.evidence).filter((x): x is string => !!x)).slice(0, 4) });
    } else if (!before && prev) {
      out.push({ importance: 30, kind: "new_candidate", symbol: d.symbol, text: `${d.symbol} entered the shortlist as ${d.final}`, cites: [] });
    }
  }
  if (prev) for (const s of prev.shortlist.symbols) if (!cur.shortlist.includes(s)) out.push({ importance: 20, kind: "dropped_candidate", symbol: s, text: `${s} left the shortlist`, cites: [] });
  const prevFg = prev?.evidence.find((e) => e.symbol === "MARKET" && e.name === "fear_greed")?.value;
  if (typeof prevFg === "number" && cur.mf.fearGreed && Math.abs(cur.mf.fearGreed.value - prevFg) >= 5)
    out.push({ importance: 60, kind: "regime_shift", symbol: null, text: `Fear & Greed moved ${prevFg} → ${cur.mf.fearGreed.value}`, cites: [cur.mf.fearGreed.evidence] });
  const bad = cur.calls.filter((c) => c.outcome === "failed" || c.outcome === "unavailable" || c.data_mode === "simulated");
  if (bad.length)
    out.push({ importance: 50, kind: "degraded", symbol: null, text: `${bad.length} RYO call(s) degraded: ${bad.map((c) => `${c.tool}${c.args.symbol ? ` ${c.args.symbol}` : ""} (${c.error ?? c.outcome}${c.data_mode === "simulated" ? ", simulated" : ""})`).join(", ")}`, cites: bad.map((c) => c.id) });
  return out.sort((a, b) => b.importance - a.importance);
}
