import { describe, expect, it } from "vitest";
import { PaperSimulator } from "../src/simulator.js";
import { scanCoin } from "../src/scan.js";
import type { ChainName } from "../src/chains.js";
import { mkt, testConfig, v4FullRange } from "./fixtures.js";

const cfg = testConfig();
const m = mkt();
const chains: ChainName[] = ["base", "robinhood", "bsc"];
const venues = () => ({
  base: v4FullRange("base", 1e-6, 50), // $0.003
  robinhood: v4FullRange("robinhood", 1.001e-6, 50),
  bsc: v4FullRange("bsc", 5.3e-6, 250), // ~6% richer
});
/** Median USD price across chains, as the bot uses. */
const usdOf = (v: Partial<Record<ChainName, { midPriceInQuote(): number }>>) => () => {
  const px = (Object.entries(v) as Array<[ChainName, { midPriceInQuote(): number }]>).map(([c, ven]) => ven.midPriceInQuote() * m.quoteUsd[c]!).sort((a, b) => a - b);
  return px[Math.floor(px.length / 2)];
};

function setup(capitalUsd = 20_000) {
  const v = venues();
  const sim = new PaperSimulator(cfg, { capitalUsd, chains, coins: ["coin"], quoteUsd: m.quoteUsd, tokenUsd: usdOf(v) });
  return { v, sim };
}

describe("PaperSimulator", () => {
  it("allocates the starting capital and respects the per-coin exposure cap", () => {
    const { v, sim } = setup();
    const eq = sim.equityUsd(m.quoteUsd, usdOf(v));
    expect(eq).toBeCloseTo(20_000, 0);
    expect(sim.coinExposureUsd("coin", usdOf(v))).toBeCloseTo(0.05 * 20_000, 0); // capped at 5%
  });

  it("executes a profitable trade and moves balances consistently", () => {
    const { v, sim } = setup();
    const scan = scanCoin(cfg, v, m, { slug: "coin", capitalUsd: 20_000, marketCapUsd: 1e6 });
    const opp = scan.bestExecutable!;
    const quoteBefore = { ...sim.quote };
    const tokBefore = { ...sim.tokens.get("coin")! };
    const t = sim.tryExecute("coin", opp, v[opp.buyChain as "base"], v[opp.sellChain as "bsc"], m, { ts: 1, stateTs: 1, marketCapUsd: 1e6, tokenUsd: usdOf(v) });
    expect(t.executed).toBe(true);
    const ev = t.eval!;
    expect(sim.quote[opp.buyChain]!).toBeLessThan(quoteBefore[opp.buyChain]!);
    expect(sim.quote[opp.sellChain]!).toBeGreaterThan(quoteBefore[opp.sellChain]!);
    expect(sim.tokens.get("coin")![opp.sellChain]!).toBeCloseTo(tokBefore[opp.sellChain]! - Number(ev.tokenSold) / 1e9, 6);
    // equity (all tokens at one reference price) moves by quote out - quote in - gas, plus the token
    // amount kept from bridge truncation; bridge/LZ/rebalance costs are paid later, at rebalance time
    const ref = usdOf(v)()!;
    const expected = Number(ev.quoteOut) / 1e18 * 600 - Number(ev.quoteIn) / 1e18 * 3000 - ev.costs.gasUsd + (Number(ev.tokenBought - ev.tokenSold) / 1e9) * ref;
    expect(t.equityDeltaUsd).toBeCloseTo(expected, 6);
    expect(t.equityDeltaUsd).toBeGreaterThan(0);
    expect(sim.realizedUsd).toBeCloseTo(ev.netUsd + ev.costs.riskMarginUsd, 6);
  });

  it("does not re-trade the same pair until a pool updates (cooldown)", () => {
    const { v, sim } = setup();
    const opp = scanCoin(cfg, v, m, { slug: "coin", capitalUsd: 20_000, marketCapUsd: 1e6 }).bestExecutable!;
    const ctx = { ts: 10, stateTs: 5, marketCapUsd: 1e6, tokenUsd: usdOf(v) };
    expect(sim.tryExecute("coin", opp, v.base, v.bsc, m, ctx).executed).toBe(true);
    expect(sim.tryExecute("coin", opp, v.base, v.bsc, m, { ...ctx, ts: 11 }).reasons[0]).toMatch(/cooldown/);
    sim.tokens.get("coin")!.bsc = 10_000_000; // inventory topped up, as after a rebalance
    const third = sim.tryExecute("coin", opp, v.base, v.bsc, m, { ...ctx, ts: 12, stateTs: 12 });
    expect(third.reasons).toEqual([]);
  });

  it("rejects when costs exceed profit", () => {
    const v = { base: v4FullRange("base", 1e-6, 50), robinhood: v4FullRange("robinhood", 1.015e-6, 50) };
    const sim = new PaperSimulator(cfg, { capitalUsd: 20_000, chains: ["base", "robinhood"], coins: ["coin"], quoteUsd: m.quoteUsd, tokenUsd: usdOf(v) });
    const scan = scanCoin(cfg, v, m, { slug: "coin", capitalUsd: 20_000, marketCapUsd: 1e6 });
    expect(scan.bestExecutable).toBeNull();
    const t = sim.tryExecute("coin", scan.pairs[0]!, v.base, v.robinhood, m, { ts: 1, stateTs: 1, marketCapUsd: 1e6, tokenUsd: usdOf(v) });
    expect(t.executed).toBe(false);
    expect(t.reasons.join()).toMatch(/net profit/);
  });

  it("shrinks the trade to the available inventory", () => {
    const { v, sim } = setup();
    sim.tokens.get("coin")!.bsc = 20_000; // ~$64 of tokens left on the sell chain
    const opp = scanCoin(cfg, v, m, { slug: "coin", capitalUsd: 20_000, marketCapUsd: 1e6 }).bestExecutable!;
    const t = sim.tryExecute("coin", opp, v.base, v.bsc, m, { ts: 1, stateTs: 1, marketCapUsd: 1e6, tokenUsd: usdOf(v) });
    if (t.executed) expect(Number(t.eval!.tokenSold) / 1e9).toBeLessThanOrEqual(20_000);
    else expect(t.reasons.join()).toMatch(/inventory|net profit/);
    expect(sim.tokens.get("coin")!.bsc!).toBeGreaterThanOrEqual(0);
  });

  it("halts for the day after a 3% equity drawdown", () => {
    const { v, sim } = setup();
    const opp = scanCoin(cfg, v, m, { slug: "coin", capitalUsd: 20_000, marketCapUsd: 1e6 }).bestExecutable!;
    const day = Date.UTC(2026, 9, 29, 8);
    sim.checkDailyLoss(20_000, day); // start of day
    // token prices crash 80%: inventory loss > 3% of capital
    const crashed = () => usdOf(v)()! * 0.2;
    const t = sim.tryExecute("coin", opp, v.base, v.bsc, m, { ts: day + 1000, stateTs: day + 1000, marketCapUsd: 1e6, tokenUsd: crashed });
    expect(t.executed).toBe(false);
    expect(t.reasons[0]).toMatch(/circuit breaker/);
    // next UTC day trading resumes
    const next = sim.tryExecute("coin", opp, v.base, v.bsc, m, { ts: Date.UTC(2026, 9, 30, 1), stateTs: Date.UTC(2026, 9, 30, 1), marketCapUsd: 1e6, tokenUsd: crashed });
    expect(next.reasons[0] ?? "").not.toMatch(/circuit breaker/);
  });

  it("rebalances depleted token inventory with bridge fee and LayerZero cost", () => {
    const { sim } = setup();
    const target = sim.targetTokens.get("coin")!;
    const bal = sim.tokens.get("coin")!;
    bal.bsc = 0.1 * target;
    bal.base = 2.9 * target;
    const ethBefore = sim.quote.base!;
    const r = sim.rebalance(m, 1);
    const tokenMove = r.find((x) => x.slug === "coin")!;
    expect(tokenMove.from).toBe("base");
    expect(tokenMove.to).toBe("bsc");
    expect(bal.bsc!).toBeCloseTo(0.1 * target + tokenMove.amount * 0.998, 3);
    expect(sim.quote.base!).toBeCloseTo(ethBefore - cfg.costs.lzMessageFeeUsd.byDestination.bsc! / 3000, 9);
  });
});
