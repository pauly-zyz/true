import type pg from "pg";
import { v4Price1In0, type ChainName } from "@true/core";
import type { SwapUpdate } from "../live/evmWatcher.js";

/** Persist one v4 Swap. Quote is currency0 (native, 18 dec), token is currency1 (9 dec). */
export async function insertV4Swap(db: pg.Pool, chain: ChainName, slug: string, u: SwapUpdate, ts = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO swaps (ts, chain, slug, block, tx_hash, log_index, sqrt_price, liquidity, tick, amount_token, amount_quote, fee, price_quote, price_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)
     ON CONFLICT DO NOTHING`,
    [
      ts,
      chain,
      slug,
      u.blockNumber.toString(),
      u.txHash,
      u.logIndex,
      u.sqrtPriceX96.toString(),
      u.liquidity.toString(),
      u.tick,
      // pool perspective (+ = into the pool): v4 deltas are from the swapper's side, so negate
      (-u.amount1).toString(),
      (-u.amount0).toString(),
      u.fee,
      v4Price1In0(u.sqrtPriceX96, 18, 9),
    ],
  );
}
