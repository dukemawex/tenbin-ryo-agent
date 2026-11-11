// Tenbin CLI.  npm run agent            -> one live run, receipt written to ./runs
//              npm run agent -- health  -> RYO health (no credential needed)
//              npm run agent -- verify  -> re-hash every receipt in ./runs and check the chain
import { readdir, readFile } from "node:fs/promises";
import { RyoClient, MissingCredentialError } from "../lib/ryo";
import { runAgent } from "../lib/agent";
import { getStore } from "../lib/store";
import { verifyChain, type Receipt } from "../lib/receipt";

async function main() {
  const cmd = process.argv[2] ?? "run";
  const client = new RyoClient();
  if (cmd === "health") {
    const h = await client.health();
    console.log(JSON.stringify({ endpoint: client.baseUrl, ...h, credential_configured: client.hasKey }, null, 2));
    return;
  }
  if (cmd === "verify") {
    const files = (await readdir("runs")).filter((f) => f.startsWith("run_") && f.endsWith(".json")).sort();
    const rs: Receipt[] = [];
    for (const f of files) rs.push(JSON.parse(await readFile(`runs/${f}`, "utf8")));
    rs.sort((a, b) => a.started_at.localeCompare(b.started_at));
    const broken = verifyChain(rs);
    console.log(broken < 0 ? `chain OK: ${rs.length} receipt(s)` : `chain BROKEN at ${rs[broken].id}`);
    process.exitCode = broken < 0 ? 0 : 1;
    return;
  }
  const store = getStore({ preferFile: "runs" });
  const r = await runAgent({ store, client, log: (s) => console.error(`· ${s}`), skipModel: process.argv.includes("--no-model") });
  console.log(`\n${r.headline}\nreceipt ${r.id}  hash ${r.hash.slice(0, 16)}…  store=${store.kind}`);
  for (const c of r.changes.slice(0, 6)) console.log(`  [${c.importance}] ${c.text}`);
  for (const d of r.decisions) console.log(`  ${d.final.padEnd(7)} ${d.symbol.padEnd(8)} dip ${d.dip_score}/3 q=${d.quality} ${d.reasons.join("; ")}`);
  const failed = r.ryo.calls.filter((c) => c.outcome === "failed");
  console.log(`  RYO calls: ${r.ryo.calls.length} (${failed.length} failed)  model: ${r.review?.model ?? r.review?.error ?? "skipped"}`);
}

main().catch((e) => {
  if (e instanceof MissingCredentialError) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
