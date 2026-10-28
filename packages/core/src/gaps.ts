// Cross-chain gap statistics over reconstructed price series (Phase 0).
// Prices are step functions: a pool's price only changes when a swap (or liquidity change) happens.
import type { ChainName } from "./chains.js";

export interface PricePoint {
  ts: number; // ms
  priceUsd: number;
}

export type ChainSeries = Partial<Record<ChainName, PricePoint[]>>;

export interface GapEpisode {
  buyChain: ChainName; // cheap side
  sellChain: ChainName; // expensive side
  startTs: number;
  /** null if still open at the end of the window. */
  endTs: number | null;
  durationMs: number;
  startGap: number; // sell/buy - 1 at the start
  maxGap: number;
  maxGapTs: number;
}

/** Merge per-chain series into a single timeline of "price on every chain right after ts". */
export function* sweep(series: ChainSeries): Generator<{ ts: number; prices: Partial<Record<ChainName, number>> }> {
  const events: Array<{ ts: number; chain: ChainName; price: number }> = [];
  for (const [chain, pts] of Object.entries(series) as Array<[ChainName, PricePoint[]]>) {
    for (const p of pts) if (Number.isFinite(p.priceUsd) && p.priceUsd > 0) events.push({ ts: p.ts, chain, price: p.priceUsd });
  }
  events.sort((a, b) => a.ts - b.ts);
  const prices: Partial<Record<ChainName, number>> = {};
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    prices[e.chain] = e.price;
    if (i + 1 < events.length && events[i + 1]!.ts === e.ts) continue; // apply all same-ts events first
    yield { ts: e.ts, prices: { ...prices } };
  }
}

/**
 * Find maximal intervals where buying on chain A and selling on chain B shows a gap >= threshold.
 * @param threshold fraction, e.g. 0.01 for 1%
 * @param windowEnd end of the observation window (ms); open episodes are closed there
 */
export function findGapEpisodes(series: ChainSeries, threshold: number, windowEnd: number): GapEpisode[] {
  const open = new Map<string, GapEpisode>();
  const done: GapEpisode[] = [];
  for (const { ts, prices } of sweep(series)) {
    const chains = Object.keys(prices) as ChainName[];
    const seen = new Set<string>();
    for (const a of chains) {
      for (const b of chains) {
        if (a === b) continue;
        const key = `${a}>${b}`;
        const gap = prices[b]! / prices[a]! - 1;
        const ep = open.get(key);
        if (gap >= threshold) {
          seen.add(key);
          if (!ep) {
            open.set(key, { buyChain: a, sellChain: b, startTs: ts, endTs: null, durationMs: 0, startGap: gap, maxGap: gap, maxGapTs: ts });
          } else if (gap > ep.maxGap) {
            ep.maxGap = gap;
            ep.maxGapTs = ts;
          }
        }
      }
    }
    for (const [key, ep] of open) {
      if (!seen.has(key)) {
        ep.endTs = ts;
        ep.durationMs = ts - ep.startTs;
        done.push(ep);
        open.delete(key);
      }
    }
  }
  for (const ep of open.values()) {
    ep.durationMs = Math.max(0, windowEnd - ep.startTs);
    done.push(ep);
  }
  return done.sort((x, y) => x.startTs - y.startTs);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export interface EpisodeSummary {
  count: number;
  perDay: number;
  maxGap: { p50: number | null; p90: number | null; p99: number | null; max: number | null };
  durationSec: { p50: number | null; p90: number | null; max: number | null };
  /** Fraction of the window during which at least one episode was open. */
  timeOpenFraction: number;
  byPair: Record<string, number>;
}

export function summarizeEpisodes(episodes: readonly GapEpisode[], windowStart: number, windowEnd: number): EpisodeSummary {
  const days = Math.max(1e-9, (windowEnd - windowStart) / 86_400_000);
  const gaps = episodes.map((e) => e.maxGap);
  const durs = episodes.map((e) => e.durationMs / 1000);
  const byPair: Record<string, number> = {};
  for (const e of episodes) byPair[`${e.buyChain}→${e.sellChain}`] = (byPair[`${e.buyChain}→${e.sellChain}`] ?? 0) + 1;

  // union of open intervals
  const iv = episodes.map((e) => [e.startTs, e.startTs + e.durationMs] as const).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of iv) {
    if (s > curE) {
      if (curE > curS) covered += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE > curS) covered += curE - curS;

  return {
    count: episodes.length,
    perDay: episodes.length / days,
    maxGap: { p50: percentile(gaps, 50), p90: percentile(gaps, 90), p99: percentile(gaps, 99), max: gaps.length ? Math.max(...gaps) : null },
    durationSec: { p50: percentile(durs, 50), p90: percentile(durs, 90), max: durs.length ? Math.max(...durs) : null },
    timeOpenFraction: covered / Math.max(1, windowEnd - windowStart),
    byPair,
  };
}

/** Time-weighted average spread (max/min - 1) across chains, for a historical True Score. */
export function timeWeightedSpread(series: ChainSeries, windowEnd: number): number | null {
  let prevTs: number | null = null;
  let prevSpread = 0;
  let acc = 0;
  let total = 0;
  for (const { ts, prices } of sweep(series)) {
    if (prevTs !== null) {
      acc += prevSpread * (ts - prevTs);
      total += ts - prevTs;
    }
    const vals = Object.values(prices).filter((v): v is number => v !== undefined);
    prevSpread = vals.length >= 2 ? Math.max(...vals) / Math.min(...vals) - 1 : 0;
    prevTs = ts;
  }
  if (prevTs !== null && windowEnd > prevTs) {
    acc += prevSpread * (windowEnd - prevTs);
    total += windowEnd - prevTs;
  }
  return total > 0 ? acc / total : null;
}
