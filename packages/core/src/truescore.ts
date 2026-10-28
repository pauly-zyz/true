// True Score (RANCANGAN.md 4.1): how "flat" a coin's price is across chains.
import type { ChainName } from "./chains.js";

export interface SpreadResult {
  spread: number; // fraction, e.g. 0.01 = 1%
  minChain: ChainName;
  maxChain: ChainName;
  minPrice: number;
  maxPrice: number;
}

export function computeSpread(pricesUsd: Partial<Record<ChainName, number>>): SpreadResult | null {
  const entries = Object.entries(pricesUsd).filter(
    (e): e is [ChainName, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0,
  );
  if (entries.length < 2) return null;
  let [minChain, minPrice] = entries[0]!;
  let [maxChain, maxPrice] = entries[0]!;
  for (const [c, p] of entries) {
    if (p < minPrice) [minChain, minPrice] = [c, p];
    if (p > maxPrice) [maxChain, maxPrice] = [c, p];
  }
  return { spread: (maxPrice - minPrice) / minPrice, minChain, maxChain, minPrice, maxPrice };
}

/** TrueScore = max(0, 100 - spread% * multiplier). */
export function trueScore(spread: number, multiplier = 20): number {
  return Math.max(0, 100 - spread * 100 * multiplier);
}
