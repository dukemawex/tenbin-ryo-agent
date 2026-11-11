// SYNTHETIC TEST FIXTURES. Hand-written to exercise code paths; never shown in the app,
// never written to a ledger, and using made-up symbols (TESTA, TESTB, TESTC) so they
// cannot be mistaken for market data.
export const env = (tool: string, data: unknown, extra: Record<string, unknown> = {}) => ({
  tool,
  result: { schema_version: "test", tool, status: "ok", data_mode: "live", as_of: "2000-01-01T00:00:00Z", request: {}, data, summary: { headline: `${tool} test headline` }, availability: {}, warnings: [], ...extra },
  latency_ms: 1,
});

export const tokens: Record<string, unknown> = {
  TESTA: { market: { price_usd: 10, change_24h_pct: 1.5, change_7d_pct: -12 }, technicals: { rsi_14: 30, atr_14_pct: 4 }, verdict: "neutral" },
  TESTB: { market: { price_usd: 2, change_24h_pct: -1, change_7d_pct: 3 }, technicals: { rsi_14: 55, atr_14_pct: 6 }, verdict: "neutral" },
  TESTC: { market: { price_usd: 5, change_24h_pct: 2, change_7d_pct: -15 }, technicals: { rsi_14: 28, atr_14_pct: 5 }, verdict: "bearish" },
};

export function fakeRyo(opts: { failScan?: boolean; failTool?: string; status?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/health")) return Response.json({ status: "ok", protocol_version: "2024-11-05", server: "ryo-chan", tools: 6 });
    if (u.endsWith("/whoami")) return Response.json({ quota: { remaining: 100 } });
    const m = u.match(/tools\/(\w+)\/call$/);
    if (!m) return new Response("nope", { status: 404 });
    const tool = m[1];
    const args = JSON.parse(String(init?.body ?? "{}"));
    if (opts.status?.[tool]) return Response.json({ code: "TEST", message: "test" }, { status: opts.status[tool] });
    if (tool === opts.failTool) return Response.json({ code: "UPSTREAM" }, { status: 503 });
    switch (tool) {
      case "market_overview":
        return Response.json(env(tool, { sentiment: { fear_greed_value: 40 }, regime: "neutral" }));
      case "monitor_market_sentiment_shift":
        return Response.json(env(tool, { fear_greed_change_7d: -5, sentiment_regime: "cooling" }));
      case "scan_market":
        if (opts.failScan) return Response.json({ code: "UPSTREAM" }, { status: 503 });
        return Response.json(env(tool, { candidates: [{ symbol: "TESTA" }, { symbol: "TESTB" }, { symbol: "TESTC" }] }));
      case "analyze_token":
      case "deep_analysis":
        return Response.json(env(tool, tokens[args.symbol] ?? null, tokens[args.symbol] ? {} : { status: "unavailable" }));
      case "compare_tokens":
        return Response.json(env(tool, { ranking: [] }));
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
