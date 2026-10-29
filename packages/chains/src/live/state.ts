// Live pool state per (coin, chain). Seeded from an /api/pools reading (which also gives the static
// position range), then updated exactly from on-chain Swap events where an RPC is available.
import { dammV2Venue, getSqrtPriceAtTick, getTickAtSqrtPrice, MAX_TICK, MIN_TICK, v4Venue, type ChainName, type Venue } from "@true/core";
import type { PangeaPool } from "../pangea/pools.js";
import { DAMM_MAX_SQRT_PRICE, rawFromHuman } from "../pangea/rawUnits.js";

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;

export type StateSource = "snapshot" | "rpc";

interface Common {
  chain: ChainName;
  poolId: string;
  quoteDecimals: number;
  feePips: number;
  updatedAt: number; // ms
  source: StateSource;
}

export interface V4LiveState extends Common {
  kind: "v4";
  sqrtPriceX96: bigint;
  tick: number;
  /** Active liquidity right now (0 if the price left the position's range). */
  liquidity: bigint;
  /** Liquidity of Pangea's single locked position. */
  positionLiquidity: bigint;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
}

export interface DammLiveState extends Common {
  kind: "damm";
  sqrtPrice: bigint;
  liquidity: bigint;
  sqrtMin: bigint;
  sqrtMax: bigint;
}

export type LiveState = V4LiveState | DammLiveState;

export function deriveV4UpperTick(p: PangeaPool, tickSpacing: number): number {
  const L = BigInt(p.liquidity!);
  const sqrtP = BigInt(p.sqrtPriceX96!);
  const r0 = rawFromHuman(p.reserves ?? 0, p.quoteDecimals ?? 18);
  // amount0 = L*Q96*(1/sqrtP - 1/sqrtUpper)  ->  sqrtUpper = L*Q96*sqrtP / (L*Q96 - r0*sqrtP)
  const den = L * Q96 - r0 * sqrtP;
  if (den <= 0n) throw new Error("inconsistent reserves");
  const sqrtUpper = (L * Q96 * sqrtP) / den;
  const t = sqrtUpper >= getSqrtPriceAtTick(MAX_TICK) ? MAX_TICK : getTickAtSqrtPrice(sqrtUpper);
  return Math.round(t / tickSpacing) * tickSpacing;
}

export function liveStateFromPangea(p: PangeaPool, feePips: number, now: number, tickSpacing = 60, tokenDecimals = 9): LiveState {
  if (!p.liquidity || !p.sqrtPriceX96 || !p.poolId) throw new Error(`${p.chain}: missing pool state`);
  if (p.chain === "solana") {
    const L = BigInt(p.liquidity);
    const sqrtPrice = BigInt(p.sqrtPriceX96);
    const quoteDecimals = p.quoteDecimals ?? 9;
    const rb = rawFromHuman(p.reserves ?? 0, quoteDecimals);
    const ra = rawFromHuman(p.tokenReserves ?? 0, tokenDecimals);
    let sqrtMin = sqrtPrice - (rb * Q128) / L;
    if (sqrtMin <= 0n) sqrtMin = 1n;
    const den = L - ra * sqrtPrice;
    let sqrtMax = den > 0n ? (L * sqrtPrice) / den : DAMM_MAX_SQRT_PRICE;
    if (sqrtMax > DAMM_MAX_SQRT_PRICE) sqrtMax = DAMM_MAX_SQRT_PRICE;
    return { kind: "damm", chain: "solana", poolId: p.poolId, quoteDecimals, feePips, updatedAt: now, source: "snapshot", sqrtPrice, liquidity: L, sqrtMin, sqrtMax };
  }
  if (p.tick == null) throw new Error(`${p.chain}: missing tick`);
  const L = BigInt(p.liquidity);
  const tickUpper = deriveV4UpperTick(p, tickSpacing);
  return {
    kind: "v4",
    chain: p.chain,
    poolId: p.poolId,
    quoteDecimals: p.quoteDecimals ?? 18,
    feePips,
    updatedAt: now,
    source: "snapshot",
    sqrtPriceX96: BigInt(p.sqrtPriceX96),
    tick: p.tick,
    liquidity: p.tick < tickUpper ? L : 0n,
    positionLiquidity: L,
    tickLower: Math.ceil(MIN_TICK / tickSpacing) * tickSpacing,
    tickUpper,
    tickSpacing,
  };
}

/** Apply a v4 PoolManager Swap event (post-swap price, tick and active liquidity). */
export function applyV4Swap(s: V4LiveState, ev: { sqrtPriceX96: bigint; tick: number; liquidity: bigint }, ts: number): V4LiveState {
  return { ...s, sqrtPriceX96: ev.sqrtPriceX96, tick: ev.tick, liquidity: ev.liquidity, updatedAt: ts, source: "rpc" };
}

/** Apply a decoded DAMM v2 pool account (sqrt price and liquidity). */
export function applyDammUpdate(s: DammLiveState, u: { sqrtPrice: bigint; liquidity: bigint }, ts: number): DammLiveState {
  return { ...s, sqrtPrice: u.sqrtPrice, liquidity: u.liquidity, updatedAt: ts, source: "rpc" };
}

export function venueFromLive(s: LiveState, tokenDecimals = 9): Venue {
  if (s.kind === "damm") {
    return dammV2Venue({
      chain: "solana",
      tokenIsA: true,
      tokenDecimals,
      quoteDecimals: s.quoteDecimals,
      state: {
        collectFeeMode: 1, // fees in SOL
        sqrtPrice: s.sqrtPrice,
        sqrtMinPrice: s.sqrtMin,
        sqrtMaxPrice: s.sqrtMax,
        liquidity: s.liquidity,
        tokenAAmount: 0n,
        tokenBAmount: 0n,
        tradeFeeNumerator: BigInt(s.feePips) * 1000n,
      },
    });
  }
  return v4Venue({
    chain: s.chain,
    tokenIsCurrency0: false, // native quote is currency0
    tokenDecimals,
    quoteDecimals: s.quoteDecimals,
    quoteHookFeePips: BigInt(s.feePips),
    state: {
      sqrtPriceX96: s.sqrtPriceX96,
      tick: s.tick,
      liquidity: s.liquidity,
      tickSpacing: s.tickSpacing,
      feePips: 0n,
      ticks: [
        { tick: s.tickLower, liquidityNet: s.positionLiquidity },
        { tick: s.tickUpper, liquidityNet: -s.positionLiquidity },
      ],
    },
  });
}
