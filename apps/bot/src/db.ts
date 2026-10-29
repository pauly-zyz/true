import type pg from "pg";
import type { CoinScan, PaperSimulator, SimTrade } from "@true/core";

const big = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function insertRun(db: pg.Pool, runId: string, capitalUsd: number, config: unknown): Promise<void> {
  await db.query("INSERT INTO sim_runs (run_id, capital_usd, config) VALUES ($1, $2, $3)", [runId, capitalUsd, big(config)]);
}

export async function insertTrade(db: pg.Pool, runId: string, t: SimTrade): Promise<void> {
  const e = t.eval;
  await db.query(
    `INSERT INTO sim_trades (ts, run_id, slug, buy_chain, sell_chain, quote_in, token_amount, quote_out, notional_usd, gross_usd, net_usd, costs, executed, reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      new Date(t.ts),
      runId,
      t.slug,
      t.buyChain,
      t.sellChain,
      (e?.quoteIn ?? 0n).toString(),
      (e?.tokenSold ?? 0n).toString(),
      (e?.quoteOut ?? 0n).toString(),
      e?.notionalUsd ?? 0,
      e?.grossUsd ?? 0,
      e?.netUsd ?? 0,
      big(e?.costs ?? {}),
      t.executed,
      big(t.reasons),
    ],
  );
}

export async function insertGapSnapshot(db: pg.Pool, slug: string, s: CoinScan, sources: unknown): Promise<void> {
  await db.query(
    "INSERT INTO gap_snapshots (ts, slug, spread, true_score, prices_usd, sources) VALUES (now(), $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [slug, s.spread, s.trueScore, big(s.pricesUsd), big(sources)],
  );
}

export async function insertPnl(db: pg.Pool, runId: string, equityUsd: number, realizedUsd: number, sim: PaperSimulator): Promise<void> {
  const inventory = { quote: sim.quote, tokens: Object.fromEntries(sim.tokens) };
  await db.query("INSERT INTO sim_pnl (ts, run_id, equity_usd, realized_usd, inventory) VALUES (now(), $1, $2, $3, $4) ON CONFLICT DO NOTHING", [
    runId,
    equityUsd,
    realizedUsd,
    big(inventory),
  ]);
}
