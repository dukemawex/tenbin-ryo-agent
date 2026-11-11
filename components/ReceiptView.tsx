import type { Receipt } from "@/lib/receipt";
import type { RuleHit } from "@/lib/policy";

const n = (v: number | null | undefined, d = 4) => (v == null ? "—" : Number(v.toPrecision(d)).toLocaleString("en-US", { maximumFractionDigits: 8 }));

function RuleRow({ r }: { r: RuleHit }) {
  const mark = r.passed === true ? "✓" : r.passed === false ? "✗" : "?";
  const cls = r.passed === true ? "ok" : r.passed === false ? "bad" : "warn";
  return (
    <tr>
      <td><span className={cls} aria-label={r.passed === true ? "passed" : r.passed === false ? "failed" : "not evaluable"}>{mark}</span> {r.rule}</td>
      <td>{r.detail}</td>
      <td className="mono">{r.inputs.filter((i) => i.evidence).map((i) => `${i.evidence} ${i.path}`).join("; ") || "—"}</td>
    </tr>
  );
}

export function ReceiptView({ r, compact = false }: { r: Receipt; compact?: boolean }) {
  const pick = r.decisions.find((d) => r.pick && d.symbol === r.pick.symbol) ?? null;
  return (
    <div>
      <section aria-labelledby="changed">
        <h2 id="changed">What changed, most important first</h2>
        {r.changes.length ? (
          <ol className="changes">
            {r.changes.map((c, i) => (
              <li key={i}>
                <span className="rank" aria-label={`importance ${c.importance}`}>{c.importance}</span>
                <span>
                  {c.text} {c.cites.length ? <span className="muted mono">[{c.cites.join(", ")}]</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Nothing changed versus the previous run{r.prev_hash ? "" : " (this is the first run in the chain)"}.</p>
        )}
      </section>

      {pick ? (
        <section aria-labelledby="pick">
          <h2 id="pick">
            The call: <span className={`pill ${pick.final}`}>{pick.final}</span> {pick.symbol}
            {pick.final !== pick.verdict ? <span className="muted"> (policy said {pick.verdict}; model {pick.model_action})</span> : null}
          </h2>
          <div className="grid">
            <div className="card">
              <h3>1 · Policy reasons</h3>
              <ul>{pick.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <p className="muted">Dip score {pick.dip_score}/3 · evidence quality {pick.quality}</p>
            </div>
            <div className="card">
              <h3>2 · Practice plan</h3>
              {pick.plan ? (
                <table>
                  <tbody>
                    <tr><th scope="row">Entry</th><td>{n(pick.plan.entry, 6)}</td></tr>
                    <tr><th scope="row">Stop ({pick.plan.stop_atr_mult}×ATR)</th><td>{n(pick.plan.stop, 6)}</td></tr>
                    <tr><th scope="row">Target ({pick.plan.r_multiple_target}R)</th><td>{n(pick.plan.target, 6)}</td></tr>
                    <tr><th scope="row">Size / risk (paper USD)</th><td>{pick.plan.size_usd} / {pick.plan.risk_usd}</td></tr>
                  </tbody>
                </table>
              ) : (
                <p className="muted">No plan: the policy only sizes ENTER calls with a measured ATR.</p>
              )}
            </div>
            <div className="card">
              <h3>3 · Model red-team</h3>
              {r.review?.model ? (
                <>
                  <p>
                    <strong>{r.review.action}</strong> <span className="muted mono">{r.review.model}</span>
                  </p>
                  <p className="muted">
                    {r.review.dropped_claims} uncited claim(s) dropped · {r.review.unverified_numbers} number mismatch(es) flagged
                  </p>
                </>
              ) : (
                <p className="warn">{r.review?.error ?? "Model review skipped."}</p>
              )}
            </div>
          </div>
          {r.review?.model ? (
            <div className="grid" style={{ marginTop: 14 }}>
              {(["bull_case", "bear_case", "rationale"] as const).map((k) => (
                <div className="card" key={k}>
                  <h3>{k.replace("_", " ")}</h3>
                  <ul>
                    {r.review![k].map((c, i) => (
                      <li key={i}>
                        {c.claim} <span className="mono muted">[{c.cites.join(", ")}]</span>
                        {c.numbers_checked === false ? <span className="warn"> · number not matched to cited fact</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {r.review.would_change_mind.length ? (
                <div className="card">
                  <h3>What would change the call</h3>
                  <ul>{r.review.would_change_mind.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <details>
            <summary>Rules fired for {pick.symbol}</summary>
            <table>
              <thead><tr><th>Rule</th><th>Detail</th><th>Evidence</th></tr></thead>
              <tbody>{pick.rules.map((x, i) => <RuleRow key={i} r={x} />)}</tbody>
            </table>
          </details>
        </section>
      ) : null}

      <section aria-labelledby="cands">
        <h2 id="cands">Every candidate, ranked</h2>
        <table>
          <caption className="muted" style={{ textAlign: "left" }}>Shortlist source: {r.shortlist.source ?? "none"} · market size multiplier {r.market.size_multiplier} ({r.market.rule.detail})</caption>
          <thead><tr><th scope="col">Token</th><th scope="col">Final</th><th scope="col">Dip</th><th scope="col">Quality</th><th scope="col">Why</th></tr></thead>
          <tbody>
            {r.decisions.map((d) => (
              <tr key={d.symbol}>
                <th scope="row">{d.symbol}</th>
                <td><span className={`pill ${d.final}`}>{d.final}</span></td>
                <td>{d.dip_score}/3</td>
                <td>{d.quality}</td>
                <td>{d.reasons.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!compact ? (
        <>
          <section aria-labelledby="ev">
            <h2 id="ev">Evidence table (what the model saw)</h2>
            <table>
              <thead><tr><th>Id</th><th>Subject</th><th>Fact</th><th>Value</th><th>Source (call · JSON path)</th></tr></thead>
              <tbody>
                {r.evidence.map((e) => (
                  <tr key={e.id}><td className="mono">{e.id}</td><td>{e.symbol}</td><td>{e.name}</td><td>{typeof e.value === "number" ? n(e.value, 6) : e.value}</td><td className="mono">{e.source}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="calls">
            <h2 id="calls">RYO calls (provenance)</h2>
            <table>
              <thead><tr><th>Id</th><th>Tool</th><th>Args</th><th>Outcome</th><th>data_mode</th><th>as_of</th><th>Attempts</th><th>Body SHA-256</th></tr></thead>
              <tbody>
                {r.ryo.calls.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td><td>{c.tool}</td><td className="mono">{JSON.stringify(c.args)}</td>
                    <td className={c.outcome === "ok" ? "ok" : c.outcome === "failed" ? "bad" : "warn"}>{c.outcome}{c.error ? ` (${c.error})` : ""}</td>
                    <td>{c.data_mode ?? "—"}</td><td className="mono">{c.as_of ?? "—"}</td>
                    <td>{c.attempts.length}{c.attempts.some((a) => a.waited_ms) ? ` (backoff ${c.attempts.reduce((s, a) => s + a.waited_ms, 0)} ms)` : ""}</td>
                    <td className="mono">{c.body_sha256 ? c.body_sha256.slice(0, 12) + "…" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
      <p className="muted mono" style={{ marginTop: 16 }}>
        receipt {r.id} · sha256 {r.hash.slice(0, 16)}… · prev {r.prev_hash ? r.prev_hash.slice(0, 16) + "…" : "genesis"} · {r.finished_at}
      </p>
    </div>
  );
}
