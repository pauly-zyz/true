// Golden tests against real Robinhood Chain transactions of $PANGEA (pool 0xcfe04bc1…, LP fee 0,
// trading fee charged by the Pangea hook on the quote side). Data read on-chain on 2026-10-29.
import { describe, expect, it } from "vitest";
import { v4Venue } from "../src/venue.js";
import { getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput } from "../src/math/v4/sqrtPriceMath.js";
import { getTickAtSqrtPrice } from "../src/math/v4/tickMath.js";

const L = 1097456632423063954n;
const Q96 = 1n << 96n;
const position = [
  { tick: -887220, liquidityNet: L },
  { tick: -1860, liquidityNet: -L },
];

function venueAt(sqrtPriceX96: bigint) {
  return v4Venue({
    chain: "robinhood",
    tokenIsCurrency0: false,
    tokenDecimals: 9,
    quoteDecimals: 18,
    quoteHookFeePips: 10_000n, // 1%
    state: { sqrtPriceX96, tick: getTickAtSqrtPrice(sqrtPriceX96), liquidity: L, tickSpacing: 60, feePips: 0n, ticks: position },
  });
}

/** Find the pre-swap price whose forward step lands exactly on the observed post-swap price. */
function preForZeroForOne(post: bigint, amount0In: bigint): bigint {
  const pre = (L * Q96 * post) / (L * Q96 - amount0In * post);
  for (let d = -5n; d <= 5n; d++) {
    if (getNextSqrtPriceFromInput(pre + d, L, amount0In, true) === post) return pre + d;
  }
  throw new Error("no exact pre-price");
}

describe("Pangea hook fee on Robinhood (real transactions)", () => {
  it("buy 0x5f911c4b: 0.004225189901291545 ETH in -> 6690.958706615 PANGEA, hook keeps 1% of input", () => {
    const post = 3168472505598757574038588058n;
    const pre = preForZeroForOne(post, 4182938002278630n);
    const fill = venueAt(pre).buyToken(4225189901291545n);
    expect(fill.amountOut).toBe(6690958706615n);
    expect(fill.feeAmount).toBe(42251899012915n); // the hook's ERC-6909 claim in the receipt
    expect(fill.amountIn).toBe(4225189901291545n);
  });

  it("sell 0x3f260878: 13933.9801857 PANGEA in -> user gets 0.008622688569412733 ETH, hook keeps 1% of output", () => {
    const post = 3169438688913804107048125812n;
    // token1 in (oneForZero): post = pre + amount1 * Q96 / L (rounded down) -> invert and check
    const amount1In = 13933980185700n;
    let pre = post - (amount1In * Q96) / L;
    for (let d = -3n; d <= 3n; d++) {
      if (getNextSqrtPriceFromInput(pre + d, L, amount1In, false) === post) {
        pre = pre + d;
        break;
      }
    }
    expect(getNextSqrtPriceFromInput(pre, L, amount1In, false)).toBe(post);
    const fill = venueAt(pre).sellToken(amount1In);
    expect(fill.amountOut + fill.feeAmount).toBe(8709786433750235n); // pool output (Swap event amount0)
    expect(fill.feeAmount).toBe(87097864337502n); // hook's claim
    expect(fill.amountOut).toBe(8622688569412733n); // ETH the seller received
  });

  it("rejects modelling an LP fee and a hook fee together", () => {
    expect(() =>
      v4Venue({
        chain: "base",
        tokenIsCurrency0: false,
        tokenDecimals: 9,
        quoteDecimals: 18,
        quoteHookFeePips: 10_000n,
        state: { sqrtPriceX96: Q96, tick: 0, liquidity: L, tickSpacing: 60, feePips: 3000n, ticks: position },
      }),
    ).toThrow(/not modelled/);
  });

  it("output-side helper sanity", () => {
    expect(getNextSqrtPriceFromOutput(Q96, L, 0n, true)).toBe(Q96);
  });
});
