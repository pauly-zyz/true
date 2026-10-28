import { describe, expect, it } from "vitest";
import { findGapEpisodes, percentile, summarizeEpisodes, sweep, timeWeightedSpread } from "../src/gaps.js";

const s = 1000;

describe("gap episodes", () => {
  const series = {
    base: [
      { ts: 0, priceUsd: 1.0 },
      { ts: 10 * s, priceUsd: 0.97 }, // big sell on base -> base cheap by ~3%
      { ts: 25 * s, priceUsd: 1.01 }, // arbitraged back (within 1% of solana)
    ],
    bsc: [{ ts: 0, priceUsd: 1.0 }],
    solana: [
      { ts: 0, priceUsd: 1.001 },
      { ts: 15 * s, priceUsd: 1.02 }, // gap widens further
    ],
  };

  it("sweep applies simultaneous events together", () => {
    const steps = [...sweep(series)];
    expect(steps[0]!.ts).toBe(0);
    expect(Object.keys(steps[0]!.prices).length).toBe(3);
  });

  it("detects episodes, their duration and max gap", () => {
    const eps = findGapEpisodes(series, 0.02, 60 * s);
    const baseToSol = eps.find((e) => e.buyChain === "base" && e.sellChain === "solana")!;
    expect(baseToSol.startTs).toBe(10 * s);
    expect(baseToSol.endTs).toBe(25 * s);
    expect(baseToSol.durationMs).toBe(15 * s);
    expect(baseToSol.maxGap).toBeCloseTo(1.02 / 0.97 - 1, 10);
    expect(baseToSol.maxGapTs).toBe(15 * s);
    const baseToBsc = eps.find((e) => e.buyChain === "base" && e.sellChain === "bsc")!;
    expect(baseToBsc.durationMs).toBe(15 * s);
    // bsc -> solana is 2.0% which meets the threshold and stays open until the window end
    const bscToSol = eps.find((e) => e.buyChain === "bsc" && e.sellChain === "solana")!;
    expect(bscToSol.endTs).toBeNull();
    expect(bscToSol.durationMs).toBe(45 * s);
  });

  it("higher thresholds find fewer episodes", () => {
    expect(findGapEpisodes(series, 0.06, 60 * s)).toHaveLength(0);
    expect(findGapEpisodes(series, 0.05, 60 * s)).toHaveLength(1); // base->solana peaks at 5.15%
  });

  it("summary statistics", () => {
    const eps = findGapEpisodes(series, 0.02, 60 * s);
    const sum = summarizeEpisodes(eps, 0, 86_400_000);
    expect(sum.count).toBe(eps.length);
    expect(sum.perDay).toBe(eps.length);
    expect(sum.timeOpenFraction).toBeCloseTo(50 / 86400, 6); // 10s..60s covered
    expect(sum.durationSec.max).toBe(45);
  });

  it("percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });

  it("time-weighted spread", () => {
    const tws = timeWeightedSpread({ base: [{ ts: 0, priceUsd: 1 }, { ts: 50, priceUsd: 1.1 }], bsc: [{ ts: 0, priceUsd: 1 }] }, 100)!;
    expect(tws).toBeCloseTo(0.05, 10);
  });
});
