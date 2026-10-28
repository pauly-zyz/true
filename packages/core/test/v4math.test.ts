// Test vectors copied from Uniswap v4-core 1.0.2 test/libraries/*.t.sol.
import { describe, expect, it } from "vitest";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
} from "../src/math/v4/tickMath.js";
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from "../src/math/v4/sqrtPriceMath.js";
import { calculateSwapFee, computeSwapStep } from "../src/math/v4/swapMath.js";
import { nextInitializedTickWithinOneWord, v4Swap, type V4PoolState } from "../src/math/v4/pool.js";
import { v4Price0In1, v4Price1In0 } from "../src/math/price.js";

const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const SQRT_PRICE_1_4 = 39614081257132168796771975168n;
const SQRT_PRICE_121_100 = 87150978765690771352898345369n;
const SQRT_PRICE_101_100 = 79623317895830914510639640423n;
const SQRT_PRICE_1000_100 = 250541448375047931186413801569n;
const SQRT_PRICE_10000_100 = 792281625142643375935439503360n;
const E18 = 10n ** 18n;

describe("TickMath (v4-core vectors)", () => {
  it("min/max ticks", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MIN_TICK + 1)).toBe(4295343490n);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MAX_TICK - 1)).toBe(1461373636630004318706518188784493106690254656249n);
    expect(getSqrtPriceAtTick(0)).toBe(SQRT_PRICE_1_1);
  });
  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(/InvalidTick/);
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow(/InvalidTick/);
  });
  it("getTickAtSqrtPrice", () => {
    expect(getTickAtSqrtPrice(MIN_SQRT_PRICE)).toBe(MIN_TICK);
    expect(getTickAtSqrtPrice(4295343490n)).toBe(MIN_TICK + 1);
    expect(getTickAtSqrtPrice(MAX_SQRT_PRICE - 1n)).toBe(MAX_TICK - 1);
    expect(getTickAtSqrtPrice(1461373636630004318706518188784493106690254656249n)).toBe(MAX_TICK - 1);
    expect(() => getTickAtSqrtPrice(MAX_SQRT_PRICE)).toThrow();
  });
  it("round-trips across a range of ticks", () => {
    for (const t of [-500000, -88000, -60, -1, 0, 1, 59, 60, 1000, 200000, 887000]) {
      const p = getSqrtPriceAtTick(t);
      expect(getTickAtSqrtPrice(p)).toBe(t);
      expect(getTickAtSqrtPrice(getSqrtPriceAtTick(t + 1) - 1n)).toBe(t);
    }
  });
});

describe("SqrtPriceMath (v4-core vectors)", () => {
  it("getNextSqrtPriceFromInput", () => {
    expect(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, E18, E18 / 10n, false)).toBe(SQRT_PRICE_121_100);
    expect(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, E18, E18 / 10n, true)).toBe(72025602285694852357767227579n);
    expect(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, 10n * E18, 2n ** 100n, true)).toBe(624999999995069620n);
    expect(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, 1n, ((1n << 256n) - 1n) / 2n, true)).toBe(1n);
    expect(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, E18, 0n, true)).toBe(SQRT_PRICE_1_1);
  });
  it("getNextSqrtPriceFromOutput", () => {
    expect(getNextSqrtPriceFromOutput(20282409603651670423947251286016n, 1024n, 262143n, true)).toBe(
      77371252455336267181195264n,
    );
    expect(() => getNextSqrtPriceFromOutput(20282409603651670423947251286016n, 1024n, 4n, false)).toThrow(
      /PriceOverflow/,
    );
    expect(getNextSqrtPriceFromOutput(SQRT_PRICE_1_1, E18, E18 / 10n, false)).toBe(88031291682515930659493278152n);
    expect(getNextSqrtPriceFromOutput(SQRT_PRICE_1_1, E18, E18 / 10n, true)).toBe(71305346262837903834189555302n);
  });
  it("amount deltas", () => {
    expect(getAmount0Delta(SQRT_PRICE_1_1, SQRT_PRICE_121_100, E18, true)).toBe(90909090909090910n);
    expect(getAmount0Delta(SQRT_PRICE_1_1, SQRT_PRICE_121_100, E18, false)).toBe(90909090909090909n);
    expect(getAmount1Delta(SQRT_PRICE_1_1, SQRT_PRICE_121_100, E18, true)).toBe(100000000000000000n);
    expect(getAmount1Delta(SQRT_PRICE_1_1, SQRT_PRICE_121_100, E18, false)).toBe(99999999999999999n);
    const a = 2787593149816327892691964784081045188247552n;
    const b = 22300745198530623141535718272648361505980416n;
    expect(getAmount0Delta(a, b, E18, true)).toBe(getAmount0Delta(a, b, E18, false) + 1n);
  });
});

describe("SwapMath.computeSwapStep (v4-core vectors)", () => {
  it("exact in, capped at price target", () => {
    const s = computeSwapStep(SQRT_PRICE_1_1, SQRT_PRICE_101_100, 2n * E18, -E18, 600n);
    expect(s.amountIn).toBe(9975124224178055n);
    expect(s.amountOut).toBe(9925619580021728n);
    expect(s.feeAmount).toBe(5988667735148n);
    expect(s.sqrtPriceNextX96).toBe(SQRT_PRICE_101_100);
  });
  it("exact out, capped at price target", () => {
    const s = computeSwapStep(SQRT_PRICE_1_1, SQRT_PRICE_101_100, 2n * E18, E18, 600n);
    expect(s.amountIn).toBe(9975124224178055n);
    expect(s.amountOut).toBe(9925619580021728n);
    expect(s.feeAmount).toBe(5988667735148n);
  });
  it("exact in, fully spent", () => {
    const s = computeSwapStep(SQRT_PRICE_1_1, SQRT_PRICE_1000_100, 2n * E18, -E18, 600n);
    expect(s.amountIn).toBe(999400000000000000n);
    expect(s.amountOut).toBe(666399946655997866n);
    expect(s.feeAmount).toBe(600000000000000n);
    expect(s.sqrtPriceNextX96).toBe(getNextSqrtPriceFromInput(SQRT_PRICE_1_1, 2n * E18, E18 - s.feeAmount, false));
  });
  it("exact out, fully received", () => {
    const s = computeSwapStep(SQRT_PRICE_1_1, SQRT_PRICE_10000_100, 2n * E18, E18, 600n);
    expect(s.amountIn).toBe(2000000000000000000n);
    expect(s.feeAmount).toBe(1200720432259356n);
    expect(s.amountOut).toBe(E18);
  });
  it("edge cases", () => {
    let s = computeSwapStep(
      417332158212080721273783715441582n,
      1452870262520218020823638996n,
      159344665391607089467575320103n,
      1n,
      1n,
    );
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtPriceNextX96]).toEqual([
      1n,
      1n,
      1n,
      417332158212080721273783715441581n,
    ]);
    s = computeSwapStep(2n, 1n, 1n, -3915081100057732413702495386755767n, 1n);
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtPriceNextX96]).toEqual([
      SQRT_PRICE_1_4,
      39614120871253040049813n,
      0n,
      1n,
    ]);
    s = computeSwapStep(2413n, 79887613182836312n, 1985041575832132834610021537970n, -10n, 1872n);
    expect([s.amountIn, s.feeAmount, s.amountOut, s.sqrtPriceNextX96]).toEqual([9n, 1n, 0n, 2413n]);
    const p = 20282409603651670423947251286016n;
    s = computeSwapStep(p, (p * 11n) / 10n, 1024n, 4n, 3000n);
    expect([s.amountOut, s.sqrtPriceNextX96, s.amountIn, s.feeAmount]).toEqual([0n, (p * 11n) / 10n, 26215n, 79n]);
    s = computeSwapStep(p, (p * 9n) / 10n, 1024n, 263000n, 3000n);
    expect([s.amountOut, s.sqrtPriceNextX96, s.amountIn, s.feeAmount]).toEqual([26214n, (p * 9n) / 10n, 1n, 1n]);
  });
  it("protocol fee composition", () => {
    expect(calculateSwapFee(0n, 3000n)).toBe(3000n);
    expect(calculateSwapFee(1000n, 3000n)).toBe(1000n + 3000n - 3n);
  });
});

describe("TickBitmap semantics", () => {
  const ticks = [-200, -55, 4, 70, 78, 84, 139, 240, 535].map((t) => t); // spacing 1
  const compressed = ticks;
  it("lte finds at-or-left within the word", () => {
    expect(nextInitializedTickWithinOneWord(compressed, 78, 1, true)).toEqual({ next: 78, initialized: true });
    expect(nextInitializedTickWithinOneWord(compressed, 79, 1, true)).toEqual({ next: 78, initialized: true });
    expect(nextInitializedTickWithinOneWord(compressed, 258, 1, true)).toEqual({ next: 256, initialized: false });
    expect(nextInitializedTickWithinOneWord(compressed, -55, 1, true)).toEqual({ next: -55, initialized: true });
    expect(nextInitializedTickWithinOneWord(compressed, -257, 1, true)).toEqual({ next: -512, initialized: false });
  });
  it("gt finds strictly right within the word", () => {
    expect(nextInitializedTickWithinOneWord(compressed, 78, 1, false)).toEqual({ next: 84, initialized: true });
    expect(nextInitializedTickWithinOneWord(compressed, -55, 1, false)).toEqual({ next: -1, initialized: false });
    expect(nextInitializedTickWithinOneWord(compressed, 255, 1, false)).toEqual({ next: 511, initialized: false });
    expect(nextInitializedTickWithinOneWord(compressed, 383, 1, false)).toEqual({ next: 511, initialized: false });
    expect(nextInitializedTickWithinOneWord(compressed, 240, 1, false)).toEqual({ next: 255, initialized: false });
  });
});

/** Full-range position, as a typical launchpad pool. */
function fullRangePool(liquidity: bigint, sqrtPriceX96: bigint, tickSpacing = 200, feePips = 10000n): V4PoolState {
  const lo = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const hi = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return {
    sqrtPriceX96,
    tick: getTickAtSqrtPrice(sqrtPriceX96),
    liquidity,
    tickSpacing,
    feePips,
    ticks: [
      { tick: lo, liquidityNet: liquidity },
      { tick: hi, liquidityNet: -liquidity },
    ],
  };
}

describe("v4Swap (multi-tick)", () => {
  it("full-range swap matches constant-product with virtual reserves", () => {
    const L = 10n ** 21n;
    const pool = fullRangePool(L, SQRT_PRICE_1_1, 200, 3000n);
    const amountIn = 10n ** 18n;
    const r = v4Swap(pool, { zeroForOne: true, amountSpecified: -amountIn });
    // virtual reserves x = y = L at price 1
    const inLessFee = (amountIn * (1_000_000n - 3000n)) / 1_000_000n;
    const expected = (L * inLessFee) / (L + inLessFee);
    const diff = r.amountOut > expected ? r.amountOut - expected : expected - r.amountOut;
    expect(diff <= 2n).toBe(true);
    expect(r.amountIn).toBe(amountIn);
    expect(r.partialFill).toBe(false);
    expect(r.sqrtPriceX96After < SQRT_PRICE_1_1).toBe(true);
  });

  it("exact-out and exact-in are consistent", () => {
    const pool = fullRangePool(10n ** 20n, SQRT_PRICE_1_1, 60, 3000n);
    const out = v4Swap(pool, { zeroForOne: false, amountSpecified: 10n ** 17n });
    expect(out.amountOut).toBe(10n ** 17n);
    const back = v4Swap(pool, { zeroForOne: false, amountSpecified: -out.amountIn });
    expect(back.amountOut >= 10n ** 17n - 1n && back.amountOut <= 10n ** 17n + 1n).toBe(true);
  });

  it("crosses initialized ticks and changes liquidity", () => {
    // two overlapping positions: [-600, 600] with L1, and [-120, 120] with L2
    const L1 = 10n ** 20n;
    const L2 = 5n * 10n ** 20n;
    const pool: V4PoolState = {
      sqrtPriceX96: SQRT_PRICE_1_1,
      tick: 0,
      liquidity: L1 + L2,
      tickSpacing: 60,
      feePips: 500n,
      ticks: [
        { tick: -600, liquidityNet: L1 },
        { tick: -120, liquidityNet: L2 },
        { tick: 120, liquidityNet: -L2 },
        { tick: 600, liquidityNet: -L1 },
      ],
    };
    // ~3.6e18 token1 moves the price to tick 120; 5e18 ends between 120 and 600
    const r = v4Swap(pool, { zeroForOne: false, amountSpecified: -(5n * 10n ** 18n) });
    expect(r.ticksCrossed).toBe(1);
    expect(r.liquidityAfter).toBe(L1);
    expect(r.tickAfter > 120 && r.tickAfter < 600).toBe(true);
  });

  it("large trade in a shallow bounded pool: big slippage and partial fill", () => {
    const L = 10n ** 15n;
    const pool: V4PoolState = {
      sqrtPriceX96: SQRT_PRICE_1_1,
      tick: 0,
      liquidity: L,
      tickSpacing: 60,
      feePips: 3000n,
      ticks: [
        { tick: -600, liquidityNet: L },
        { tick: 600, liquidityNet: -L },
      ],
    };
    const small = v4Swap(pool, { zeroForOne: true, amountSpecified: -(10n ** 9n) });
    const big = v4Swap(pool, { zeroForOne: true, amountSpecified: -(10n ** 18n) });
    // avg execution price of the small trade ~ 1 - fee; big trade drains the range
    const smallPx = Number(small.amountOut) / Number(small.amountIn);
    const bigPx = Number(big.amountOut) / Number(big.amountIn);
    expect(smallPx).toBeGreaterThan(0.996);
    expect(big.partialFill).toBe(true);
    expect(big.liquidityAfter).toBe(0n);
    // only part of the input could be used, at a clearly worse average price
    expect(big.amountIn < 10n ** 18n).toBe(true);
    expect(bigPx).toBeLessThan(smallPx - 0.02);
    // the output can never exceed the token1 reserve in the range
    const reserve1 = getAmount1Delta(getSqrtPriceAtTick(-600), SQRT_PRICE_1_1, L, false);
    expect(big.amountOut <= reserve1).toBe(true);
  });

  it("respects the price limit", () => {
    const pool = fullRangePool(10n ** 20n, SQRT_PRICE_1_1);
    const limit = getSqrtPriceAtTick(-100);
    const r = v4Swap(pool, { zeroForOne: true, amountSpecified: -(10n ** 22n), sqrtPriceLimitX96: limit });
    expect(r.sqrtPriceX96After).toBe(limit);
    expect(r.partialFill).toBe(true);
  });

  it("rejects a limit on the wrong side", () => {
    const pool = fullRangePool(10n ** 20n, SQRT_PRICE_1_1);
    expect(() => v4Swap(pool, { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: SQRT_PRICE_121_100 })).toThrow(
      /PriceLimitAlreadyExceeded/,
    );
  });
});

describe("price helpers", () => {
  it("converts sqrtPriceX96 with decimals (ETH currency0, 9-dec token currency1)", () => {
    // 1 ETH = 1,000,000 tokens  -> raw price1/0 = 1e6 * 1e9 / 1e18 = 1e-3
    const sqrt = 2505414483750479311864138015n; // sqrt(1e-3) * 2^96
    expect(v4Price0In1(sqrt, 18, 9)).toBeCloseTo(1_000_000, 0);
    expect(v4Price1In0(sqrt, 18, 9)).toBeCloseTo(1e-6, 12);
  });
});
