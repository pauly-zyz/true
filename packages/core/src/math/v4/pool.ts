// Off-chain replica of the Uniswap v4 Pool.swap loop (v4-core src/libraries/Pool.sol),
// driven by a snapshot of initialized ticks instead of on-chain storage.
// Hooks are NOT modelled: if a pool's hook changes swap deltas (beforeSwap/afterSwap return
// deltas), results will differ. The effective fee should be taken from on-chain Swap events.
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice } from "./tickMath.js";
import { MAX_SWAP_FEE, computeSwapStep, getSqrtPriceTarget } from "./swapMath.js";

export interface TickLiquidity {
  tick: number;
  /** Signed liquidity delta applied when crossing this tick left-to-right. */
  liquidityNet: bigint;
}

export interface V4PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** Active (in-range) liquidity. */
  liquidity: bigint;
  tickSpacing: number;
  /** Effective swap fee in pips (LP fee combined with protocol fee). */
  feePips: bigint;
  /** Initialized ticks, sorted ascending by tick. */
  ticks: readonly TickLiquidity[];
}

export interface V4SwapParams {
  zeroForOne: boolean;
  /** v4 convention: negative = exact input, positive = exact output. */
  amountSpecified: bigint;
  sqrtPriceLimitX96?: bigint;
}

export interface V4SwapResult {
  /** Total input paid by the swapper, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  sqrtPriceX96After: bigint;
  tickAfter: number;
  liquidityAfter: bigint;
  ticksCrossed: number;
  /** True when the requested amount could not be fully filled (price limit / liquidity ran out). */
  partialFill: boolean;
}

function compress(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing);
}

/** Index of the first element with compressed tick >= c. */
function lowerBound(compressed: readonly number[], c: number): number {
  let lo = 0;
  let hi = compressed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compressed[mid]! < c) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Same semantics as TickBitmap.nextInitializedTickWithinOneWord. */
export function nextInitializedTickWithinOneWord(
  compressedTicks: readonly number[],
  tick: number,
  tickSpacing: number,
  lte: boolean,
): { next: number; initialized: boolean } {
  let compressed = compress(tick, tickSpacing);
  if (lte) {
    const bitPos = compressed & 0xff;
    const wordStart = compressed - bitPos;
    // largest initialized c with wordStart <= c <= compressed
    const idx = lowerBound(compressedTicks, compressed + 1) - 1;
    if (idx >= 0 && compressedTicks[idx]! >= wordStart) {
      return { next: compressedTicks[idx]! * tickSpacing, initialized: true };
    }
    return { next: wordStart * tickSpacing, initialized: false };
  }
  compressed += 1;
  const bitPos = compressed & 0xff;
  const wordEnd = compressed - bitPos + 255;
  const idx = lowerBound(compressedTicks, compressed);
  if (idx < compressedTicks.length && compressedTicks[idx]! <= wordEnd) {
    return { next: compressedTicks[idx]! * tickSpacing, initialized: true };
  }
  return { next: wordEnd * tickSpacing, initialized: false };
}

function hasInitializedBeyond(compressedTicks: readonly number[], tick: number, tickSpacing: number, lte: boolean) {
  const c = compress(tick, tickSpacing);
  return lte ? compressedTicks.length > 0 && compressedTicks[0]! <= c : compressedTicks.at(-1)! > c;
}

export function v4Swap(state: V4PoolState, params: V4SwapParams): V4SwapResult {
  const { zeroForOne, amountSpecified } = params;
  const limit = params.sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n);
  const feePips = state.feePips;

  if (feePips >= MAX_SWAP_FEE && amountSpecified > 0n) throw new Error("InvalidFeeForExactOut");
  if (zeroForOne) {
    if (limit >= state.sqrtPriceX96) throw new Error("PriceLimitAlreadyExceeded");
    if (limit <= MIN_SQRT_PRICE) throw new Error("PriceLimitOutOfBounds");
  } else {
    if (limit <= state.sqrtPriceX96) throw new Error("PriceLimitAlreadyExceeded");
    if (limit >= MAX_SQRT_PRICE) throw new Error("PriceLimitOutOfBounds");
  }

  const tickMap = new Map(state.ticks.map((t) => [t.tick, t.liquidityNet]));
  const compressedTicks = state.ticks.map((t) => compress(t.tick, state.tickSpacing));

  let remaining = amountSpecified;
  let calculated = 0n;
  let feeTotal = 0n;
  let sqrtPriceX96 = state.sqrtPriceX96;
  let tick = state.tick;
  let liquidity = state.liquidity;
  let ticksCrossed = 0;

  while (remaining !== 0n && sqrtPriceX96 !== limit) {
    const sqrtPriceStart = sqrtPriceX96;
    let { next: tickNext, initialized } = nextInitializedTickWithinOneWord(
      compressedTicks,
      tick,
      state.tickSpacing,
      zeroForOne,
    );

    // Shortcut (not in Solidity): with zero liquidity no amounts change, so jump straight to the
    // next initialized tick, or stop if there is none in this direction.
    if (liquidity === 0n && !initialized) {
      if (!hasInitializedBeyond(compressedTicks, tick, state.tickSpacing, zeroForOne)) {
        break;
      }
      const c = compress(tick, state.tickSpacing);
      const idx = zeroForOne ? lowerBound(compressedTicks, c + 1) - 1 : lowerBound(compressedTicks, c + 1);
      tickNext = compressedTicks[idx]! * state.tickSpacing;
      initialized = true;
    }

    if (tickNext <= MIN_TICK) tickNext = MIN_TICK;
    if (tickNext >= MAX_TICK) tickNext = MAX_TICK;
    const sqrtPriceNext = getSqrtPriceAtTick(tickNext);

    const step = computeSwapStep(
      sqrtPriceX96,
      getSqrtPriceTarget(zeroForOne, sqrtPriceNext, limit),
      liquidity,
      remaining,
      feePips,
    );
    sqrtPriceX96 = step.sqrtPriceNextX96;
    feeTotal += step.feeAmount;

    if (amountSpecified > 0n) {
      remaining -= step.amountOut;
      calculated -= step.amountIn + step.feeAmount;
    } else {
      remaining += step.amountIn + step.feeAmount;
      calculated += step.amountOut;
    }

    if (sqrtPriceX96 === sqrtPriceNext) {
      if (initialized) {
        let net = tickMap.get(tickNext) ?? 0n;
        if (zeroForOne) net = -net;
        liquidity += net;
        if (liquidity < 0n) throw new Error("LiquidityUnderflow: inconsistent tick snapshot");
        ticksCrossed++;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPriceX96 !== sqrtPriceStart) {
      tick = getTickAtSqrtPrice(sqrtPriceX96);
    }
  }

  const exactIn = amountSpecified < 0n;
  const filled = amountSpecified - remaining;
  return {
    amountIn: exactIn ? -filled : -calculated,
    amountOut: exactIn ? calculated : filled,
    feeAmount: feeTotal,
    sqrtPriceX96After: sqrtPriceX96,
    tickAfter: tick,
    liquidityAfter: liquidity,
    ticksCrossed,
    partialFill: remaining !== 0n,
  };
}
