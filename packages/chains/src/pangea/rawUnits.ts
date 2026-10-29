/** Meteora DAMM v2 MAX_SQRT_PRICE (cp-amm-sdk 1.5.1 constants). */
export const DAMM_MAX_SQRT_PRICE = 79226673521066979257578248091n;

/** Human float -> raw bigint (good to ~15 significant digits, enough for range derivation). */
export function rawFromHuman(x: number, decimals: number): bigint {
  if (!Number.isFinite(x) || x < 0) throw new Error(`bad amount ${x}`);
  const s = x.toFixed(Math.min(decimals, 20));
  const [i, f = ""] = s.split(".");
  return BigInt(i! + f.padEnd(decimals, "0").slice(0, decimals));
}
