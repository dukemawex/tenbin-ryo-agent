// Live checks against the real RYO endpoint. No credential needed; run with TENBIN_LIVE=1.
import { describe, expect, it } from "vitest";
import { RyoClient } from "@/lib/ryo";

describe.skipIf(!process.env.TENBIN_LIVE)("live RYO endpoint", () => {
  it("health is reachable and reports six tools", async () => {
    const h = await new RyoClient({ key: "" }).health();
    expect(h.ok).toBe(true);
    expect((h.body as { tools: number }).tools).toBe(6);
  });
  it("an invalid credential is refused with 401 once, with no retry storm", async () => {
    const c = new RyoClient({ key: "ryo_mcp_invalid_for_testing", sleep: async () => {} });
    const r = await c.call("market_overview");
    expect(r.record.outcome).toBe("failed");
    expect(r.record.attempts).toHaveLength(1);
    expect(r.record.attempts[0].http_status).toBe(401);
    expect(r.record.attempts[0].trace_id).toBeTruthy();
  });
});
