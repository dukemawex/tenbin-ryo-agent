import { describe, expect, it } from "vitest";
import { RyoClient, MissingCredentialError, unwrapEnvelope, retryAfterMs } from "@/lib/ryo";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("RYO client failure handling", () => {
  it("refuses to call tools without a credential", async () => {
    const c = new RyoClient({ key: "" });
    await expect(c.call("market_overview")).rejects.toBeInstanceOf(MissingCredentialError);
  });
  it("retries 429 honouring Retry-After, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ code: "RATE_LIMITED" }), { status: 429, headers: { "retry-after": "2" } });
      return Response.json({ tool: "market_overview", result: { tool: "market_overview", status: "ok", data_mode: "live", data: {} } });
    }) as unknown as typeof fetch;
    const c = new RyoClient({ key: "k", fetchImpl: f, sleep: async (ms) => void waits.push(ms), random: () => 0.1 });
    const r = await c.call("market_overview");
    expect(r.record.outcome).toBe("ok");
    expect(r.record.attempts).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
  });
  it("does not retry 401", async () => {
    let n = 0;
    const f = (async () => (n++, Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }))) as unknown as typeof fetch;
    const r = await new RyoClient({ key: "k", fetchImpl: f, ...noSleep }).call("market_overview");
    expect(n).toBe(1);
    expect(r.record.outcome).toBe("failed");
    expect(r.record.error).toMatch(/401/);
  });
  it("retries 503 up to maxAttempts then reports failure", async () => {
    let n = 0;
    const f = (async () => (n++, Response.json({ code: "DOWN" }, { status: 503 }))) as unknown as typeof fetch;
    const r = await new RyoClient({ key: "k", fetchImpl: f, maxAttempts: 3, ...noSleep }).call("scan_market");
    expect(n).toBe(3);
    expect(r.envelope).toBeNull();
  });
  it("treats a 200 that is not an envelope as a failure, without guessing", async () => {
    const f = (async () => Response.json({ hello: "world" })) as unknown as typeof fetch;
    const r = await new RyoClient({ key: "k", fetchImpl: f, ...noSleep }).call("scan_market");
    expect(r.record.outcome).toBe("failed");
    expect(r.record.error).toMatch(/not a RYO envelope/);
  });
  it("unwraps REST and bare envelopes and parses Retry-After dates", () => {
    const e = { tool: "t", status: "ok", data_mode: "live", data: 1 };
    expect(unwrapEnvelope(e)).toEqual(e);
    expect(unwrapEnvelope({ result: e })).toEqual(e);
    expect(unwrapEnvelope({ result: { nope: 1 } })).toBeNull();
    expect(retryAfterMs("Thu, 01 Jan 2000 00:00:10 GMT", new Date("2000-01-01T00:00:00Z"))).toBe(10000);
  });
});
