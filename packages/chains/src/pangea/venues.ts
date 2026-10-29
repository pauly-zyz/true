// Builds exact pool models (Venues) from one /api/pools reading.
//
// Uniswap v4 (EVM): every Pangea pool holds ONE position [minUsableTick, tickUpper] with liquidity L
// (verified on Robinhood via ModifyLiquidity at launch). The API gives L, sqrtPriceX96 and reserves,
// from which tickUpper follows exactly: amount0 = L * Q96 * (1/sqrtP - 1/sqrtUpper).
// The trading fee is charged by Pangea's hook on the quote side (LP fee 0).
//
// Meteora DAMM v2 (Solana): one concentrated position [sqrtMin, sqrtMax]; sqrtMin follows from the SOL
// reserve (amountB = L * (sqrtP - sqrtMin) / 2^128) and sqrtMax from the token reserve. Fees are
// collected in SOL (collect-fee mode OnlyB), so the fee is on SOL: input on buys, output on sells.
import {
  dammv2,
  dammV2Venue,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  MAX_TICK,
  MIN_TICK,
  v4Venue,
  type Venue,
} from "@true/core";
import type { PangeaPool } from "./pools.js";

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
/** Meteora DAMM v2 MAX_SQRT_PRICE (cp-amm-sdk 1.5.1 constants). */
export const DAMM_MAX_SQRT_PRICE = 79226673521066979257578248091n;

export interface VenueBuildOptions {
  feePips: number; // trading fee, e.g. 10000 = 1%
  tokenDecimals: number;
  tickSpacing?: number; // 60 on every Pangea pool observed so far
}

/** Human float -> raw bigint (good to ~15 significant digits, enough for range derivation). */
function rawFromHuman(x: number, decimals: number): bigint {
  if (!Number.isFinite(x) || x < 0) throw new Error(`bad amount ${x}`);
  const s = x.toFixed(Math.min(decimals, 20));
  const [i, f = ""] = s.split(".");
  return BigInt(i! + f.padEnd(decimals, "0").slice(0, decimals));
}

export function deriveV4UpperTick(p: PangeaPool, tickSpacing: number): number {
  const L = BigInt(p.liquidity!);
  const sqrtP = BigInt(p.sqrtPriceX96!);
  const r0 = rawFromHuman(p.reserves ?? 0, p.quoteDecimals ?? 18);
  // 1/sqrtUpper = 1/sqrtP - r0/(L*Q96)  ->  sqrtUpper = L*Q96*sqrtP / (L*Q96 - r0*sqrtP)
  const den = L * Q96 - r0 * sqrtP;
  if (den <= 0n) throw new Error("inconsistent reserves");
  const sqrtUpper = (L * Q96 * sqrtP) / den;
  const t = sqrtUpper >= getSqrtPriceAtTick(MAX_TICK) ? MAX_TICK : getTickAtSqrtPrice(sqrtUpper);
  return Math.round(t / tickSpacing) * tickSpacing;
}

export function v4VenueFromPangea(p: PangeaPool, o: VenueBuildOptions): Venue {
  if (!p.liquidity || !p.sqrtPriceX96 || p.tick == null) throw new Error(`${p.chain}: missing pool state`);
  const tickSpacing = o.tickSpacing ?? 60;
  const L = BigInt(p.liquidity);
  const sqrtPriceX96 = BigInt(p.sqrtPriceX96);
  const lower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const upper = deriveV4UpperTick(p, tickSpacing);
  return v4Venue({
    chain: p.chain,
    tokenIsCurrency0: false, // native quote (address 0) is always currency0
    tokenDecimals: o.tokenDecimals,
    quoteDecimals: p.quoteDecimals ?? 18,
    quoteHookFeePips: BigInt(o.feePips),
    state: {
      sqrtPriceX96,
      tick: p.tick,
      liquidity: p.tick < upper ? L : 0n,
      tickSpacing,
      feePips: 0n,
      ticks: [
        { tick: lower, liquidityNet: L },
        { tick: upper, liquidityNet: -L },
      ],
    },
  });
}

export function dammV2VenueFromPangea(p: PangeaPool, o: VenueBuildOptions): Venue {
  if (!p.liquidity || !p.sqrtPriceX96) throw new Error(`${p.chain}: missing pool state`);
  const L = BigInt(p.liquidity);
  const sqrtPrice = BigInt(p.sqrtPriceX96);
  const quoteDecimals = p.quoteDecimals ?? 9;
  const rb = rawFromHuman(p.reserves ?? 0, quoteDecimals);
  const ra = rawFromHuman(p.tokenReserves ?? 0, o.tokenDecimals);
  let sqrtMin = sqrtPrice - (rb * Q128) / L;
  if (sqrtMin <= 0n) sqrtMin = 1n;
  // 1/sqrtMax = 1/sqrtP - ra/L  (A amounts: L*(sqrtMax - sqrtP)/(sqrtP*sqrtMax))
  const den = L - ra * sqrtPrice;
  let sqrtMax = den > 0n ? (L * sqrtPrice) / den : DAMM_MAX_SQRT_PRICE;
  if (sqrtMax > DAMM_MAX_SQRT_PRICE) sqrtMax = DAMM_MAX_SQRT_PRICE;
  const state: dammv2.DammV2PoolState = {
    collectFeeMode: 1,
    sqrtPrice,
    sqrtMinPrice: sqrtMin,
    sqrtMaxPrice: sqrtMax,
    liquidity: L,
    tokenAAmount: 0n,
    tokenBAmount: 0n,
    tradeFeeNumerator: BigInt(o.feePips) * 1000n, // pips/1e6 == numerator/1e9
  };
  return dammV2Venue({ chain: "solana", state, tokenIsA: true, tokenDecimals: o.tokenDecimals, quoteDecimals });
}

export function venueFromPangea(p: PangeaPool, o: VenueBuildOptions): Venue {
  if (p.chain === "solana") return dammV2VenueFromPangea(p, o);
  return v4VenueFromPangea(p, o);
}
