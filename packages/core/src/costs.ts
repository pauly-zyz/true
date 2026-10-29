// Cost model and evaluation of one inventory-mode arbitrage: buy on the cheap chain and sell on
// the expensive chain at the same time; the token inventory is bridged back later (rebalance).
import type { ChainName } from "./chains.js";
import type { Config } from "./config.js";
import { fromUnits, toUnits } from "./math/price.js";
import type { Venue } from "./venue.js";

export interface MarketContext {
  /** USD price of each chain's quote asset (ETH/BNB/SOL) — also its native gas asset. */
  quoteUsd: Partial<Record<ChainName, number>>;
  /** Gas price per chain: gwei for EVM, priority micro-lamports per CU for Solana. */
  gasPrice: Partial<Record<ChainName, number>>;
}

export interface CostBreakdown {
  gasUsd: number;
  bridgeFeeUsd: number;
  lzFeeUsd: number;
  quoteRebalanceUsd: number;
  riskMarginUsd: number;
  /** Informational: pool fees already reflected in the swap outputs. */
  tradingFeeUsd: number;
  /** Informational: price impact vs mid price, excluding fees. */
  slippageUsd: number;
  total: number; // excludes the informational fields (already inside gross)
}

export interface ArbEvaluation {
  buyChain: ChainName;
  sellChain: ChainName;
  quoteIn: bigint;
  tokenBought: bigint;
  /** Tokens sold on the sell chain (truncated to bridge precision so inventory can be rebalanced). */
  tokenSold: bigint;
  quoteOut: bigint;
  notionalUsd: number;
  grossUsd: number;
  costs: CostBreakdown;
  netUsd: number;
  netBps: number;
  partialFill: boolean;
}

/** Gas cost of one swap on `chain`, in USD. */
export function gasCostUsd(cfg: Config, chain: ChainName, mkt: MarketContext): number {
  const c = cfg.chains[chain];
  const native = mkt.quoteUsd[chain];
  if (native === undefined) throw new Error(`missing USD price for ${chain} native asset`);
  const gp = mkt.gasPrice[chain] ?? c.fallbackGasPrice;
  if (c.kind === "solana") {
    const lamports = c.baseFeeLamports + (gp * c.swapGasUnits) / 1e6;
    return (lamports / 1e9) * native;
  }
  return gp * 1e-9 * c.swapGasUnits * native;
}

/** LayerZero fee for bridging tokens from `from` to `to` (inventory rebalance direction). */
export function lzMessageFeeUsd(cfg: Config, from: ChainName, to: ChainName): number {
  const f = cfg.costs.lzMessageFeeUsd;
  if (from === "solana") return f.fromSolana;
  return f.byDestination[to] ?? 0;
}

/** OFT bridges round amounts down to `bridgeDecimals` (6) out of `decimals` (9). */
export function truncateToBridgePrecision(amount: bigint, decimals: number, bridgeDecimals: number): bigint {
  if (bridgeDecimals >= decimals) return amount;
  const unit = 10n ** BigInt(decimals - bridgeDecimals);
  return (amount / unit) * unit;
}

/**
 * Evaluate buying with `quoteIn` (raw units of the buy chain's quote asset) on `buy`, and selling the
 * tokens on `sell`. All pool fees and slippage come from the exact pool math.
 */
export function evaluateArb(
  cfg: Config,
  buy: Venue,
  sell: Venue,
  quoteIn: bigint,
  mkt: MarketContext,
): ArbEvaluation {
  const buyQuoteUsd = mkt.quoteUsd[buy.chain];
  const sellQuoteUsd = mkt.quoteUsd[sell.chain];
  if (buyQuoteUsd === undefined || sellQuoteUsd === undefined) throw new Error("missing quote USD price");

  const b = buy.buyToken(quoteIn);
  const tokenSold = truncateToBridgePrecision(b.amountOut, cfg.token.decimals, cfg.token.bridgeDecimals);
  const s = sell.sellToken(tokenSold);

  const quoteInUsd = fromUnits(b.amountIn, buy.quoteDecimals) * buyQuoteUsd;
  const quoteOutUsd = fromUnits(s.amountOut, sell.quoteDecimals) * sellQuoteUsd;
  // leftover dust tokens from truncation stay in inventory; value them at buy price
  const dustUsd =
    fromUnits(b.amountOut - tokenSold, cfg.token.decimals) * buy.midPriceInQuote() * buyQuoteUsd;
  const grossUsd = quoteOutUsd + dustUsd - quoteInUsd;

  const sellTokenUsd = sell.midPriceInQuote() * sellQuoteUsd;
  const buyTokenUsd = buy.midPriceInQuote() * buyQuoteUsd;
  const tokenSoldHuman = fromUnits(tokenSold, cfg.token.decimals);

  const gasUsd = gasCostUsd(cfg, buy.chain, mkt) + gasCostUsd(cfg, sell.chain, mkt);
  const bridgeFeeUsd = tokenSoldHuman * sellTokenUsd * (cfg.costs.bridgeFeeBps / 1e4);
  const lzFeeUsd = lzMessageFeeUsd(cfg, buy.chain, sell.chain) / cfg.costs.lzAmortizeOverTrades;
  const quoteRebalanceUsd = quoteOutUsd * (cfg.costs.quoteRebalanceBps / 1e4);
  const riskMarginUsd = quoteInUsd * (cfg.costs.riskMarginBps / 1e4);

  // informational split of what is already inside gross
  const buyFeeUsd = b.feeOnInput
    ? fromUnits(b.feeAmount, buy.quoteDecimals) * buyQuoteUsd
    : fromUnits(b.feeAmount, cfg.token.decimals) * buyTokenUsd;
  const sellFeeUsd = s.feeOnInput
    ? fromUnits(s.feeAmount, cfg.token.decimals) * sellTokenUsd
    : fromUnits(s.feeAmount, sell.quoteDecimals) * sellQuoteUsd;
  const tradingFeeUsd = buyFeeUsd + sellFeeUsd;
  const idealGross = tokenSoldHuman * (sellTokenUsd - buyTokenUsd);
  const slippageUsd = Math.max(0, idealGross - grossUsd - tradingFeeUsd);

  const total = gasUsd + bridgeFeeUsd + lzFeeUsd + quoteRebalanceUsd + riskMarginUsd;
  const netUsd = grossUsd - total;
  return {
    buyChain: buy.chain,
    sellChain: sell.chain,
    quoteIn: b.amountIn,
    tokenBought: b.amountOut,
    tokenSold,
    quoteOut: s.amountOut,
    notionalUsd: quoteInUsd,
    grossUsd,
    costs: { gasUsd, bridgeFeeUsd, lzFeeUsd, quoteRebalanceUsd, riskMarginUsd, tradingFeeUsd, slippageUsd, total },
    netUsd,
    netBps: quoteInUsd > 0 ? (netUsd / quoteInUsd) * 1e4 : 0,
    partialFill: b.partialFill || s.partialFill,
  };
}

/** Convert a USD notional into raw units of the buy chain's quote asset. */
export function usdToQuoteUnits(usd: number, quoteUsd: number, quoteDecimals: number): bigint {
  return toUnits(usd / quoteUsd, quoteDecimals);
}
