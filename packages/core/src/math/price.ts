// Price conversions. Amount math stays in bigint; human prices are floats (enough for USD analytics).

const Q192 = 1n << 192n;
const Q128 = 1n << 128n;

/** Convert a bigint ratio num/den to a float without losing precision for huge values. */
export function ratioToNumber(num: bigint, den: bigint): number {
  if (den === 0n) throw new Error("ratioToNumber: zero denominator");
  if (num === 0n) return 0;
  // scale so the integer quotient has ~17 significant digits
  const scaleDigits = 18 - (num.toString().length - den.toString().length);
  const scaled = scaleDigits >= 0 ? (num * 10n ** BigInt(scaleDigits)) / den : num / (den * 10n ** BigInt(-scaleDigits));
  return Number(scaled) / 10 ** scaleDigits;
}

/**
 * Uniswap v4: human price of currency0 expressed in currency1 (how many currency1 per 1 currency0).
 * raw price = (sqrtPriceX96 / 2^96)^2 = amount1Raw / amount0Raw.
 */
export function v4Price0In1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  return ratioToNumber(sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0), Q192 * 10n ** BigInt(decimals1));
}

export function v4Price1In0(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  return ratioToNumber(Q192 * 10n ** BigInt(decimals1), sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0));
}

/** Meteora DAMM v2: sqrtPrice is Q64.64; raw price = amountBRaw / amountARaw. Returns tokenA priced in tokenB. */
export function dammV2PriceAInB(sqrtPriceQ64: bigint, decimalsA: number, decimalsB: number): number {
  return ratioToNumber(sqrtPriceQ64 * sqrtPriceQ64 * 10n ** BigInt(decimalsA), Q128 * 10n ** BigInt(decimalsB));
}

export function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid amount ${amount}`);
  // avoid float artefacts by going through a fixed string
  const [i, f = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  return BigInt(i! + f.padEnd(decimals, "0").slice(0, decimals));
}

export function fromUnits(raw: bigint, decimals: number): number {
  return ratioToNumber(raw, 10n ** BigInt(decimals));
}
