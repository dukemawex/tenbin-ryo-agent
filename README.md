# Tenbin 天秤: explainable practice trades on RYO-CHAN

**RYO-CHAN Hackathon 2026 · Track 1 (Autonomous Agents) + Track 2 (Dashboards & Interfaces)**

Tenbin ("balance scale") is a buy-the-dip **practice** agent built on RYO-CHAN's six read-only research tools.
On every run it:

1. **Gathers evidence from all six RYO tools.** It calls `market_overview` and `monitor_market_sentiment_shift` for the regime,
   `scan_market` for the shortlist, `analyze_token` on each candidate, `deep_analysis` on the finalists, and `compare_tokens` head-to-head.
2. **Decides with a deterministic, testable policy.** Each pick gets a dip score from RSI(14), the 7-day drawdown and a 24-hour bounce,
   plus a RYO-verdict veto, an evidence-quality gate, a regime size cut, an ATR stop and a 2R target.
3. **Lets a free model red-team the pick.** The model can agree, downgrade or veto, but it **can never upgrade** a call.
   Every claim it makes must cite fact ids from the evidence table. Claims citing unknown facts are dropped, and quoted numbers
   are checked against the cited facts.
4. **Records practice trades.** These are paper positions marked to market on later runs, with stop, target and 7-day time exits.
   Nothing is ever bought, sold or moved.
5. **Seals a receipt.** Each run is hash-chained (SHA-256 over canonical JSON, linked to the previous run) and records every
   RYO call's arguments, status, `data_mode`, `as_of`, retries, trace id and body hash, plus the JSON path behind every number.

The dashboard answers **"what changed since the last run and why does it matter?"** in under 30 seconds. Changes are ranked
by importance: positions closed or opened first, then verdict flips, regime shifts and degraded data. Each receipt also has
its own shareable page (`/r/<run id>`).

> **Honesty convention.** Tenbin shows only live RYO evidence. With no credential or no runs, the dashboard says so and stays empty.
> There is no demo, sample or placeholder data anywhere in the app. A missing measurement stays `null`, shows up as a gap and
> lowers evidence quality, so it is never treated as zero. Data that RYO marks `simulated` is never traded on: the token is `ABSTAIN`.

- **Live app:** https://tenbin-ryo-agent.vercel.app (health: `/api/health`, chain check: `/api/verify`)
- **Source:** https://github.com/dukemawex/tenbin-ryo-agent

---

## For judges: a 3-minute path

| Rubric line | Where to look |
|---|---|
| **Combining sources (20%)** | `lib/agent.ts` fuses all six tools into one decision. The receipt's *Evidence table* shows every fact with its source call and JSON path. |
| **Coping with failure (20%)** | `lib/ryo.ts` has per-attempt timeouts, exponential backoff with jitter, `Retry-After`, no retries on 4xx argument or auth errors, and envelope validation. `lib/agent.ts` reuses the last shortlist if `scan_market` is down, never sizes without ATR, and abstains when reads fail. The Upstash ledger and run lock survive restarts. Tests: `tests/ryo.test.ts`, `tests/agent.test.ts`. |
| **T1 Real thinking (25%)** | Rules propose, then the model red-teams with a bull case, a bear case, a rationale and "what would change my mind". Citations are verified in code (`lib/llm.ts`). |
| **T1 Cause and effect (20%)** | Each rule records its inputs (evidence id and path), its threshold and the result. The receipt shows *evidence → rule → policy verdict → model action → final verdict → practice position*. |
| **T1 Repeatability (10%)** | The policy is pure and deterministic (`lib/policy.ts`). Receipts are hash-chained, and `GET /api/verify` or `npm run agent -- verify` re-hashes the whole chain. |
| **T1 Advanced execution (5%)** | ATR-based sizing scaled by evidence quality and regime, practice exits, and a run lock against concurrent cron and manual runs. |
| **T2 Easy to read / Sorted by importance (50%)** | The dashboard opens with the headline, then a numbered "What changed" list ordered by importance, then the call with its three-step explanation. |
| **T2 Works for everyone (10%)** | Semantic HTML, a skip link, visible focus rings, keyboard-only navigation, `aria-live` status, table captions and scoped headers, and text labels as well as colour for every status. |

Quick checks without a RYO credential:

```bash
npm install
npm test                       # 28 offline tests (synthetic fixtures; see below)
TENBIN_LIVE=1 npm test         # +2 live tests against the real RYO endpoint (health, and a 401 that is not retried)
npm run agent -- health        # live RYO health from your machine
```

With a credential: `cp .env.example .env`, fill in `RYO_MCP_KEY` and `OPENROUTER_API_KEY`, then run `npm run agent`.
The receipt is written to `./runs/`, or to Upstash if configured.

---

## Architecture

```
lib/ryo.ts       REST client for the six tools: retries, backoff, Retry-After, provenance records
lib/facts.ts     structural extraction: each number keeps its evidence id and JSON path, missing stays null
lib/policy.ts    pure deterministic policy: dip score, verdict veto, quality gate, regime cut, ATR plan, practice exits
lib/llm.ts       free-model red-team on OpenRouter (":free" only, falls back in order) with citation and number checks
lib/agent.ts     one run: evidence → policy → model → practice ledger → ranked changes → sealed receipt
lib/receipt.ts   canonical JSON, SHA-256 seal, chain verification
lib/store.ts     Upstash Redis REST ledger (or ./runs on the CLI, or memory, which is labelled ephemeral in the UI)
app/             Next.js dashboard (/), receipt pages (/r/[id]) and APIs (/api/health, /api/run, /api/receipts/[id], /api/verify)
cli/run.ts       npm run agent [health|verify]
```

Runs happen through the daily Vercel cron (`GET /api/run` with `CRON_SECRET`) or manually with
`curl -X POST -H "Authorization: Bearer $TENBIN_RUN_TOKEN" https://<app>/api/run`. Runs spend RYO quota, so they are never public.
The RYO key stays server-side. Browsers only ever talk to Tenbin's own routes.

### Policy (v1)

| Rule | Threshold |
|---|---|
| `rsi_oversold` | RSI(14) ≤ 35 |
| `seven_day_dip` | 7-day change ≤ −8% |
| `day_bounce_confirmation` | 24h change > 0 |
| `ryo_verdict_not_bearish` | a bearish verdict from RYO's `deep_analysis`/`analyze_token` forces PASS |
| `evidence_quality` | ≥ 0.6 (share of price, RSI, ATR and 7d found × status weight × data_mode weight; `simulated`/`unknown` count as 0) |
| `regime_gate` | half size if Fear & Greed ≤ 15, if the regime reads risk-off, or if there is no regime evidence |
| `atr_sizing` | stop at 1.5×ATR, target at 2R, risk 1% of paper equity × quality × regime, capped at 20% of equity |

ENTER needs a dip score of at least 2/3, quality ≥ 0.6 and a measured ATR. A score of 1/3 means WATCH, 0 means PASS, and no usable evidence means ABSTAIN.
A position closes at a run if the price is at or below the stop, at or above the target, or the position has been open more than 7 days.

## Environment

See `.env.example`. You need `RYO_MCP_URL` and `RYO_MCP_KEY` (the organiser's builder credential), plus `OPENROUTER_API_KEY`
(the app only calls `:free` models, and any paid model id is filtered out). `UPSTASH_REDIS_REST_URL`/`_TOKEN` are optional,
for a durable ledger. `TENBIN_RUN_TOKEN` and `CRON_SECRET` are each at least 16 characters.

## Tests

- `npm test` runs 28 offline tests: extraction, policy, the retry and backoff paths, model-claim verification, receipt sealing
  and tamper detection, and three full agent runs against an in-process fake server (all six tools, scan outage
  with shortlist reuse and receipt chaining, and total read failure leading to ABSTAIN).
- The fake server and fixtures in `tests/fixtures.ts` are **synthetic and labelled as such**. They use made-up symbols
  (`TESTA`, `TESTB`, `TESTC`), exist only under `tests/`, and never reach the app or a ledger.
- `TENBIN_LIVE=1 npm test` adds two live checks against `https://app-ryochan.com/api/mcp`.

## Limitations

- Stops and targets are checked against the price at each run, not intraday, so a practice exit is "as of the run".
- The policy is intentionally simple (v1) so that every decision can be replayed and audited.
- Field names inside each tool's `data` can change between RYO versions. Extraction therefore matches a priority list of key
  names and records the matched path, so an unexpected shape shows up as a visible gap, never as a wrong number.

## Disclosures

- Libraries: Next.js, React, TypeScript, Vitest and tsx. No starter template was used. All code was written during the event (Nov 2026).
- Model: free OpenRouter models only. The default chain is `nvidia/nemotron-3-ultra-550b-a55b:free`, then `nvidia/nemotron-3.5-super-vl:free`, then `google/gemma-4-31b-it:free`.
- The RYO tool contract comes from the official MCP Builder Guide (ryobuild.com/docs/MCP-Builder-Guide.md).
  Public notes in other hackathon repos about the live schema (for example, that the `analyze_token` price sits under `data.market`)
  informed the key-name lists in `lib/facts.ts`. No code was copied.
- An AI coding assistant helped write this project.
- Practice trades only. Tenbin cannot and does not trade, and nothing here is financial advice.

MIT License.
