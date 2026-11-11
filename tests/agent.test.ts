import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RyoClient } from "@/lib/ryo";
import { runAgent } from "@/lib/agent";
import { getStore } from "@/lib/store";
import { verifyChain } from "@/lib/receipt";
import { fakeRyo } from "./fixtures";

const quiet = { sleep: async () => {}, random: () => 0 };

async function store() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  return getStore({ preferFile: await mkdtemp(`${tmpdir()}/tenbin-`) });
}

describe("agent pipeline (synthetic server)", () => {
  it("uses all six tools, enters the dip, vetoes the bearish token, and seals a receipt", async () => {
    const { f, calls } = fakeRyo();
    const s = await store();
    const r = await runAgent({ store: s, client: new RyoClient({ key: "k", fetchImpl: f, ...quiet }), skipModel: true, shortlist: 3 });
    const tools = new Set(r.ryo.calls.map((c) => c.tool));
    expect(tools.size).toBe(6);
    expect(r.decisions.find((d) => d.symbol === "TESTA")?.final).toBe("ENTER");
    expect(r.decisions.find((d) => d.symbol === "TESTC")?.final).toBe("PASS");
    expect(r.ledger.opened.map((p) => p.symbol)).toEqual(["TESTA"]);
    expect(r.changes[0].kind).toBe("position_opened");
    expect(r.evidence.every((e) => /^E\d+ /.test(e.source))).toBe(true);
    expect(calls.some((u) => u.includes("buy") || u.includes("order"))).toBe(false);
  });
  it("keeps working when scan_market is down by reusing the last shortlist, and chains receipts", async () => {
    const s = await store();
    const ok = fakeRyo();
    const r1 = await runAgent({ store: s, client: new RyoClient({ key: "k", fetchImpl: ok.f, ...quiet }), skipModel: true, shortlist: 3 });
    const down = fakeRyo({ failScan: true });
    const r2 = await runAgent({ store: s, client: new RyoClient({ key: "k", fetchImpl: down.f, maxAttempts: 2, ...quiet }), skipModel: true, shortlist: 3 });
    expect(r2.shortlist.source).toMatch(/reused previous run's shortlist/);
    expect(r2.decisions.length).toBe(3);
    expect(r2.changes.some((c) => c.kind === "degraded")).toBe(true);
    expect(r2.prev_hash).toBe(r1.hash);
    expect(verifyChain([r1, r2])).toBe(-1);
    // the position opened in run 1 is still open (no duplicate entry)
    expect(r2.ledger.opened).toHaveLength(0);
    expect(r2.ledger.open_after.map((p) => p.symbol)).toEqual(["TESTA"]);
  });
  it("abstains instead of guessing when every token read fails", async () => {
    const s = await store();
    const { f } = fakeRyo({ status: { analyze_token: 503 } });
    const r = await runAgent({ store: s, client: new RyoClient({ key: "k", fetchImpl: f, maxAttempts: 2, ...quiet }), skipModel: true, shortlist: 3 });
    expect(r.decisions.every((d) => d.final === "ABSTAIN")).toBe(true);
    expect(r.ledger.opened).toHaveLength(0);
    expect(r.pick).toBeNull();
  });
});
