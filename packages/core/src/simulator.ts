// Inventory-mode paper trading (RANCANGAN 2.1 step 3, mode inventaris). Virtual balances per chain:
// the quote asset (ETH/BNB/SOL) and each coin's tokens. A trade buys on the cheap chain and sells on
// the expensive chain at the same instant; inventory is rebalanced later with simulated bridge costs.
// Nothing here talks to a chain.
import type { ChainName } from "./chains.js";
import type { Config } from "./config.js";
import { evaluateArb, gasCostUsd, lzMessageFeeUsd, usdToQuoteUnits, type ArbEvaluation, type MarketContext } from "./costs.js";
import { fromUnits } from "./math/price.js";
import { findBestSize } from "./optimizer.js";
import { checkTrade } from "./risk.js";
import type { PairOpportunity } from "./scan.js";
import type { Venue } from "./venue.js";

export type TokenPrice = (slug: string) => number | undefined;

export interface SimTrade {
  ts: number;
  slug: string;
  buyChain: ChainName;
  sellChain: ChainName;
  executed: boolean;
  reasons: string[];
  eval: ArbEvaluation | null;
  /** Change in mark-to-market equity caused by this trade (real simulated balance moves). */
  equityDeltaUsd: number;
}

export interface Rebalance {
  ts: number;
  slug: string | null; // null = quote asset
  from: ChainName;
  to: ChainName;
  amount: number; // human units of what moved (tokens, or USD for quote)
  costUsd: number;
}

export interface SimulatorOptions {
  capitalUsd: number;
  chains: readonly ChainName[];
  coins: readonly string[];
  quoteUsd: Partial<Record<ChainName, number>>;
  /**
   * One reference USD price per coin (e.g. the median across chains). All of a coin's inventory is
   * marked at this single price: marking each chain at its own price would book the arbitraged gap
   * itself as a loss whenever tokens move from the expensive chain to the cheap one.
   */
  tokenUsd: TokenPrice;
  /** Rebalance a chain's balance when it falls below this fraction of its target. */
  rebalanceBelow?: number;
}

export class PaperSimulator {
  readonly quote: Partial<Record<ChainName, number>> = {};
  readonly tokens = new Map<string, Partial<Record<ChainName, number>>>();
  readonly targetQuoteUsd: number;
  readonly targetTokens = new Map<string, number>(); // per chain, human units
  private dayStartEquity: { day: string; equity: number } | null = null;
  realizedUsd = 0;
  readonly trades: SimTrade[] = [];
  readonly rebalances: Rebalance[] = [];
  private readonly lastTradeAt = new Map<string, number>();
  private haltedDay: string | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly o: SimulatorOptions,
  ) {
    const n = o.chains.length;
    // allocate 80% of the per-coin cap so normal price moves do not immediately breach it
    const perCoinCap = 0.8 * cfg.risk.maxExposurePerCoinFraction * o.capitalUsd;
    const tokenBudget = o.capitalUsd * (1 - cfg.simulator.quoteFraction);
    const perCoin = o.coins.length ? Math.min(perCoinCap, tokenBudget / o.coins.length) : 0;
    let tokenSpent = 0;
    for (const slug of o.coins) {
      const bal: Partial<Record<ChainName, number>> = {};
      const px = o.tokenUsd(slug);
      if (px) for (const c of o.chains) bal[c] = perCoin / n / px;
      tokenSpent += Object.keys(bal).length * (perCoin / n);
      this.tokens.set(slug, bal);
      this.targetTokens.set(slug, px ? perCoin / n / px : 0);
    }
    // whatever is not in tokens is held as quote, split evenly across chains
    this.targetQuoteUsd = (o.capitalUsd - tokenSpent) / n;
    for (const c of o.chains) {
      const q = o.quoteUsd[c];
      if (!q) throw new Error(`no quote USD price for ${c}`);
      this.quote[c] = this.targetQuoteUsd / q;
    }
  }

  /** Mark-to-market equity in USD. */
  equityUsd(quoteUsd: Partial<Record<ChainName, number>>, tokenUsd: TokenPrice): number {
    let e = 0;
    for (const [c, v] of Object.entries(this.quote) as Array<[ChainName, number]>) e += v * (quoteUsd[c] ?? 0);
    for (const slug of this.tokens.keys()) e += this.coinExposureUsd(slug, tokenUsd);
    return e;
  }

  coinExposureUsd(slug: string, tokenUsd: TokenPrice): number {
    const px = tokenUsd(slug) ?? 0;
    return Object.values(this.tokens.get(slug) ?? {}).reduce((a, v) => a + (v ?? 0) * px, 0);
  }

  /** Daily equity-based circuit breaker: halt for the rest of the UTC day after -limit. */
  checkDailyLoss(equity: number, ts: number): boolean {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!this.dayStartEquity || this.dayStartEquity.day !== day) {
      this.dayStartEquity = { day, equity };
      if (this.haltedDay !== day) this.haltedDay = null;
    }
    if (equity <= this.dayStartEquity.equity - this.cfg.risk.dailyLossLimitFraction * this.o.capitalUsd) this.haltedDay = day;
    return this.haltedDay === day;
  }

  /**
   * Try to execute the best opportunity for a coin. `stateTs` is the newest pool update time of the two
   * chains: after a trade the same pair is not traded again until one of its pools has a new update
   * (our simulated trade does not move the real pools, so re-trading the same reading would double count).
   */
  tryExecute(
    slug: string,
    opp: PairOpportunity,
    buy: Venue,
    sell: Venue,
    mkt: MarketContext,
    ctx: { ts: number; stateTs: number; marketCapUsd: number | null; tokenUsd: TokenPrice },
  ): SimTrade {
    const key = `${slug}:${opp.buyChain}>${opp.sellChain}`;
    const record = (executed: boolean, reasons: string[], ev: ArbEvaluation | null, equityDeltaUsd = 0): SimTrade => {
      const t: SimTrade = { ts: ctx.ts, slug, buyChain: opp.buyChain, sellChain: opp.sellChain, executed, reasons, eval: ev, equityDeltaUsd };
      this.trades.push(t);
      return t;
    };
    const last = this.lastTradeAt.get(key);
    if (last !== undefined && ctx.stateTs <= last) return record(false, ["cooldown: no new pool update since last trade"], opp.best);

    const equity = this.equityUsd(mkt.quoteUsd, ctx.tokenUsd);
    if (this.checkDailyLoss(equity, ctx.ts)) return record(false, ["circuit breaker: daily loss limit reached"], opp.best);
    if (!opp.verdict.ok || !opp.best) return record(false, opp.verdict.reasons, opp.best);

    // balance limits: quote on the buy chain, tokens on the sell chain
    const qb = mkt.quoteUsd[opp.buyChain]!;
    const quoteBalUsd = (this.quote[opp.buyChain] ?? 0) * qb;
    const tokenBal = this.tokens.get(slug)?.[opp.sellChain] ?? 0;
    const sellTokenUsd = sell.midPriceInQuote() * (mkt.quoteUsd[opp.sellChain] ?? 0);
    // keep a little quote for gas; token cap with a margin for price impact on the buy side
    const balanceCapUsd = Math.min(quoteBalUsd * 0.98, tokenBal * sellTokenUsd * 0.9);
    let ev: ArbEvaluation | null = opp.best;
    if (ev.notionalUsd > balanceCapUsd) {
      ev = balanceCapUsd > 1 ? findBestSize(this.cfg, buy, sell, mkt, { maxUsd: balanceCapUsd, minUsd: Math.min(1, balanceCapUsd) }) : null;
      if (!ev) return record(false, ["insufficient inventory"], opp.best);
    }
    const verdict = checkTrade(
      this.cfg,
      ev,
      { slug, capitalUsd: this.o.capitalUsd, marketCapUsd: ctx.marketCapUsd, coinExposureUsd: this.coinExposureUsd(slug, ctx.tokenUsd) },
      opp.maxNotionalUsd,
    );
    if (!verdict.ok) return record(false, verdict.reasons, ev);
    const tokenSold = fromUnits(ev.tokenSold, this.cfg.token.decimals);
    if (tokenSold > tokenBal) return record(false, ["insufficient inventory"], ev);

    // apply the balance moves: gas is paid in each chain's native (= quote) asset
    const before = this.equityUsd(mkt.quoteUsd, ctx.tokenUsd);
    const qs = mkt.quoteUsd[opp.sellChain]!;
    const tok = this.tokens.get(slug)!;
    this.quote[opp.buyChain] = (this.quote[opp.buyChain] ?? 0) - fromUnits(ev.quoteIn, buy.quoteDecimals) - gasCostUsd(this.cfg, opp.buyChain, mkt) / qb;
    tok[opp.buyChain] = (tok[opp.buyChain] ?? 0) + fromUnits(ev.tokenBought, this.cfg.token.decimals);
    tok[opp.sellChain] = tokenBal - tokenSold;
    this.quote[opp.sellChain] = (this.quote[opp.sellChain] ?? 0) + fromUnits(ev.quoteOut, sell.quoteDecimals) - gasCostUsd(this.cfg, opp.sellChain, mkt) / qs;
    const delta = this.equityUsd(mkt.quoteUsd, ctx.tokenUsd) - before;
    this.realizedUsd += ev.netUsd + ev.costs.riskMarginUsd; // expected PnL once rebalanced (margin is not a cost)
    this.lastTradeAt.set(key, ctx.ts);
    return record(true, [], ev, delta);
  }

  /**
   * Simulated rebalance: move tokens (via the OFT bridge: 0.2% fee, 6-decimal truncation, LayerZero fee
   * paid in the source chain's native asset) and quote (at `quoteRebalanceBps`) from the richest chain to
   * any chain below `rebalanceBelow` of its target.
   */
  rebalance(mkt: MarketContext, ts: number): Rebalance[] {
    const below = this.o.rebalanceBelow ?? 0.3;
    const done: Rebalance[] = [];
    for (const [slug, bal] of this.tokens) {
      const target = this.targetTokens.get(slug) ?? 0;
      if (!target) continue;
      for (const c of this.o.chains) {
        if ((bal[c] ?? 0) >= below * target) continue;
        const [richest, amt] = (Object.entries(bal) as Array<[ChainName, number]>).sort((a, b) => b[1] - a[1])[0] ?? [];
        if (!richest || richest === c || amt === undefined || amt <= 1.5 * target) continue;
        const move = Math.floor((amt - target) * 1e6) / 1e6; // 6-decimal truncation
        const lzUsd = lzMessageFeeUsd(this.cfg, richest, c);
        const arrived = move * (1 - this.cfg.costs.bridgeFeeBps / 1e4);
        bal[richest] = amt - move;
        bal[c] = (bal[c] ?? 0) + arrived;
        this.quote[richest] = (this.quote[richest] ?? 0) - lzUsd / (mkt.quoteUsd[richest] ?? Infinity);
        done.push({ ts, slug, from: richest, to: c, amount: move, costUsd: lzUsd });
      }
    }
    for (const c of this.o.chains) {
      const q = mkt.quoteUsd[c];
      if (!q || (this.quote[c] ?? 0) * q >= below * this.targetQuoteUsd) continue;
      const richest = [...this.o.chains].sort((a, b) => (this.quote[b] ?? 0) * (mkt.quoteUsd[b] ?? 0) - (this.quote[a] ?? 0) * (mkt.quoteUsd[a] ?? 0))[0]!;
      const richUsd = (this.quote[richest] ?? 0) * (mkt.quoteUsd[richest] ?? 0);
      if (richest === c || richUsd <= 1.5 * this.targetQuoteUsd) continue;
      const moveUsd = richUsd - this.targetQuoteUsd;
      const cost = moveUsd * (this.cfg.costs.quoteRebalanceBps / 1e4);
      this.quote[richest] = (this.quote[richest] ?? 0) - moveUsd / mkt.quoteUsd[richest]!;
      this.quote[c] = (this.quote[c] ?? 0) + (moveUsd - cost) / q;
      done.push({ ts, slug: null, from: richest, to: c, amount: moveUsd, costUsd: cost });
    }
    this.rebalances.push(...done);
    return done;
  }
}

/** Convenience for tests and the bot: evaluate a fixed USD size. */
export function evaluateUsd(cfg: Config, buy: Venue, sell: Venue, usd: number, mkt: MarketContext): ArbEvaluation {
  return evaluateArb(cfg, buy, sell, usdToQuoteUnits(usd, mkt.quoteUsd[buy.chain]!, buy.quoteDecimals), mkt);
}
