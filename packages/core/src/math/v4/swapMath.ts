// Port of Uniswap v4-core SwapMath.sol to bigint.
import { mulDiv, mulDivRoundingUp } from "./fullMath.js";
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from "./sqrtPriceMath.js";

/** Fees are in hundredths of a bip (pips): 1_000_000 = 100%. */
export const MAX_SWAP_FEE = 1_000_000n;

export function getSqrtPriceTarget(zeroForOne: boolean, sqrtPriceNextX96: bigint, sqrtPriceLimitX96: bigint): bigint {
  const useLimit = zeroForOne ? sqrtPriceNextX96 < sqrtPriceLimitX96 : sqrtPriceNextX96 > sqrtPriceLimitX96;
  return useLimit ? sqrtPriceLimitX96 : sqrtPriceNextX96;
}

export interface SwapStep {
  sqrtPriceNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * @param amountRemaining negative = exact input, positive = exact output (v4 sign convention)
 * @param feePips swap fee in pips
 */
export function computeSwapStep(
  sqrtPriceCurrentX96: bigint,
  sqrtPriceTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  const zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96;
  const exactIn = amountRemaining < 0n;
  let sqrtPriceNextX96: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  let feeAmount: bigint;

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(-amountRemaining, MAX_SWAP_FEE - feePips, MAX_SWAP_FEE);
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true);
    if (amountRemainingLessFee >= amountIn) {
      sqrtPriceNextX96 = sqrtPriceTargetX96;
      feeAmount = feePips === MAX_SWAP_FEE ? amountIn : mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
    } else {
      amountIn = amountRemainingLessFee;
      sqrtPriceNextX96 = getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);
      feeAmount = -amountRemaining - amountIn;
    }
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false);
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, false);
    if (amountRemaining >= amountOut) {
      sqrtPriceNextX96 = sqrtPriceTargetX96;
    } else {
      amountOut = amountRemaining;
      sqrtPriceNextX96 = getNextSqrtPriceFromOutput(sqrtPriceCurrentX96, liquidity, amountOut, zeroForOne);
    }
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, true);
    feeAmount = mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
  }
  return { sqrtPriceNextX96, amountIn, amountOut, feeAmount };
}

/** v4 ProtocolFeeLibrary.calculateSwapFee: protocolFee + lpFee - protocolFee*lpFee/1e6. */
export function calculateSwapFee(protocolFeePips: bigint, lpFeePips: bigint): bigint {
  if (protocolFeePips === 0n) return lpFeePips;
  return protocolFeePips + lpFeePips - (protocolFeePips * lpFeePips) / MAX_SWAP_FEE;
}
