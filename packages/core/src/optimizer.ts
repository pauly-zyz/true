// Finds the trade size that maximises net profit for one buy/sell venue pair.
import type { Config } from "./config.js";
import { evaluateArb, usdToQuoteUnits, type ArbEvaluation, type MarketContext } from "./costs.js";
import type { Venue } from "./venue.js";

export interface SizeSearchOptions {
  minUsd?: number;
  maxUsd: number;
  gridPoints?: number;
  refineIterations?: number;
}

/**
 * Net profit vs size is unimodal in practice (linear edge minus convex slippage minus fixed costs),
 * but fixed costs make it flat/negative at small sizes, so a geometric grid is scanned first and the
 * best bracket refined with golden-section search. Returns the best evaluation found (may be
 * negative) or null when no size can be evaluated.
 */
export function findBestSize(
  cfg: Config,
  buy: Venue,
  sell: Venue,
  mkt: MarketContext,
  opts: SizeSearchOptions,
): ArbEvaluation | null {
  const quoteUsd = mkt.quoteUsd[buy.chain];
  if (!quoteUsd || opts.maxUsd <= 0) return null;
  const minUsd = Math.min(opts.minUsd ?? 1, opts.maxUsd);
  const n = opts.gridPoints ?? 32;
  const evalAt = (usd: number): ArbEvaluation | null => {
    const q = usdToQuoteUnits(usd, quoteUsd, buy.quoteDecimals);
    if (q <= 0n) return null;
    try {
      return evaluateArb(cfg, buy, sell, q, mkt);
    } catch {
      return null;
    }
  };

  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(minUsd * Math.pow(opts.maxUsd / minUsd, n === 1 ? 1 : i / (n - 1)));
  const evals = xs.map(evalAt);
  let bestIdx = -1;
  evals.forEach((e, i) => {
    if (e && (bestIdx < 0 || e.netUsd > evals[bestIdx]!.netUsd)) bestIdx = i;
  });
  if (bestIdx < 0) return null;

  let lo = xs[Math.max(0, bestIdx - 1)]!;
  let hi = xs[Math.min(n - 1, bestIdx + 1)]!;
  let best = evals[bestIdx]!;
  const phi = (Math.sqrt(5) - 1) / 2;
  const net = (e: ArbEvaluation | null) => (e ? e.netUsd : -Infinity);
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let ec = evalAt(c);
  let ed = evalAt(d);
  for (let i = 0; i < (opts.refineIterations ?? 24); i++) {
    if (net(ec) > net(ed)) {
      hi = d;
      d = c;
      ed = ec;
      c = hi - phi * (hi - lo);
      ec = evalAt(c);
    } else {
      lo = c;
      c = d;
      ec = ed;
      d = lo + phi * (hi - lo);
      ed = evalAt(d);
    }
  }
  for (const e of [ec, ed]) if (e && e.netUsd > best.netUsd) best = e;
  return best;
}
