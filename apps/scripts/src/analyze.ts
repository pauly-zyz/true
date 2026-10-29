// Phase 0 analysis over locally collected data (no network):
//   data/phase0/snapshots/*.json.gz  (/api/pools every 5 min)
//   data/phase0/fees.json            (per-coin fee measured on Robinhood)
//   data/phase0/history/*-168h.json.gz (/api/history)
// Output: data/phase0/analysis.json (consumed by report.ts)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  CHAINS,
  computeSpread,
  createLogger,
  percentile,
  scanCoin,
  type ChainName,
  type Config,
  type MarketContext,
  type Venue,
  withScenario,
} from "@true/core";
import { marketCapUsd, quoteLiquidityUsd, venueFromPangea, type PangeaPoolsResponse } from "@true/chains";
import { cfg, DATA, json, readSnapshot, snapshotFiles } from "./common.js";

const log = createLogger("analyze");

interface FeeEntry {
  symbol?: string;
  feePips: number | null;
  tickSpacing?: number;
}
const feesFile = JSON.parse(readFileSync(`${DATA}/fees.json`, "utf8")) as { coins: Record<string, FeeEntry> };
const universe = Object.entries(feesFile.coins).filter(([, f]) => typeof f.feePips === "number") as Array<[string, FeeEntry & { feePips: number }]>;
const tiers = cfg.phase0.capitalTiersUsd;

const QUOTE: Record<ChainName, "ETH" | "BNB" | "SOL"> = { ethereum: "ETH", base: "ETH", robinhood: "ETH", bsc: "BNB", solana: "SOL" };

function marketFor(snap: PangeaPoolsResponse): MarketContext {
  const usd = snap.rates?.usd ?? {};
  const quoteUsd: Partial<Record<ChainName, number>> = {};
  for (const c of CHAINS) {
    const v = usd[QUOTE[c]];
    if (typeof v === "number" && v > 0) quoteUsd[c] = v;
  }
  return { quoteUsd, gasPrice: {} }; // no gas RPC: config fallback gas prices
}

/** Cheapest possible gap that could ever be profitable: two fees + bridge fee. */
const minGapFor = (feePips: number) => (2 * feePips) / 1e6 + cfg.costs.bridgeFeeBps / 1e4;

interface TierHit {
  buy: ChainName;
  sell: ChainName;
  netUsd: number;
  netBps: number;
  notionalUsd: number;
  grossUsd: number;
  costs: Record<string, number>;
}
interface CoinSnap {
  spread: number | null;
  trueScore: number | null;
  pricesUsd: Partial<Record<ChainName, number>>;
  quoteLiqUsd: number;
  marketCapUsd: number | null;
  hits: Record<string, TierHit | null>; // by tier
  /** Most common rejection reason for the best pair (largest tier). */
  topReject: string | null;
  bestGap: number | null;
}

const files = snapshotFiles();
if (files.length === 0) throw new Error("no snapshots");
const loaded = files.map((f) => ({ file: f, snap: readSnapshot(f) }));

function analyse(c: Config) {
  const snaps: Array<{ ts: number; coins: Record<string, CoinSnap> }> = [];

  for (const { file, snap } of loaded) {
    const ts = Date.parse(snap.readAt);
    const mkt = marketFor(snap);
    const coins: Record<string, CoinSnap> = {};
    for (const [slug, fee] of universe) {
      const l = snap.launches.find((x) => x.slug === slug);
      if (!l) continue;
      const venues: Partial<Record<ChainName, Venue>> = {};
      for (const p of l.pools) {
        if (p.error) continue;
        try {
          venues[p.chain] = venueFromPangea(p, { feePips: fee.feePips, tokenDecimals: cfg.token.decimals, tickSpacing: fee.tickSpacing ?? 60 });
        } catch {
          /* chain unreadable in this snapshot */
        }
      }
      const mcap = marketCapUsd(l);
      const hits: Record<string, TierHit | null> = {};
      let topReject: string | null = null;
      let bestGap: number | null = null;
      let base: ReturnType<typeof scanCoin> | null = null;
      for (const tier of tiers) {
        const s = scanCoin(c, venues, mkt, { slug, capitalUsd: tier, marketCapUsd: mcap, minGap: minGapFor(fee.feePips) });
        base ??= s;
        const e = s.bestExecutable;
        hits[String(tier)] = e?.best
          ? {
              buy: e.buyChain,
              sell: e.sellChain,
              netUsd: e.best.netUsd,
              netBps: e.best.netBps,
              notionalUsd: e.best.notionalUsd,
              grossUsd: e.best.grossUsd,
              costs: { ...e.best.costs },
            }
          : null;
        if (tier === tiers.at(-1)) {
          topReject = s.pairs[0]?.verdict.ok === false ? (s.pairs[0].verdict.reasons[0] ?? null) : null;
          bestGap = s.pairs.length ? Math.max(...s.pairs.map((p) => p.gap)) : null;
        }
      }
      const sp = computeSpread(base!.pricesUsd);
      coins[slug] = {
        spread: sp?.spread ?? null,
        trueScore: base!.trueScore,
        pricesUsd: base!.pricesUsd,
        quoteLiqUsd: quoteLiquidityUsd(l),
        marketCapUsd: mcap,
        hits,
        topReject,
        bestGap,
      };
    }
    snaps.push({ ts, coins });
    log.debug({ file: file.split("/").at(-1), coins: Object.keys(coins).length }, "snapshot analysed");
  }

  // --- episodes: consecutive snapshots with an executable trade on the same (coin, pair) ---
  const spanHours = snaps.length > 1 ? (snaps.at(-1)!.ts - snaps[0]!.ts) / 3.6e6 : 0;
  const intervalMin = snaps.length > 1 ? (snaps.at(-1)!.ts - snaps[0]!.ts) / 60000 / (snaps.length - 1) : 0;
  // Each snapshot stands for one sampling interval of observed time.
  const observedHours = (snaps.length * intervalMin) / 60 || spanHours;

  interface Episode {
    tier: number;
    slug: string;
    buy: ChainName;
    sell: ChainName;
    snapshots: number;
    firstNetUsd: number;
    maxNetUsd: number;
    firstNotionalUsd: number;
  }
  const episodes: Episode[] = [];
  for (const tier of tiers) {
    for (const [slug] of universe) {
      let cur: Episode | null = null;
      for (const s of snaps) {
        const h = s.coins[slug]?.hits[String(tier)] ?? null;
        const same = cur && h && h.buy === cur.buy && h.sell === cur.sell;
        if (same) {
          cur!.snapshots++;
          cur!.maxNetUsd = Math.max(cur!.maxNetUsd, h!.netUsd);
        } else {
          if (cur) episodes.push(cur);
          cur = h ? { tier, slug, buy: h.buy, sell: h.sell, snapshots: 1, firstNetUsd: h.netUsd, maxNetUsd: h.netUsd, firstNotionalUsd: h.notionalUsd } : null;
        }
      }
      if (cur) episodes.push(cur);
    }
  }

  const tierSummary = tiers.map((tier) => {
    const eps = episodes.filter((e) => e.tier === tier);
    const instances = snaps.flatMap((s) => Object.values(s.coins).map((c) => c.hits[String(tier)]).filter((h): h is TierHit => !!h));
    const snapshotsWithHit = snaps.filter((s) => Object.values(s.coins).some((c) => c.hits[String(tier)])).length;
    const perDayFactor = observedHours > 0 ? 24 / observedHours : 0;
    const lower = eps.reduce((a, e) => a + e.firstNetUsd, 0) * perDayFactor;
    const upper = instances.reduce((a, h) => a + h.netUsd, 0) * perDayFactor;
    const costKeys = ["gasUsd", "bridgeFeeUsd", "lzFeeUsd", "quoteRebalanceUsd", "riskMarginUsd", "tradingFeeUsd", "slippageUsd"];
    const avgCosts = Object.fromEntries(costKeys.map((k) => [k, instances.length ? instances.reduce((a, h) => a + (h.costs[k] ?? 0), 0) / instances.length : 0]));
    const pairCounts: Record<string, number> = {};
    for (const e of eps) pairCounts[`${e.buy}→${e.sell}`] = (pairCounts[`${e.buy}→${e.sell}`] ?? 0) + 1;
    return {
      tier,
      episodes: eps.length,
      episodesPerDay: eps.length * perDayFactor,
      instances: instances.length,
      snapshotsWithHitFraction: snaps.length ? snapshotsWithHit / snaps.length : 0,
      medianNetUsd: percentile(instances.map((h) => h.netUsd), 50),
      medianNotionalUsd: percentile(instances.map((h) => h.notionalUsd), 50),
      medianNetBps: percentile(instances.map((h) => h.netBps), 50),
      persistMin: {
        p50: percentile(eps.map((e) => e.snapshots * intervalMin), 50),
        p90: percentile(eps.map((e) => e.snapshots * intervalMin), 90),
        max: eps.length ? Math.max(...eps.map((e) => e.snapshots * intervalMin)) : null,
      },
      dailyNetUsd: { lower, upper },
      dailyRoiPct: { lower: (lower / tier) * 100, upper: (upper / tier) * 100 },
      byCapture: c.phase0.captureRates.map((r) => ({ rate: r, lower: lower * r, upper: upper * r })),
      avgCosts,
      pairCounts,
    };
  });

  return { snaps, episodes, tierSummary, intervalMin, observedHours };
}

const base = analyse(cfg);
const { snaps, episodes, intervalMin, observedHours } = base;
const tierSummary = base.tierSummary;
const scenarios = cfg.phase0.scenarios.map((sc) => ({ name: sc.name, description: sc.description, tiers: analyse(withScenario(cfg, sc)).tierSummary }));

// --- per-coin table from the latest snapshot + averages over all snapshots ---
const last = snaps.at(-1)!;
const coinTable = universe.map(([slug, fee]) => {
  const series = snaps.map((s) => s.coins[slug]).filter(Boolean) as CoinSnap[];
  const spreads = series.map((c) => c.spread).filter((x): x is number => x !== null);
  const c = last.coins[slug];
  const big = String(tiers.at(-1));
  const hitsBig = series.filter((x) => x.hits[big]).length;
  const rejects: Record<string, number> = {};
  for (const x of series) if (x.topReject) rejects[x.topReject.replace(/\$?-?[\d.]+/g, "#")] = (rejects[x.topReject.replace(/\$?-?[\d.]+/g, "#")] ?? 0) + 1;
  return {
    slug,
    symbol: fee.symbol,
    feePct: fee.feePips / 1e4,
    quoteLiqUsd: c?.quoteLiqUsd ?? null,
    marketCapUsd: c?.marketCapUsd ?? null,
    spreadNow: c?.spread ?? null,
    trueScoreNow: c?.trueScore ?? null,
    spreadP50: percentile(spreads, 50),
    spreadP90: percentile(spreads, 90),
    breakevenGap: minGapFor(fee.feePips) + (cfg.costs.riskMarginBps + cfg.costs.quoteRebalanceBps) / 1e4,
    executableFractionTopTier: series.length ? hitsBig / series.length : 0,
    mainReject: Object.entries(rejects).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
});

// --- 7-day history from /api/history candles (coarse buckets) ---
const histDir = `${DATA}/history`;
const history = existsSync(histDir)
  ? readdirSync(histDir)
      .filter((f) => f.endsWith("-168h.json.gz"))
      .map((f) => {
        const d = JSON.parse(gunzipSync(readFileSync(`${histDir}/${f}`)).toString("utf8"));
        const l = d.launches?.[0];
        if (!l) return null;
        const fee = feesFile.coins[l.slug]?.feePips ?? null;
        // forward-filled per-chain close at every bucket start seen on any chain
        const byChain: Record<string, Array<{ t: number; c: number }>> = {};
        for (const cc of l.chainCandles ?? []) byChain[cc.chain] = (cc.candles ?? []).map((k: { t: number; c: number }) => ({ t: k.t, c: k.c }));
        const ts = [...new Set(Object.values(byChain).flatMap((a) => a.map((k) => k.t)))].sort((a, b) => a - b);
        const lastClose: Record<string, number> = {};
        const idx: Record<string, number> = {};
        const spreads: number[] = [];
        for (const t of ts) {
          for (const [ch, arr] of Object.entries(byChain)) {
            let i = idx[ch] ?? 0;
            while (i < arr.length && arr[i]!.t <= t) lastClose[ch] = arr[i++]!.c;
            idx[ch] = i;
          }
          const vals = Object.values(lastClose).filter((x) => x > 0);
          if (vals.length >= 2) spreads.push(Math.max(...vals) / Math.min(...vals) - 1);
        }
        const breakeven = fee !== null ? minGapFor(fee) + (cfg.costs.riskMarginBps + cfg.costs.quoteRebalanceBps) / 1e4 : null;
        return {
          slug: l.slug,
          symbol: l.symbol,
          volumeUsd7d: l.volumeUsd,
          trades7d: l.trades,
          coverage: l.coverage,
          tradesByChain: Object.fromEntries((l.chains ?? []).map((c: { chain: string; trades: number }) => [c.chain, c.trades])),
          volumeUsdByChain: Object.fromEntries((l.chains ?? []).map((c: { chain: string; volumeUsd: number }) => [c.chain, c.volumeUsd])),
          bucketHours: ts.length > 1 ? (ts[1]! - ts[0]!) / 3600 : null,
          buckets: spreads.length,
          spreadP50: percentile(spreads, 50),
          spreadP90: percentile(spreads, 90),
          aboveBreakevenFraction: breakeven !== null && spreads.length ? spreads.filter((s) => s > breakeven).length / spreads.length : null,
        };
      })
      .filter(Boolean)
  : [];

writeFileSync(
  `${DATA}/analysis.json`,
  json({
    generatedAt: new Date().toISOString(),
    window: { from: new Date(snaps[0]!.ts).toISOString(), to: new Date(last.ts).toISOString(), snapshots: snaps.length, intervalMin, observedHours },
    universe: universe.map(([s]) => s),
    tiers: tierSummary,
    scenarios,
    coins: coinTable,
    history,
    topEpisodes: episodes.sort((a, b) => b.firstNetUsd - a.firstNetUsd).slice(0, 15),
    assumptions: {
      gasPrices: Object.fromEntries(CHAINS.map((c) => [c, cfg.chains[c].fallbackGasPrice])),
      lzMessageFeeUsd: cfg.costs.lzMessageFeeUsd,
      riskMarginBps: cfg.costs.riskMarginBps,
      quoteRebalanceBps: cfg.costs.quoteRebalanceBps,
      risk: cfg.risk,
    },
  }),
);
log.info({ snapshots: snaps.length, episodes: episodes.length }, "analysis written");
