// Risk parameters from RANCANGAN.md section 2.3.
import type { Config } from "./config.js";
import type { ArbEvaluation, MarketContext } from "./costs.js";
import type { Venue } from "./venue.js";

/** Pool liquidity (TVL) in USD as seen by the pool math. */
export function poolLiquidityUsd(v: Venue, quoteUsd: number): number {
  const r = v.reserves();
  return r.quote * quoteUsd + r.token * v.midPriceInQuote() * quoteUsd;
}

/** Max trade notional: a fraction of the smaller pool's liquidity. */
export function maxTradeUsd(cfg: Config, buy: Venue, sell: Venue, mkt: MarketContext): number {
  const qb = mkt.quoteUsd[buy.chain];
  const qs = mkt.quoteUsd[sell.chain];
  if (!qb || !qs) return 0;
  return cfg.risk.maxTradeFractionOfSmallerPool * Math.min(poolLiquidityUsd(buy, qb), poolLiquidityUsd(sell, qs));
}

export interface CoinRiskContext {
  slug: string;
  capitalUsd: number;
  marketCapUsd: number | null;
  /** Current value of this coin's inventory across all chains. */
  coinExposureUsd: number;
  flagged?: boolean;
}

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
}

export function checkTrade(cfg: Config, ev: ArbEvaluation, ctx: CoinRiskContext, maxNotionalUsd: number): RiskVerdict {
  const r = cfg.risk;
  const reasons: string[] = [];
  if (r.excludedCoins.includes(ctx.slug)) reasons.push("coin excluded");
  if (ctx.flagged) reasons.push("coin flagged");
  if (ctx.marketCapUsd === null || ctx.marketCapUsd < r.minMarketCapUsd) reasons.push("market cap below minimum");
  if (ev.netUsd < r.minNetProfitUsd) reasons.push(`net profit $${ev.netUsd.toFixed(2)} < $${r.minNetProfitUsd}`);
  if (ev.netBps < r.minNetProfitBps) reasons.push(`net ${ev.netBps.toFixed(1)} bps < ${r.minNetProfitBps} bps`);
  if (ev.notionalUsd > maxNotionalUsd * 1.0001) reasons.push("trade exceeds max size (2% of smaller pool)");
  const exposureCap = r.maxExposurePerCoinFraction * ctx.capitalUsd;
  if (ev.notionalUsd > exposureCap) reasons.push("trade exceeds per-coin exposure cap");
  if (ctx.coinExposureUsd > exposureCap * 1.0001) reasons.push("coin inventory exceeds exposure cap");
  if (ev.partialFill) reasons.push("partial fill");
  return { ok: reasons.length === 0, reasons };
}

/** Daily loss circuit breaker (UTC days). Once tripped it stays tripped until the next day. */
export class CircuitBreaker {
  private day = "";
  private pnl = 0;
  private tripped = false;
  constructor(
    private readonly limitFraction: number,
    private readonly capitalUsd: () => number,
  ) {}

  private roll(ts: number) {
    const d = new Date(ts).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.pnl = 0;
      this.tripped = false;
    }
  }

  record(pnlUsd: number, ts = Date.now()): void {
    this.roll(ts);
    this.pnl += pnlUsd;
    if (this.pnl <= -this.limitFraction * this.capitalUsd()) this.tripped = true;
  }

  isTripped(ts = Date.now()): boolean {
    this.roll(ts);
    return this.tripped;
  }

  dailyPnl(ts = Date.now()): number {
    this.roll(ts);
    return this.pnl;
  }
}
