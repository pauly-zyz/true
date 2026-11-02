import type pg from "pg";
import type { TradeRecord } from "@true/executor";

const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function insertLiveTrade(db: pg.Pool, runId: string, t: TradeRecord): Promise<void> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO live_trades (ts, run_id, mode, slug, buy_chain, sell_chain, status, reasons, model, simulation, real, expected_net_usd, real_net_usd, real_costs_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      new Date(t.ts),
      runId,
      t.mode,
      t.slug,
      t.buyChain,
      t.sellChain,
      t.status,
      j(t.reasons),
      j(t.model),
      j(t.legs.map((l) => ({ chain: l.chain, side: l.side, quotedOut: l.quotedOut, minOut: l.minOut }))),
      j(t.legs.map((l) => ({ chain: l.chain, side: l.side, status: l.status, result: l.result }))),
      t.expectedNetUsd,
      t.realNetUsd ?? null,
      t.realCostsUsd ?? null,
    ],
  );
  const id = r.rows[0]!.id;
  for (const l of t.legs) {
    await db.query(
      `INSERT INTO live_legs (trade_id, chain, side, tx_hash, explorer_url, status, block, gas_used, effective_gas_price, gas_usd, amount_in, amount_out, hook_fee, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        l.chain,
        l.side,
        l.txHash ?? null,
        l.explorer ?? null,
        l.status,
        l.result?.blockNumber?.toString() ?? null,
        l.result?.gasUsed?.toString() ?? null,
        l.result?.effectiveGasPrice?.toString() ?? null,
        l.gasUsd ?? null,
        l.result?.amountIn?.toString() ?? null,
        l.result?.amountOut?.toString() ?? null,
        l.result?.hookFee?.toString() ?? null,
        l.error ?? null,
      ],
    );
  }
}

export async function insertRiskEvent(
  db: pg.Pool,
  runId: string,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query("INSERT INTO risk_events (run_id, kind, detail) VALUES ($1, $2, $3)", [
    runId,
    kind,
    j(detail),
  ]);
}

export async function insertBalance(
  db: pg.Pool,
  runId: string,
  chain: string,
  asset: string,
  amount: bigint,
  usd: number,
): Promise<void> {
  await db.query(
    "INSERT INTO live_balances (run_id, chain, asset, amount, usd) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [runId, chain, asset, amount.toString(), usd],
  );
}

export async function insertBridge(
  db: pg.Pool,
  b: {
    runId: string;
    mode: string;
    slug: string;
    from: string;
    to: string;
    amountSent: bigint;
    amountReceived?: bigint;
    lzFeeNative?: bigint;
    lzFeeUsd?: number;
    txHash?: string;
    guid?: string;
    explorer?: string | null;
    status: string;
    error?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO live_bridges (run_id, mode, slug, from_chain, to_chain, amount_sent, amount_received, lz_fee_native, lz_fee_usd, tx_hash, guid, explorer_url, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      b.runId,
      b.mode,
      b.slug,
      b.from,
      b.to,
      b.amountSent.toString(),
      b.amountReceived?.toString() ?? null,
      b.lzFeeNative?.toString() ?? null,
      b.lzFeeUsd ?? null,
      b.txHash ?? null,
      b.guid ?? null,
      b.explorer ?? null,
      b.status,
      b.error ?? null,
    ],
  );
}
