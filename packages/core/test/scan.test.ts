import { describe, expect, it } from "vitest";
import { scanCoin } from "../src/scan.js";
import { mkt, testConfig, v4FullRange } from "./fixtures.js";

const cfg = testConfig();

describe("scanCoin", () => {
  const venues = {
    base: v4FullRange("base", 1e-6, 50),
    robinhood: v4FullRange("robinhood", 1.001e-6, 50),
    bsc: v4FullRange("bsc", 5.3e-6, 250), // ~6% above base in USD
  };

  it("finds the best executable pair and computes the True Score", () => {
    const s = scanCoin(cfg, venues, mkt(), { slug: "x", capitalUsd: 50_000, marketCapUsd: 1e6 });
    expect(s.spread).toBeCloseTo(5.3e-6 * 600 / (1e-6 * 3000) - 1, 6);
    expect(s.trueScore).toBe(0); // spread > 5%
    expect(s.bestExecutable?.buyChain).toBe("base");
    expect(s.bestExecutable?.sellChain).toBe("bsc");
    // only pairs with a positive gap are evaluated
    expect(s.pairs.every((p) => p.gap > 0)).toBe(true);
  });

  it("respects the per-coin exposure cap for small capital", () => {
    const s = scanCoin(cfg, venues, mkt(), { slug: "x", capitalUsd: 2_000, marketCapUsd: 1e6 });
    expect(s.bestExecutable!.best!.notionalUsd).toBeLessThanOrEqual(100.01); // 5% of $2000
  });

  it("nothing executable when the market cap is too small", () => {
    const s = scanCoin(cfg, venues, mkt(), { slug: "x", capitalUsd: 50_000, marketCapUsd: 5_000 });
    expect(s.bestExecutable).toBeNull();
  });

  it("restricting chains removes the opportunity", () => {
    const s = scanCoin(cfg, venues, mkt(), { slug: "x", capitalUsd: 50_000, marketCapUsd: 1e6, chains: ["base", "robinhood"] });
    expect(s.bestExecutable).toBeNull();
  });
});
