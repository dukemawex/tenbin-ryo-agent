import { describe, expect, it } from "vitest";
import { verifyClaims, freeModels, extractJson } from "@/lib/llm";
import { sealReceipt, verifyReceipt, verifyChain, canonical } from "@/lib/receipt";

const table = new Map([
  ["F1", { id: "F1", symbol: "TESTA", name: "rsi_14", value: 30, source: "E1 data.rsi_14" }],
  ["F2", { id: "F2", symbol: "TESTA", name: "change_7d_pct", value: -12, source: "E1 data.change_7d_pct" }],
]);

describe("model output is checked, not trusted", () => {
  it("drops claims without valid citations", () => {
    const r = verifyClaims([{ claim: "RSI is low", cites: ["F9"] }, { claim: "no cites", cites: [] }, { claim: "RSI(14) at 30 is oversold", cites: ["F1"] }], table);
    expect(r.dropped).toBe(2);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].numbers_checked).toBe(true);
  });
  it("flags numbers that do not match the cited facts", () => {
    const r = verifyClaims([{ claim: "down 25% this week", cites: ["F2"] }], table);
    expect(r.unverified).toBe(1);
    expect(r.claims[0].numbers_checked).toBe(false);
  });
  it("only ever uses :free models", () => {
    process.env.TENBIN_MODELS = "paid/model,vendor/x:free";
    expect(freeModels()).toEqual(["vendor/x:free"]);
    delete process.env.TENBIN_MODELS;
  });
  it("extracts JSON from fenced model output", () => {
    expect(extractJson("sure\n```json\n{\"action\":\"agree\"}\n```")).toEqual({ action: "agree" });
  });
});

describe("receipts", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it("detects tampering and broken chains", () => {
    const a = sealReceipt({ id: "a", prev_hash: null, headline: "x" } as never);
    const b = sealReceipt({ id: "b", prev_hash: a.hash, headline: "y" } as never);
    expect(verifyReceipt(a)).toBe(true);
    expect(verifyChain([a, b])).toBe(-1);
    expect(verifyReceipt({ ...b, headline: "edited" })).toBe(false);
    const c = sealReceipt({ id: "c", prev_hash: "wrong", headline: "z" } as never);
    expect(verifyChain([a, b, c])).toBe(2);
  });
});
