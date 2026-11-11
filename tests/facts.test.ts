import { describe, expect, it } from "vitest";
import { findNumber, scanSymbols, tokenFacts, asNumber } from "@/lib/facts";

describe("structural fact extraction", () => {
  it("finds nested values and records the path", () => {
    const f = tokenFacts("testa", { market: { price_usd: 10 }, technicals: { rsi_14: 30, atr_14_pct: 4 } }, "E2");
    expect(f.price).toEqual({ value: 10, evidence: "E2", path: "data.market.price_usd" });
    expect(f.rsi?.path).toBe("data.technicals.rsi_14");
    expect(f.symbol).toBe("TESTA");
  });
  it("keeps missing facts null and lists them", () => {
    const f = tokenFacts("X", { market: { price_usd: 1 } }, "E1");
    expect(f.rsi).toBeNull();
    expect(f.missing).toContain("rsi");
    expect(f.missing).toContain("atrPct");
  });
  it("prefers the higher-priority key, then the shallower path, and ignores history arrays", () => {
    const d = { history: [{ price: 1 }], deep: { nested: { price: 3 } }, price_usd: 2 };
    expect(findNumber(d, ["price_usd", "price"], "E1")?.value).toBe(2);
    expect(findNumber({ history: [{ price: 1 }], a: { price: 3 } }, ["price"], "E1")?.value).toBe(3);
  });
  it("rejects booleans and non-numeric strings, accepts '$1,234.5' and '12%'", () => {
    expect(asNumber(true)).toBeNull();
    expect(asNumber("n/a")).toBeNull();
    expect(asNumber("$1,234.5")).toBe(1234.5);
    expect(asNumber("12%")).toBe(12);
  });
  it("discards an RSI outside 0-100", () => {
    const f = tokenFacts("X", { rsi_14: 140, price: 1 }, "E1");
    expect(f.rsi).toBeNull();
    expect(f.notes.join(" ")).toMatch(/outside 0-100/);
  });
  it("derives ATR% from absolute ATR and price", () => {
    const f = tokenFacts("X", { price_usd: 200, atr_14: 10 }, "E1");
    expect(f.atrPct?.value).toBeCloseTo(5);
  });
  it("pulls symbols from scan_market lists", () => {
    expect(scanSymbols({ results: { top: [{ symbol: "aaa" }, { symbol: "BBB" }, { symbol: "aaa" }] } }).symbols).toEqual(["AAA", "BBB"]);
    expect(scanSymbols({ nothing: 1 }).symbols).toEqual([]);
  });
});
