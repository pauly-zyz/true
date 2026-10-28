// Meteora DAMM v2 (cp-amm) swap math in bigint, ported from @meteora-ag/cp-amm-sdk 1.5.1
// (src/math/liquidity/*, src/math/fee*, getSwapResultFromPartialInput). The trade fee numerator
// is passed in already resolved (base fee scheduler + dynamic fee), because it depends on
// on-chain clock/volatility state; packages/chains resolves it with the official SDK.

export const SCALE_OFFSET = 64n;
export const FEE_DENOMINATOR = 1_000_000_000n;

/** 0 = BothToken, 1 = OnlyB, 2 = Compounding (cp-amm CollectFeeMode). */
export type CollectFeeMode = 0 | 1 | 2;

export interface DammV2PoolState {
  collectFeeMode: CollectFeeMode;
  /** Q64.64 sqrt price (token B per token A, raw units). */
  sqrtPrice: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  liquidity: bigint;
  /** Only used in Compounding mode (reserves define the curve). */
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  /** Total trade fee numerator over FEE_DENOMINATOR (1e9), base + dynamic, already capped. */
  tradeFeeNumerator: bigint;
}

export interface DammV2SwapResult {
  /** Input actually consumed, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  /** True if the price range boundary was hit before the input was used up. */
  partialFill: boolean;
  nextSqrtPrice: bigint;
}

function mulDiv(x: bigint, y: bigint, d: bigint, roundUp: boolean): bigint {
  const p = x * y;
  const q = p / d;
  return roundUp && p % d !== 0n ? q + 1n : q;
}

/** cp-amm getFeeMode: which side the fee is charged on. */
export function getFeeMode(mode: CollectFeeMode, aToB: boolean): { feesOnInput: boolean; feesOnTokenA: boolean } {
  switch (mode) {
    case 0:
      return { feesOnInput: false, feesOnTokenA: !aToB };
    case 1:
    case 2:
      return { feesOnInput: !aToB, feesOnTokenA: false };
    default:
      throw new Error(`invalid collectFeeMode ${String(mode)}`);
  }
}

export function getExcludedFeeAmount(tradeFeeNumerator: bigint, includedFeeAmount: bigint) {
  const tradingFee = mulDiv(includedFeeAmount, tradeFeeNumerator, FEE_DENOMINATOR, true);
  return { excludedFeeAmount: includedFeeAmount - tradingFee, tradingFee };
}

export function getIncludedFeeAmount(tradeFeeNumerator: bigint, excludedFeeAmount: bigint) {
  const denominator = FEE_DENOMINATOR - tradeFeeNumerator;
  if (denominator <= 0n) throw new Error("InvalidFee");
  const includedFeeAmount = mulDiv(excludedFeeAmount, FEE_DENOMINATOR, denominator, true);
  return { includedFeeAmount, feeAmount: includedFeeAmount - excludedFeeAmount };
}

// --- concentrated liquidity (single price range) ---

export function getAmountAFromLiquidityDelta(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean) {
  const den = lower * upper;
  if (den <= 0n) throw new Error("MathOverflow: denominator must be > 0");
  return mulDiv(liquidity, upper - lower, den, roundUp);
}

export function getAmountBFromLiquidityDelta(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean) {
  const prod = liquidity * (upper - lower);
  const shift = SCALE_OFFSET * 2n;
  if (roundUp) {
    const den = 1n << shift;
    return (prod + den - 1n) / den;
  }
  return prod >> shift;
}

export function getNextSqrtPriceFromAmountInARoundingUp(sqrtPrice: bigint, liquidity: bigint, amount: bigint) {
  if (amount === 0n) return sqrtPrice;
  return mulDiv(liquidity, sqrtPrice, liquidity + amount * sqrtPrice, true);
}

export function getNextSqrtPriceFromAmountInBRoundingDown(sqrtPrice: bigint, liquidity: bigint, amount: bigint) {
  return sqrtPrice + (amount << (SCALE_OFFSET * 2n)) / liquidity;
}

function concentratedPartial(s: DammV2PoolState, amountIn: bigint, aToB: boolean) {
  if (s.sqrtPrice <= 0n || s.liquidity <= 0n) throw new Error("InvalidInput: price and liquidity must be > 0");
  if (aToB) {
    const maxIn = getAmountAFromLiquidityDelta(s.sqrtMinPrice, s.sqrtPrice, s.liquidity, true);
    const [consumed, next] =
      amountIn >= maxIn
        ? [maxIn, s.sqrtMinPrice]
        : [amountIn, getNextSqrtPriceFromAmountInARoundingUp(s.sqrtPrice, s.liquidity, amountIn)];
    const out = getAmountBFromLiquidityDelta(next, s.sqrtPrice, s.liquidity, false);
    return { outputAmount: out, nextSqrtPrice: next, amountLeft: amountIn - consumed };
  }
  const maxIn = getAmountBFromLiquidityDelta(s.sqrtPrice, s.sqrtMaxPrice, s.liquidity, true);
  const [consumed, next] =
    amountIn >= maxIn
      ? [maxIn, s.sqrtMaxPrice]
      : [amountIn, getNextSqrtPriceFromAmountInBRoundingDown(s.sqrtPrice, s.liquidity, amountIn)];
  const out = getAmountAFromLiquidityDelta(s.sqrtPrice, next, s.liquidity, false);
  return { outputAmount: out, nextSqrtPrice: next, amountLeft: amountIn - consumed };
}

// --- compounding liquidity (constant product on reserves) ---

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = v;
  let y = (v + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + v / x) / 2n;
  }
  return x;
}

export function sqrtPriceFromReserves(tokenA: bigint, tokenB: bigint): bigint {
  return isqrt((tokenB << 128n) / tokenA);
}

function compoundingIn(s: DammV2PoolState, amountIn: bigint, aToB: boolean) {
  const out = aToB
    ? mulDiv(s.tokenBAmount, amountIn, s.tokenAAmount + amountIn, false)
    : mulDiv(s.tokenAAmount, amountIn, s.tokenBAmount + amountIn, false);
  return { outputAmount: out, nextSqrtPrice: 0n, amountLeft: 0n };
}

/**
 * Exact-input swap with cp-amm "partial input" semantics: if the range boundary is reached,
 * the remaining input is returned unused (partialFill = true).
 */
export function dammV2SwapExactIn(s: DammV2PoolState, amountIn: bigint, aToB: boolean): DammV2SwapResult {
  if (amountIn <= 0n) throw new Error("AmountIsZero");
  const feeMode = getFeeMode(s.collectFeeMode, aToB);
  const fee = s.tradeFeeNumerator;

  let actualIn = amountIn;
  let feeAmount = 0n;
  if (feeMode.feesOnInput) {
    const r = getExcludedFeeAmount(fee, amountIn);
    actualIn = r.excludedFeeAmount;
    feeAmount = r.tradingFee;
  }

  const swap = s.collectFeeMode === 2 ? compoundingIn(s, actualIn, aToB) : concentratedPartial(s, actualIn, aToB);

  let includedIn = amountIn;
  if (swap.amountLeft > 0n) {
    actualIn -= swap.amountLeft;
    if (feeMode.feesOnInput) {
      const r = getIncludedFeeAmount(fee, actualIn);
      includedIn = r.includedFeeAmount;
      feeAmount = r.feeAmount;
    } else {
      includedIn = actualIn;
    }
  }

  let amountOut = swap.outputAmount;
  if (!feeMode.feesOnInput) {
    const r = getExcludedFeeAmount(fee, swap.outputAmount);
    amountOut = r.excludedFeeAmount;
    feeAmount = r.tradingFee;
  }

  let nextSqrtPrice = swap.nextSqrtPrice;
  if (s.collectFeeMode === 2) {
    // reserves after the swap (protocol/claiming fees leave the curve; compounding fee split is
    // ignored here, which only affects the post-trade price by a few bps of the fee)
    const outIncl = feeMode.feesOnInput ? amountOut : amountOut + feeAmount;
    const a = aToB ? s.tokenAAmount + actualIn : s.tokenAAmount - outIncl;
    const b = aToB ? s.tokenBAmount - outIncl : s.tokenBAmount + actualIn;
    nextSqrtPrice = sqrtPriceFromReserves(a, b);
  }

  return { amountIn: includedIn, amountOut, feeAmount, partialFill: swap.amountLeft > 0n, nextSqrtPrice };
}

/** Pool reserves (token A, token B) implied by the curve. */
export function dammV2Reserves(s: DammV2PoolState): [bigint, bigint] {
  if (s.collectFeeMode === 2) return [s.tokenAAmount, s.tokenBAmount];
  return [
    getAmountAFromLiquidityDelta(s.sqrtPrice, s.sqrtMaxPrice, s.liquidity, true),
    getAmountBFromLiquidityDelta(s.sqrtMinPrice, s.sqrtPrice, s.liquidity, true),
  ];
}

/** Post-swap state for chaining simulated trades. */
export function applyDammV2Swap(s: DammV2PoolState, r: DammV2SwapResult, aToB: boolean): DammV2PoolState {
  if (s.collectFeeMode !== 2) return { ...s, sqrtPrice: r.nextSqrtPrice };
  const feeMode = getFeeMode(s.collectFeeMode, aToB);
  const inExcl = feeMode.feesOnInput ? r.amountIn - r.feeAmount : r.amountIn;
  const outIncl = feeMode.feesOnInput ? r.amountOut : r.amountOut + r.feeAmount;
  return aToB
    ? { ...s, tokenAAmount: s.tokenAAmount + inExcl, tokenBAmount: s.tokenBAmount - outIncl, sqrtPrice: r.nextSqrtPrice }
    : { ...s, tokenBAmount: s.tokenBAmount + inExcl, tokenAAmount: s.tokenAAmount - outIncl, sqrtPrice: r.nextSqrtPrice };
}
