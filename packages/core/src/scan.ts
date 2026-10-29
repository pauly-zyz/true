// Scans one coin across its chains: USD prices, spread, True Score, and the best executable
// inventory-mode trade for every ordered chain pair. Shared by Phase 0 (snapshots) and Phase 1 (live).
import type { ChainName } from "./chains.js";
import type { Config } from "./config.js";
import type { ArbEvaluation, MarketContext } from "./costs.js";
import { findBestSize } from "./optimizer.js";
import { checkTrade, maxTradeUsd, type RiskVerdict } from "./risk.js";
import { computeSpread, trueScore } from "./truescore.js";
import type { Venue } from "./venue.js";

export interface PairOpportunity {
  buyChain: ChainName;
  sellChain: ChainName;
  /** Mid-price gap: sell/buy - 1. */
  gap: number;
  maxNotionalUsd: number;
  best: ArbEvaluation | null;
  verdict: RiskVerdict;
}

export interface CoinScan {
  slug: string;
  pricesUsd: Partial<Record<ChainName, number>>;
  spread: number | null;
  trueScore: number | null;
  pairs: PairOpportunity[];
  /** Best executable pair (passes every risk check), if any. */
  bestExecutable: PairOpportunity | null;
}

export interface ScanOptions {
  slug: string;
  capitalUsd: number;
  marketCapUsd: number | null;
  coinExposureUsd?: number;
  flagged?: boolean;
  /** Restrict to these chains (e.g. the simulator's enabled chains). */
  chains?: readonly ChainName[];
  /** Skip pairs whose mid gap is below this (cheap pre-filter); default 0. */
  minGap?: number;
}

export function scanCoin(
  cfg: Config,
  venues: Partial<Record<ChainName, Venue>>,
  mkt: MarketContext,
  o: ScanOptions,
): CoinScan {
  const pricesUsd: Partial<Record<ChainName, number>> = {};
  const usable: Array<[ChainName, Venue]> = [];
  for (const [chain, v] of Object.entries(venues) as Array<[ChainName, Venue]>) {
    if (o.chains && !o.chains.includes(chain)) continue;
    const q = mkt.quoteUsd[chain];
    if (!q) continue;
    const px = v.midPriceInQuote() * q;
    if (!Number.isFinite(px) || px <= 0) continue;
    pricesUsd[chain] = px;
    usable.push([chain, v]);
  }
  const sp = computeSpread(pricesUsd);
  const pairs: PairOpportunity[] = [];
  for (const [bc, bv] of usable) {
    for (const [sc, sv] of usable) {
      if (bc === sc) continue;
      const gap = pricesUsd[sc]! / pricesUsd[bc]! - 1;
      if (gap <= (o.minGap ?? 0)) continue;
      const cap = Math.min(maxTradeUsd(cfg, bv, sv, mkt), cfg.risk.maxExposurePerCoinFraction * o.capitalUsd);
      const best = cap > 0 ? findBestSize(cfg, bv, sv, mkt, { maxUsd: cap, minUsd: Math.min(1, cap) }) : null;
      const verdict: RiskVerdict = best
        ? checkTrade(cfg, best, { slug: o.slug, capitalUsd: o.capitalUsd, marketCapUsd: o.marketCapUsd, coinExposureUsd: o.coinExposureUsd ?? 0, flagged: o.flagged }, cap)
        : { ok: false, reasons: ["no size could be evaluated"] };
      pairs.push({ buyChain: bc, sellChain: sc, gap, maxNotionalUsd: cap, best, verdict });
    }
  }
  pairs.sort((a, b) => (b.best?.netUsd ?? -Infinity) - (a.best?.netUsd ?? -Infinity));
  return {
    slug: o.slug,
    pricesUsd,
    spread: sp?.spread ?? null,
    trueScore: sp ? trueScore(sp.spread, cfg.trueScore.multiplier) : null,
    pairs,
    bestExecutable: pairs.find((p) => p.verdict.ok) ?? null,
  };
}
