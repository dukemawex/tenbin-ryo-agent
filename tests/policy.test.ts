import { describe, expect, it } from "vitest";
import { tokenFacts } from "@/lib/facts";
import { decideToken, markPosition, regimeMultiplier, evidenceQuality, type Position } from "@/lib/policy";
import { tokens } from "./fixtures";

const ctx = { status: "ok" as const, dataMode: "live", deepVerdict: null, equityUsd: 10000, regimeMult: 1 };

describe("deterministic policy", () => {
  it("enters an oversold dip with a bounce and sizes from ATR", () => {
    const d = decideToken(tokenFacts("TESTA", tokens.TESTA, "E1"), ctx);
    expect(d.verdict).toBe("ENTER");
    expect(d.dip_score).toBe(3);
    // stop 1.5 x 4% = 6%; risk 1% of 10k = 100 -> size 100/0.06 = 1666.67
    expect(d.plan?.stop).toBeCloseTo(9.4);
    expect(d.plan?.target).toBeCloseTo(11.2);
    expect(d.plan?.size_usd).toBeCloseTo(1666.67, 1);
  });
  it("passes when RYO's own verdict is bearish", () => {
    const d = decideToken(tokenFacts("TESTC", tokens.TESTC, "E1"), ctx);
    expect(d.verdict).toBe("PASS");
  });
  it("abstains on simulated data", () => {
    const d = decideToken(tokenFacts("TESTA", tokens.TESTA, "E1"), { ...ctx, dataMode: "simulated" });
    expect(d.verdict).toBe("ABSTAIN");
    expect(d.plan).toBeNull();
  });
  it("downgrades quality on partial evidence and never sizes without ATR", () => {
    const t = tokenFacts("X", { price_usd: 1, rsi_14: 20, change_7d_pct: -20, change_24h_pct: 1 }, "E1");
    expect(evidenceQuality(t, "partial", "live")).toBeLessThan(0.6);
    const d = decideToken(t, { ...ctx, status: "partial" });
    expect(d.verdict).toBe("WATCH");
    expect(d.plan).toBeNull();
  });
  it("halves size under extreme fear or missing regime evidence", () => {
    expect(regimeMultiplier({ fearGreed: { value: 10, evidence: "E1", path: "p" }, fearGreedChange7d: null, regime: null, sentimentRegime: null }).mult).toBe(0.5);
    expect(regimeMultiplier({ fearGreed: null, fearGreedChange7d: null, regime: null, sentimentRegime: null }).mult).toBe(0.5);
    expect(regimeMultiplier({ fearGreed: { value: 50, evidence: "E1", path: "p" }, fearGreedChange7d: null, regime: null, sentimentRegime: null }).mult).toBe(1);
  });
  it("closes practice positions on stop, target and time", () => {
    const p: Position = { id: "x", symbol: "TESTA", opened_at: "2000-01-01T00:00:00Z", opened_run: "r", entry: 10, stop: 9, target: 12, size_usd: 1000, status: "open", evidence: "E1" };
    const t = new Date("2000-01-02T00:00:00Z");
    expect(markPosition(p, 8.5, t, "r2")?.exit_reason).toBe("stop");
    expect(markPosition(p, 8.5, t, "r2")?.pnl_usd).toBe(-150);
    expect(markPosition(p, 12.5, t, "r2")?.exit_reason).toBe("target");
    expect(markPosition(p, 10.5, t, "r2")).toBeNull();
    expect(markPosition(p, 10.5, new Date("2000-01-10T00:00:00Z"), "r2")?.exit_reason).toBe("time");
  });
});
