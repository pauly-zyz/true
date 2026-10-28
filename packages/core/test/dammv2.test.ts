// Cross-checks the bigint DAMM v2 port against the official @meteora-ag/cp-amm-sdk functions.
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import * as sdk from "@meteora-ag/cp-amm-sdk";
import {
  applyDammV2Swap,
  dammV2Reserves,
  dammV2SwapExactIn,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getExcludedFeeAmount,
  getFeeMode,
  getIncludedFeeAmount,
  getNextSqrtPriceFromAmountInARoundingUp,
  getNextSqrtPriceFromAmountInBRoundingDown,
  sqrtPriceFromReserves,
  type DammV2PoolState,
} from "../src/math/dammv2/index.js";
import { dammV2PriceAInB } from "../src/math/price.js";

const bn = (x: bigint) => new BN(x.toString());
const big = (x: BN) => BigInt(x.toString());

const MIN = BigInt(sdk.MIN_SQRT_PRICE.toString());
const MAX = BigInt(sdk.MAX_SQRT_PRICE.toString());
const Q64 = 1n << 64n;

/** token A = 9-dec Pangea token, token B = SOL (9 dec). Price 1 token = 1e-6 SOL. */
function pool(overrides: Partial<DammV2PoolState> = {}): DammV2PoolState {
  // sqrt(1e-6) * 2^64
  const sqrtPrice = Q64 / 1000n;
  return {
    collectFeeMode: 1,
    sqrtPrice,
    sqrtMinPrice: MIN,
    sqrtMaxPrice: MAX,
    liquidity: 10n ** 12n * (1n << 64n) * 1000n, // fairly deep
    tokenAAmount: 0n,
    tokenBAmount: 0n,
    tradeFeeNumerator: 10_000_000n, // 1%
    ...overrides,
  };
}

describe("DAMM v2 primitives vs official SDK", () => {
  const p = pool();
  const amounts = [1n, 999n, 10n ** 9n, 123456789012345n, 10n ** 18n];

  it("fee mode table matches", () => {
    for (const mode of [0, 1, 2] as const) {
      for (const aToB of [true, false]) {
        const ref = sdk.getFeeMode(mode, aToB ? 0 : 1, false);
        const mine = getFeeMode(mode, aToB);
        expect(mine.feesOnInput).toBe(ref.feesOnInput);
        expect(mine.feesOnTokenA).toBe(ref.feesOnTokenA);
      }
    }
  });

  it("fee inclusion/exclusion matches", () => {
    for (const a of amounts) {
      const ref = sdk.getExcludedFeeAmount(bn(p.tradeFeeNumerator), bn(a));
      const mine = getExcludedFeeAmount(p.tradeFeeNumerator, a);
      expect(mine.excludedFeeAmount).toBe(big(ref.excludedFeeAmount));
      expect(mine.tradingFee).toBe(big(ref.tradingFee));
      const ref2 = sdk.getIncludedFeeAmount(bn(p.tradeFeeNumerator), bn(a));
      const mine2 = getIncludedFeeAmount(p.tradeFeeNumerator, a);
      expect(mine2.includedFeeAmount).toBe(big(ref2.includedFeeAmount));
    }
  });

  it("concentrated liquidity amount/price functions match", () => {
    for (const a of amounts) {
      expect(getNextSqrtPriceFromAmountInARoundingUp(p.sqrtPrice, p.liquidity, a)).toBe(
        big(sdk.getNextSqrtPriceFromAmountInARoundingUp(bn(p.sqrtPrice), bn(p.liquidity), bn(a))),
      );
      expect(getNextSqrtPriceFromAmountInBRoundingDown(p.sqrtPrice, p.liquidity, a)).toBe(
        big(sdk.getNextSqrtPriceFromAmountInBRoundingDown(bn(p.sqrtPrice), bn(p.liquidity), bn(a))),
      );
    }
    const lo = p.sqrtPrice / 2n;
    for (const up of [true, false]) {
      expect(getAmountAFromLiquidityDelta(lo, p.sqrtPrice, p.liquidity, up)).toBe(
        big(sdk.getAmountAFromLiquidityDeltaForConcentratedLiquidity(bn(lo), bn(p.sqrtPrice), bn(p.liquidity), up ? 0 : 1)),
      );
      expect(getAmountBFromLiquidityDelta(lo, p.sqrtPrice, p.liquidity, up)).toBe(
        big(sdk.getAmountBFromLiquidityDeltaForConcentratedLiquidity(bn(lo), bn(p.sqrtPrice), bn(p.liquidity), up ? 0 : 1)),
      );
    }
  });

  it("concentrated partial-input swap matches SDK step functions", () => {
    for (const a of amounts) {
      const refAB = sdk.calculateAtoBFromPartialAmountInForConcentratedLiquidity(
        bn(p.sqrtMinPrice),
        bn(p.sqrtPrice),
        bn(p.liquidity),
        bn(a),
      );
      const refBA = sdk.calculateBtoAFromPartialAmountInForConcentratedLiquidity(
        bn(p.sqrtMaxPrice),
        bn(p.sqrtPrice),
        bn(p.liquidity),
        bn(a),
      );
      // zero-fee pool isolates the curve math
      const z = { ...p, tradeFeeNumerator: 0n };
      expect(dammV2SwapExactIn(z, a, true).amountOut).toBe(big(refAB.outputAmount));
      expect(dammV2SwapExactIn(z, a, false).amountOut).toBe(big(refBA.outputAmount));
      expect(dammV2SwapExactIn(z, a, true).nextSqrtPrice).toBe(big(refAB.nextSqrtPrice));
    }
  });

  it("compounding constant-product matches SDK", () => {
    const A = 10n ** 18n;
    const B = 10n ** 12n;
    for (const a of amounts) {
      const ref = sdk.calculateAtoBFromAmountInForCompoundingLiquidity(bn(A), bn(B), bn(a));
      const s = pool({ collectFeeMode: 2, tokenAAmount: A, tokenBAmount: B, tradeFeeNumerator: 0n });
      expect(dammV2SwapExactIn(s, a, true).amountOut).toBe(big(ref.outputAmount));
    }
    expect(sqrtPriceFromReserves(A, B)).toBe(big(sdk.getSqrtPriceFromAmountsForCompoundingLiquidity(bn(A), bn(B))));
  });
});

describe("DAMM v2 swap behaviour", () => {
  it("charges the fee on output for A->B in OnlyB mode and on input for B->A", () => {
    const p = pool();
    const ab = dammV2SwapExactIn(p, 10n ** 12n, true);
    const abNoFee = dammV2SwapExactIn({ ...p, tradeFeeNumerator: 0n }, 10n ** 12n, true);
    expect(ab.amountIn).toBe(10n ** 12n);
    expect(ab.amountOut + ab.feeAmount).toBe(abNoFee.amountOut);

    const ba = dammV2SwapExactIn(p, 10n ** 9n, false);
    expect(ba.feeAmount).toBe(10n ** 7n); // 1% of input
  });

  it("partial fill at the range boundary returns unused input", () => {
    const lo = Q64 / 1000n - Q64 / 100000n; // just below current price
    const p = pool({ sqrtMinPrice: lo, liquidity: 10n ** 9n * (1n << 64n) });
    const r = dammV2SwapExactIn(p, 10n ** 20n, true);
    expect(r.partialFill).toBe(true);
    expect(r.amountIn < 10n ** 20n).toBe(true);
    expect(r.nextSqrtPrice).toBe(lo);
  });

  it("big trades suffer much worse execution than small ones (slippage)", () => {
    const p = pool({ liquidity: 10n ** 9n * (1n << 64n) });
    const [resA] = dammV2Reserves(p);
    const small = dammV2SwapExactIn(p, 10n ** 9n, true); // 1 token vs ~1000-token reserve
    const big = dammV2SwapExactIn(p, resA, true); // sell an amount equal to the whole token reserve
    const pxSmall = Number(small.amountOut) / Number(small.amountIn);
    const pxBig = Number(big.amountOut) / Number(big.amountIn);
    expect(pxBig).toBeLessThan(pxSmall * 0.6);
  });

  it("applyDammV2Swap moves the price in the right direction", () => {
    const p = pool();
    const r = dammV2SwapExactIn(p, 10n ** 15n, true);
    const next = applyDammV2Swap(p, r, true);
    expect(next.sqrtPrice < p.sqrtPrice).toBe(true);
  });

  it("price helper reads Q64.64", () => {
    expect(dammV2PriceAInB(Q64 / 1000n, 9, 9)).toBeCloseTo(1e-6, 12);
  });
});
