import { getStore } from "@/lib/store";
import { status } from "@/lib/server";
import { ReceiptView } from "@/components/ReceiptView";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [st, store] = [await status(), getStore()];
  const ledger = await store.load();
  const latest = ledger.index[0] ? await store.receipt(ledger.index[0].id) : null;
  const open = ledger.positions.filter((p) => p.status === "open");
  const closed = ledger.positions.filter((p) => p.status === "closed").slice(-10).reverse();
  return (
    <>
      <h1>{latest ? latest.headline : "Tenbin is waiting for its first live run"}</h1>
      <p className="muted">
        A buy-the-dip practice agent on RYO-CHAN&apos;s live research tools. Rules propose, a free model red-teams, every call is sealed in a hash-chained receipt.
      </p>
      <div className="status card" role="status" aria-live="polite">
        <span>RYO research layer: <strong className={st.ryo.healthy ? "ok" : "bad"}>{st.ryo.healthy ? "healthy" : "unreachable"}</strong> <span className="muted">(live check, {st.checked_at.slice(11, 19)} UTC)</span></span>
        <span>Builder credential: <strong className={st.ryo.credential_configured ? "ok" : "warn"}>{st.ryo.credential_configured ? "configured" : "not configured"}</strong></span>
        <span>Model: <strong className={st.model.configured ? "ok" : "warn"}>{st.model.configured ? st.model.chain[0] : "not configured"}</strong></span>
        <span>Ledger: <strong>{store.kind}</strong>{store.kind === "memory" ? <span className="warn"> (ephemeral)</span> : null}</span>
        <span>Realized practice P&amp;L: <strong>{ledger.realized_pnl_usd} USD</strong> <span className="muted">(paper)</span></span>
      </div>

      {latest ? (
        <ReceiptView r={latest} compact />
      ) : (
        <div className="empty" style={{ marginTop: 18 }}>
          <p><strong>No receipts yet.</strong> Tenbin shows only live RYO evidence, so nothing appears here until a run completes. There is no sample or placeholder data.</p>
          {!st.ryo.credential_configured ? <p className="warn">Live runs need the RYO builder credential (RYO_MCP_KEY) that the hackathon organiser issues after registration.</p> : <p>Trigger a run with <code>POST /api/run</code> and the run token, or wait for the daily cron.</p>}
        </div>
      )}

      <section aria-labelledby="pos">
        <h2 id="pos">Practice positions</h2>
        {open.length || closed.length ? (
          <table>
            <thead><tr><th>Token</th><th>Status</th><th>Entry</th><th>Stop</th><th>Target</th><th>Size (paper USD)</th><th>Exit</th><th>P&amp;L</th><th>Opened in</th></tr></thead>
            <tbody>
              {[...open, ...closed].map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.symbol}</th><td>{p.status}</td><td>{p.entry}</td><td>{p.stop.toPrecision(6)}</td><td>{p.target.toPrecision(6)}</td><td>{p.size_usd}</td>
                  <td>{p.exit_reason ? `${p.exit_reason} @ ${p.exit_price}` : "—"}</td><td>{p.pnl_usd ?? "—"}</td>
                  <td><a href={`/r/${p.opened_run}`}>{p.opened_run}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No practice positions yet.</p>
        )}
      </section>

      <section aria-labelledby="hist">
        <h2 id="hist">Receipt chain</h2>
        {ledger.index.length ? (
          <ol className="chain">
            {ledger.index.slice(0, 20).map((e) => (
              <li key={e.id}><a href={`/r/${e.id}`}>{e.at.replace("T", " ").slice(0, 16)} UTC · {e.headline}</a> <span className="mono muted">{e.hash.slice(0, 10)}…</span></li>
            ))}
          </ol>
        ) : (
          <p className="muted">Empty chain.</p>
        )}
      </section>
    </>
  );
}
