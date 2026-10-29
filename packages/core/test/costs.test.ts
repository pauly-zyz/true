import { describe, expect, it } from "vitest";
import { evaluateArb, gasCostUsd, lzMessageFeeUsd, truncateToBridgePrecision, usdToQuoteUnits } from "../src/costs.js";
import { findBestSize } from "../src/optimizer.js";
import { CircuitBreaker, checkTrade, maxTradeUsd, poolLiquidityUsd } from "../src/risk.js";
import { computeSpread, trueScore } from "../src/truescore.js";
import { dammCompounding, mkt, testConfig, v4FullRange } from "./fixtures.js";

const cfg = testConfig();
const ctx = (over = {}) => ({ slug: "coin", capitalUsd: 100_000, marketCapUsd: 1_000_000, coinExposureUsd: 0, ...over });

describe("fixtures sanity", () => {
  it("pool mid price and liquidity are what we asked for", () => {
    const v = v4FullRange("base", 1e-6, 10); // 10 ETH, 1 token = 1e-6 ETH
    expect(v.midPriceInQuote()).toBeCloseTo(1e-6, 9);
    expect(poolLiquidityUsd(v, 3000)).toBeCloseTo(60_000, -2); // 2 x 10 ETH x $3000
    const s = dammCompounding(2e-5, 100);
    expect(s.midPriceInQuote()).toBeCloseTo(2e-5, 9);
  });
});

describe("cost components", () => {
  it("gas: Ethereum costs far more than Base", () => {
    const m = mkt();
    const eth = gasCostUsd(cfg, "ethereum", m);
    const base = gasCostUsd(cfg, "base", m);
    expect(eth).toBeCloseTo(1e-9 * 200_000 * 3000, 6); // $0.60
    expect(base).toBeLessThan(eth / 50);
    expect(gasCostUsd(cfg, "solana", m)).toBeGreaterThan(0);
  });

  it("bridge rounding truncates 9-decimal amounts to 6 decimals", () => {
    expect(truncateToBridgePrecision(1_234_567_891n, 9, 6)).toBe(1_234_567_000n);
    expect(truncateToBridgePrecision(999n, 9, 6)).toBe(0n);
    expect(truncateToBridgePrecision(5_000n, 9, 9)).toBe(5_000n);
  });

  it("evaluateArb sells only the bridge-truncated amount", () => {
    const buy = v4FullRange("base", 1e-6, 50);
    const sell = v4FullRange("bsc", 5.3e-6, 250, 10_000n); // BNB-quoted, ~6% richer in USD
    const ev = evaluateArb(cfg, buy, sell, usdToQuoteUnits(100, 3000, 18), mkt());
    expect(ev.tokenSold % 1000n).toBe(0n);
    expect(ev.tokenSold <= ev.tokenBought).toBe(true);
  });
});

describe("profitability", () => {
  it("a clear gap is profitable after all costs", () => {
    // base: 1 token = 1e-6 ETH = $0.003; bsc: 5.3e-6 BNB * $600 = $0.00318 (+6%)
    const buy = v4FullRange("base", 1e-6, 50);
    const sell = v4FullRange("bsc", 5.3e-6, 250);
    const best = findBestSize(cfg, buy, sell, mkt(), { maxUsd: 20_000 })!;
    expect(best.netUsd).toBeGreaterThan(1);
    expect(best.netBps).toBeGreaterThan(30);
    expect(best.costs.tradingFeeUsd).toBeGreaterThan(0);
    expect(checkTrade(cfg, best, ctx(), 1e9).ok).toBe(true);
  });

  it("costs > profit: a small gap below the two pool fees is rejected", () => {
    // 1% fee each side, gap only 1.5% -> negative after fees + bridge + margin
    const buy = v4FullRange("base", 1e-6, 50);
    const sell = v4FullRange("robinhood", 1.015e-6, 50);
    const best = findBestSize(cfg, buy, sell, mkt(), { maxUsd: 20_000 })!;
    expect(best.netUsd).toBeLessThan(0);
    const v = checkTrade(cfg, best, ctx(), 1e9);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/net profit/);
  });

  it("costs > profit: Ethereum gas + LZ fee kill a small trade that would work between cheap chains", () => {
    const buyBase = v4FullRange("base", 1e-6, 0.5); // tiny pools
    const sellEth = v4FullRange("ethereum", 1.04e-6, 0.5);
    const best = findBestSize(cfg, buyBase, sellEth, mkt(), { maxUsd: 30 })!;
    expect(best.costs.gasUsd).toBeGreaterThan(0.6);
    expect(best.costs.lzFeeUsd).toBe(1.8); // bridging inventory into Ethereum
    expect(best.netUsd).toBeLessThan(cfg.risk.minNetProfitUsd);
    const cheap = findBestSize(cfg, v4FullRange("base", 1e-6, 0.5), v4FullRange("robinhood", 1.04e-6, 0.5), mkt(), { maxUsd: 30 })!;
    expect(cheap.netUsd).toBeGreaterThan(best.netUsd);
  });

  it("LayerZero fee depends on the destination, and is cheap out of Solana", () => {
    expect(lzMessageFeeUsd(cfg, "base", "ethereum")).toBe(1.8);
    expect(lzMessageFeeUsd(cfg, "robinhood", "solana")).toBe(1.02);
    expect(lzMessageFeeUsd(cfg, "solana", "base")).toBe(0.06);
  });

  it("large slippage: oversizing into a shallow pool destroys the edge", () => {
    const buy = v4FullRange("base", 1e-6, 2); // shallow: 2 ETH
    const sell = v4FullRange("bsc", 5.4e-6, 10);
    const q = (usd: number) => usdToQuoteUnits(usd, 3000, 18);
    const small = evaluateArb(cfg, buy, sell, q(50), mkt());
    const huge = evaluateArb(cfg, buy, sell, q(6000), mkt()); // equal to the whole pool
    expect(small.netUsd).toBeGreaterThan(0);
    expect(huge.netUsd).toBeLessThan(0);
    expect(huge.costs.slippageUsd).toBeGreaterThan(huge.notionalUsd * 0.2);
    const best = findBestSize(cfg, buy, sell, mkt(), { maxUsd: 6000 })!;
    expect(best.notionalUsd).toBeLessThan(6000);
    expect(best.netUsd).toBeGreaterThanOrEqual(small.netUsd);
  });

  it("works across venues (v4 on Base -> DAMM v2 on Solana)", () => {
    // base price $0.003; solana 2.2e-5 SOL * $150 = $0.0033 (+10%)
    const buy = v4FullRange("base", 1e-6, 50);
    const sell = dammCompounding(2.2e-5, 2000);
    const best = findBestSize(cfg, buy, sell, mkt(), { maxUsd: 20_000 })!;
    expect(best.netUsd).toBeGreaterThan(1);
  });
});

describe("risk limits", () => {
  const buy = v4FullRange("base", 1e-6, 50);
  const sell = v4FullRange("bsc", 5.3e-6, 250);

  it("max trade = 2% of the smaller pool", () => {
    const m = mkt();
    const cap = maxTradeUsd(cfg, buy, sell, m);
    expect(cap).toBeCloseTo(0.02 * poolLiquidityUsd(buy, 3000), 0);
    const best = findBestSize(cfg, buy, sell, m, { maxUsd: 20_000 })!;
    if (best.notionalUsd > cap) expect(checkTrade(cfg, best, ctx(), cap).reasons.join()).toMatch(/max size/);
    const capped = findBestSize(cfg, buy, sell, m, { maxUsd: cap })!;
    expect(capped.notionalUsd).toBeLessThanOrEqual(cap * 1.0001);
  });

  it("market cap, exclusion and exposure checks", () => {
    const best = findBestSize(cfg, buy, sell, mkt(), { maxUsd: 1000 })!;
    expect(checkTrade(cfg, best, ctx({ marketCapUsd: 10_000 }), 1e9).reasons.join()).toMatch(/market cap/);
    expect(checkTrade(cfg, best, ctx({ marketCapUsd: null }), 1e9).ok).toBe(false);
    expect(checkTrade(cfg, best, ctx({ flagged: true }), 1e9).ok).toBe(false);
    const ex = testConfig((r) => (r.risk.excludedCoins = ["coin"]));
    expect(checkTrade(ex, best, ctx(), 1e9).reasons.join()).toMatch(/excluded/);
    expect(checkTrade(cfg, best, ctx({ capitalUsd: 1000 }), 1e9).reasons.join()).toMatch(/exposure/);
  });

  it("circuit breaker trips at -3% of capital and resets next UTC day", () => {
    const cb = new CircuitBreaker(0.03, () => 10_000);
    const t0 = Date.UTC(2026, 9, 28, 10);
    cb.record(-200, t0);
    expect(cb.isTripped(t0)).toBe(false);
    cb.record(-100, t0 + 1000);
    expect(cb.isTripped(t0 + 2000)).toBe(true);
    cb.record(+500, t0 + 3000); // a later win does not un-trip the day
    expect(cb.isTripped(t0 + 4000)).toBe(true);
    expect(cb.isTripped(Date.UTC(2026, 9, 29, 0, 1))).toBe(false);
  });
});

describe("True Score", () => {
  it("matches the examples in RANCANGAN.md 4.1", () => {
    expect(trueScore(0)).toBe(100);
    expect(trueScore(0.01)).toBeCloseTo(80, 10);
    expect(trueScore(0.05)).toBeCloseTo(0, 10);
    expect(trueScore(0.2)).toBe(0);
  });
  it("spread across chains", () => {
    const s = computeSpread({ base: 1.0, bsc: 1.02, solana: 0.99, ethereum: undefined })!;
    expect(s.minChain).toBe("solana");
    expect(s.maxChain).toBe("bsc");
    expect(s.spread).toBeCloseTo(0.03 / 0.99, 10);
    expect(computeSpread({ base: 1 })).toBeNull();
  });
});
