// Port of Uniswap v4-core FullMath / UnsafeMath to bigint. bigint has arbitrary precision,
// so the 512-bit tricks are unnecessary; we only need to reproduce the rounding.

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDiv: division by zero");
  const r = (a * b) / denominator;
  if (r > MAX_UINT256) throw new Error("mulDiv: overflow");
  return r;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const r = mulDiv(a, b, denominator);
  return (a * b) % denominator > 0n ? r + 1n : r;
}

export function divRoundingUp(x: bigint, y: bigint): bigint {
  if (y === 0n) throw new Error("divRoundingUp: division by zero");
  return x / y + (x % y > 0n ? 1n : 0n);
}
