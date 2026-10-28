// Port of Uniswap v4-core SqrtPriceMath.sol to bigint.
import { MAX_UINT160, Q96, divRoundingUp, mulDiv, mulDivRoundingUp } from "./fullMath.js";

function toUint160(x: bigint): bigint {
  if (x < 0n || x > MAX_UINT160) throw new Error("SafeCastOverflow(uint160)");
  return x;
}

export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  if (add) {
    const product = amount * sqrtPX96;
    // In Solidity a uint256 overflow falls back to a different (equivalent up to rounding) formula.
    if (product < 1n << 256n && numerator1 + product < 1n << 256n) {
      return mulDivRoundingUp(numerator1, sqrtPX96, numerator1 + product);
    }
    return divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount);
  }
  const product = amount * sqrtPX96;
  if (product >= 1n << 256n || numerator1 <= product) throw new Error("PriceOverflow");
  return toUint160(mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product));
}

export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
    return toUint160(sqrtPX96 + quotient);
  }
  const quotient =
    amount <= MAX_UINT160 ? divRoundingUp(amount << 96n, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPX96 <= quotient) throw new Error("NotEnoughLiquidity");
  return sqrtPX96 - quotient;
}

export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new Error("InvalidPriceOrLiquidity");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

export function getNextSqrtPriceFromOutput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new Error("InvalidPriceOrLiquidity");
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}

export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new Error("InvalidPrice");
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const diff = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  return roundUp ? mulDivRoundingUp(liquidity, diff, Q96) : mulDiv(liquidity, diff, Q96);
}
