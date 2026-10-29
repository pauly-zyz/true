import { existsSync, readFileSync } from "node:fs";
import type { CoinMeta } from "./live/store.js";

/**
 * Coins with a measured fee (data/phase0/fees.json, written by `pnpm phase0:fees`). Coins whose fee is
 * unknown are never traded: the fee is not in /api/pools and guessing it would mis-price every trade.
 */
export function loadCoinFees(file: string): Array<Omit<CoinMeta, "marketCapUsd">> {
  if (!existsSync(file)) throw new Error(`${file} not found: run \`pnpm --filter @true/scripts phase0:fees\` first`);
  const d = JSON.parse(readFileSync(file, "utf8")) as { coins: Record<string, { symbol?: string; feePips: number | null; tickSpacing?: number }> };
  return Object.entries(d.coins)
    .filter(([, c]) => typeof c.feePips === "number")
    .map(([slug, c]) => ({ slug, symbol: c.symbol ?? slug, feePips: c.feePips!, tickSpacing: c.tickSpacing ?? 60 }));
}
