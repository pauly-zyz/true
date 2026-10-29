// Terminal dashboard: live gaps, simulated trades and virtual PnL, read from Postgres.
// Usage: pnpm cli [--once] [--run <runId>]
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";
import { loadSecrets } from "@true/core";
import { getDb } from "@true/chains";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const db = getDb(loadSecrets().databaseUrl);
const args = process.argv.slice(2);
const once = args.includes("--once");
const runArg = args.includes("--run") ? args[args.indexOf("--run") + 1] : undefined;

const usd = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "–" : `$${Number(x).toFixed(d)}`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(Number(x) * 100).toFixed(2)}%`);
const CH: Record<string, string> = { ethereum: "ETH", base: "BASE", robinhood: "RH", bsc: "BSC", solana: "SOL" };

async function render(): Promise<string> {
  const run = runArg
    ? (await db.query("SELECT * FROM sim_runs WHERE run_id = $1", [runArg])).rows[0]
    : (await db.query("SELECT * FROM sim_runs ORDER BY started_at DESC LIMIT 1")).rows[0];
  if (!run) return "No paper-trading run yet. Start one with: pnpm bot";
  const pnl = (await db.query("SELECT * FROM sim_pnl WHERE run_id = $1 ORDER BY ts DESC LIMIT 1", [run.run_id])).rows[0];
  const counts = (
    await db.query(
      "SELECT count(*) FILTER (WHERE executed) AS ex, count(*) FILTER (WHERE NOT executed) AS rej, coalesce(sum(net_usd) FILTER (WHERE executed),0) AS net, coalesce(sum(notional_usd) FILTER (WHERE executed),0) AS vol FROM sim_trades WHERE run_id = $1",
      [run.run_id],
    )
  ).rows[0];
  const out: string[] = [];
  const equity = pnl ? Number(pnl.equity_usd) : Number(run.capital_usd);
  out.push(
    `TRUE paper trading (DRY RUN — no real transactions)   run ${run.run_id}   started ${new Date(run.started_at).toISOString().slice(0, 19)}Z   now ${new Date().toISOString().slice(11, 19)}Z`,
  );
  out.push(
    `Capital ${usd(run.capital_usd)}   Equity ${usd(equity)}   PnL ${usd(equity - Number(run.capital_usd))}   Expected net (after rebalance) ${usd(counts.net)}   Trades ${counts.ex} executed / ${counts.rej} rejected   Volume ${usd(counts.vol)}`,
  );

  const gaps = (
    await db.query(
      `SELECT DISTINCT ON (slug) slug, ts, spread, true_score, prices_usd, sources FROM gap_snapshots WHERE ts > now() - interval '10 minutes' ORDER BY slug, ts DESC`,
    )
  ).rows.sort((a, b) => Number(b.spread ?? 0) - Number(a.spread ?? 0));
  const gt = new Table({ head: ["Coin", "Spread", "True Score", "Cheapest", "Dearest", "Prices (USD) and source age"], style: { head: [], border: process.stdout.isTTY ? ["grey"] : [] } });
  for (const g of gaps.slice(0, 15)) {
    const p = g.prices_usd as Record<string, number>;
    const src = (g.sources ?? {}) as Record<string, { source: string; ageSec: number }>;
    const entries = Object.entries(p).sort((a, b) => a[1] - b[1]);
    gt.push([
      g.slug,
      pct(g.spread),
      g.true_score === null ? "–" : Number(g.true_score).toFixed(0),
      entries[0] ? CH[entries[0][0]] : "–",
      entries.at(-1) ? CH[entries.at(-1)![0]] : "–",
      entries.map(([c, v]) => `${CH[c]} ${v.toExponential(3)} (${src[c]?.source === "rpc" ? "rpc" : "snap"} ${src[c]?.ageSec ?? "?"}s)`).join("  "),
    ]);
  }
  out.push("\nLive gaps (latest per coin, last 10 min)\n" + gt.toString());

  const trades = (await db.query("SELECT * FROM sim_trades WHERE run_id = $1 ORDER BY ts DESC LIMIT 12", [run.run_id])).rows;
  const tt = new Table({ head: ["Time", "Coin", "Buy → Sell", "Size", "Gross", "Net", "Status"], style: { head: [], border: process.stdout.isTTY ? ["grey"] : [] } });
  for (const t of trades) {
    tt.push([
      new Date(t.ts).toISOString().slice(11, 19),
      t.slug,
      `${CH[t.buy_chain]} → ${CH[t.sell_chain]}`,
      usd(t.notional_usd),
      usd(t.gross_usd),
      usd(t.net_usd),
      t.executed ? "EXECUTED (sim)" : `rejected: ${(t.reasons as string[])[0] ?? ""}`.slice(0, 60),
    ]);
  }
  out.push("\nSimulated trades (latest 12)\n" + tt.toString());
  return out.join("\n");
}

async function loop() {
  const text = await render();
  if (!once) process.stdout.write("\x1b[2J\x1b[H");
  console.log(text);
  if (once) {
    await db.end();
    return;
  }
  setTimeout(loop, 2000);
}
await loop();
