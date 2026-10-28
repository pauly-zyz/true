// Port of Uniswap v4-core TickMath.sol to bigint (same constants, same rounding).

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const MAX_UINT256 = (1n << 256n) - 1n;

const RATIOS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`invalid tick ${tick}`);
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`InvalidTick(${tick})`);

  let price = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, ratio] of RATIOS) {
    if (absTick & bit) price = (price * ratio) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  // Q128.128 -> Q128.96, rounding up
  return (price + (1n << 32n) - 1n) >> 32n;
}

function mostSignificantBit(x: bigint): bigint {
  if (x <= 0n) throw new Error("msb of non-positive");
  return BigInt(x.toString(2).length - 1);
}

export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new Error(`InvalidSqrtPrice(${sqrtPriceX96})`);
  }
  const price = sqrtPriceX96 << 32n;
  const msb = mostSignificantBit(price);
  let r = msb >= 128n ? price >> (msb - 127n) : price << (127n - msb);
  let log2 = (msb - 128n) << 64n;

  for (let i = 63n; i >= 50n; i--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 |= f << i;
    r >>= f;
  }

  const logSqrt10001 = log2 * 255738958999603826347141n;
  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHi = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n);

  if (tickLow === tickHi) return tickLow;
  return getSqrtPriceAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow;
}
