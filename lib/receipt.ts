import { createHash } from "node:crypto";
import type { CallRecord } from "./ryo";
import type { EvidenceRow, Review } from "./llm";
import type { Position, RuleHit, TokenDecision, Verdict } from "./policy";

export interface ChangeItem {
  importance: number; // higher = more important; the dashboard sorts by this
  kind: "position_closed" | "position_opened" | "verdict_flip" | "regime_shift" | "degraded" | "new_candidate" | "dropped_candidate";
  symbol: string | null;
  text: string;
  cites: string[]; // evidence ids (E#) or fact ids (F#)
}

export interface Receipt {
  id: string; // run id
  version: 1;
  started_at: string;
  finished_at: string;
  mode: "live";
  ryo: { base_url: string; health: unknown; quota: unknown; calls: CallRecord[]; calls_failed: number; calls_degraded: number };
  market: { rule: RuleHit; size_multiplier: number };
  shortlist: { symbols: string[]; source: string | null };
  evidence: EvidenceRow[];
  decisions: (TokenDecision & { model_action: Review["action"]; final: Verdict })[];
  review: Review | null;
  pick: { symbol: string; verdict: Verdict } | null;
  ledger: { opened: Position[]; closed: Position[]; open_after: Position[]; equity_usd: number; realized_pnl_usd: number };
  changes: ChangeItem[];
  headline: string;
  prev_hash: string | null;
  hash: string;
}

export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x as object)
      .sort()
      .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x ?? null);
}

export function sealReceipt(r: Omit<Receipt, "hash">): Receipt {
  const hash = createHash("sha256").update(canonical(r)).digest("hex");
  return { ...r, hash };
}

export function verifyReceipt(r: Receipt): boolean {
  const { hash, ...rest } = r;
  return createHash("sha256").update(canonical(rest)).digest("hex") === hash;
}

/** Verify a chain newest-first or oldest-first; returns the index of the first broken link or -1. */
export function verifyChain(oldestFirst: Receipt[]): number {
  for (let i = 0; i < oldestFirst.length; i++) {
    if (!verifyReceipt(oldestFirst[i])) return i;
    if (i > 0 && oldestFirst[i].prev_hash !== oldestFirst[i - 1].hash) return i;
  }
  return -1;
}
