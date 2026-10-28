// Synthetic pools for tests. Never used outside tests.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseConfig, type Config } from "../src/config.js";
import { getTickAtSqrtPrice, MAX_TICK, MIN_TICK } from "../src/math/v4/tickMath.js";
import { dammV2Venue, v4Venue, type Venue } from "../src/venue.js";
import type { ChainName } from "../src/chains.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw YAML mutated by tests
export function testConfig(overrides: (raw: Record<string, any>) => void = () => {}): Config {
  const raw = parse(readFileSync(new URL("../../../config/default.yaml", import.meta.url), "utf8"));
  overrides(raw);
  return parseConfig(raw, {});
}

export function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  // Newton's method from an over-estimate converges monotonically downwards.
  let x = BigInt(Math.ceil(Math.sqrt(Number(v)) * 1.0001)) + 1n;
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

const dec = (x: number, d: number) => BigInt(Math.round(x * 10 ** Math.min(d, 6))) * 10n ** BigInt(d - Math.min(d, 6));

/**
 * Full-range Uniswap v4 pool, native quote as currency0 and a 9-decimal token as currency1.
 * @param tokenPriceQuote price of 1 token in quote asset
 * @param quoteReserve quote asset in the pool (human units); token reserve follows from price
 */
export function v4FullRange(
  chain: ChainName,
  tokenPriceQuote: number,
  quoteReserve: number,
  feePips = 10_000n,
  quoteDecimals = 18,
): Venue {
  const quoteRaw = dec(quoteReserve, quoteDecimals);
  const tokenRaw = dec(quoteReserve / tokenPriceQuote, 9);
  const sqrtPriceX96 = isqrt((tokenRaw << 192n) / quoteRaw);
  const L = isqrt(quoteRaw * tokenRaw);
  const spacing = 200;
  const lo = Math.ceil(MIN_TICK / spacing) * spacing;
  const hi = Math.floor(MAX_TICK / spacing) * spacing;
  return v4Venue({
    chain,
    tokenIsCurrency0: false,
    tokenDecimals: 9,
    quoteDecimals,
    state: {
      sqrtPriceX96,
      tick: getTickAtSqrtPrice(sqrtPriceX96),
      liquidity: L,
      tickSpacing: spacing,
      feePips,
      ticks: [
        { tick: lo, liquidityNet: L },
        { tick: hi, liquidityNet: -L },
      ],
    },
  });
}

/** Meteora DAMM v2 compounding (constant-product) pool; token = A, SOL = B. */
export function dammCompounding(tokenPriceSol: number, solReserve: number, feeNumerator = 10_000_000n): Venue {
  const b = dec(solReserve, 9);
  const a = dec(solReserve / tokenPriceSol, 9);
  return dammV2Venue({
    chain: "solana",
    tokenIsA: true,
    tokenDecimals: 9,
    quoteDecimals: 9,
    state: {
      collectFeeMode: 2,
      sqrtPrice: isqrt((b << 128n) / a),
      sqrtMinPrice: 0n,
      sqrtMaxPrice: (1n << 128n) - 1n,
      liquidity: 1n,
      tokenAAmount: a,
      tokenBAmount: b,
      tradeFeeNumerator: feeNumerator,
    },
  });
}

export const mkt = (overrides: Partial<Record<ChainName, number>> = {}) => ({
  quoteUsd: { ethereum: 3000, base: 3000, robinhood: 3000, bsc: 600, solana: 150, ...overrides },
  gasPrice: { ethereum: 1, base: 0.01, robinhood: 0.01, bsc: 0.1, solana: 10000 },
});
