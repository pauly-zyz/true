// Phase 1 paper-trading bot: live pool state -> Price & Gap Engine -> inventory-mode simulator.
// DRY RUN ONLY: there is no wallet, no key and no transaction anywhere in this process.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  loadConfig,
  loadSecrets,
  PaperSimulator,
  redactSecrets,
  scanCoin,
  type ChainName,
  type CoinScan,
  type MarketContext,
  type Venue,
} from "@true/core";
import { getDb, LiveStore, loadCoinFees, readChainlink, rpcChains, startLive, venueFromLive, type LiveState } from "@true/chains";
import { insertGapSnapshot, insertPnl, insertRun, insertTrade } from "./db.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const log = createLogger("bot");
const cfg = loadConfig(`${ROOT}config/default.yaml`);
if (!cfg.dryRun) throw new Error("refusing to start: DRY_RUN must be true"); // also enforced by the schema
const secrets = loadSecrets();
const db = getDb(secrets.databaseUrl);
const coins = loadCoinFees(`${ROOT}data/phase0/fees.json`);
const runId = randomUUID().slice(0, 8);
const live = rpcChains(secrets);
const store = new LiveStore(live as never);

log.info({ runId, dryRun: true, coins: coins.length, rpc: [...live], chains: cfg.simulator.chains }, "starting paper-trading bot");

const isFresh = (s: LiveState, now: number) => s.source === "rpc" || now - s.updatedAt <= cfg.simulator.maxSnapshotAgeSec * 1000;

function venuesOf(slug: string, now: number): { venues: Partial<Record<ChainName, Venue>>; states: Partial<Record<ChainName, LiveState>> } {
  const venues: Partial<Record<ChainName, Venue>> = {};
  const states: Partial<Record<ChainName, LiveState>> = {};
  for (const [c, s] of Object.entries(store.states.get(slug) ?? {}) as Array<[ChainName, LiveState]>) {
    if (!isFresh(s, now)) continue;
    try {
      venues[c] = venueFromLive(s, cfg.token.decimals);
      states[c] = s;
    } catch {
      /* skip */
    }
  }
  return { venues, states };
}

/** Reference USD price per coin: median of the chains' mid prices (one mark for all inventory). */
function refPrice(slug: string): number | undefined {
  const q = store.quoteUsdByChain();
  const px = (Object.entries(venuesOf(slug, Date.now()).venues) as Array<[ChainName, Venue]>)
    .map(([c, v]) => v.midPriceInQuote() * (q[c] ?? 0))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  return px.length ? px[Math.floor(px.length / 2)] : undefined;
}

const market = (): MarketContext => ({ quoteUsd: store.quoteUsdByChain(), gasPrice: {} });

let sim: PaperSimulator | null = null;
const lastScan = new Map<string, CoinScan>();
const lastRejectLog = new Map<string, number>();
const pending = new Map<string, NodeJS.Timeout>();
let executed = 0;
let rejected = 0;

function evaluate(slug: string) {
  pending.delete(slug);
  if (!sim) return;
  const now = Date.now();
  const meta = store.meta.get(slug);
  const { venues, states } = venuesOf(slug, now);
  const mkt = market();
  const scan = scanCoin(cfg, venues, mkt, {
    slug,
    capitalUsd: cfg.simulator.startingCapitalUsd,
    marketCapUsd: meta?.marketCapUsd ?? null,
    coinExposureUsd: sim.coinExposureUsd(slug, refPrice),
    chains: cfg.simulator.chains,
    minGap: meta ? (2 * meta.feePips) / 1e6 + cfg.costs.bridgeFeeBps / 1e4 : 0,
  });
  lastScan.set(slug, scan);
  const opp = scan.bestExecutable ?? scan.pairs[0];
  if (!opp?.best || opp.best.netUsd <= 0) return;
  const stateTs = Math.max(states[opp.buyChain]?.updatedAt ?? 0, states[opp.sellChain]?.updatedAt ?? 0);
  const t = sim.tryExecute(slug, opp, venues[opp.buyChain]!, venues[opp.sellChain]!, mkt, {
    ts: now,
    stateTs,
    marketCapUsd: meta?.marketCapUsd ?? null,
    tokenUsd: refPrice,
  });
  const key = `${slug}:${opp.buyChain}>${opp.sellChain}`;
  if (t.executed) {
    executed++;
    log.info({ slug, buy: t.buyChain, sell: t.sellChain, notionalUsd: t.eval!.notionalUsd.toFixed(2), netUsd: t.eval!.netUsd.toFixed(2) }, "SIMULATED trade");
  } else {
    rejected++;
    if (t.reasons[0]?.startsWith("cooldown") || now - (lastRejectLog.get(key) ?? 0) < cfg.simulator.logRejectedEverySec * 1000) return;
    lastRejectLog.set(key, now);
  }
  insertTrade(db, runId, t).catch((e) => log.error({ err: (e as Error).message }, "insert trade failed"));
}

store.on("update", (slug) => {
  if (pending.has(slug)) return;
  pending.set(slug, setTimeout(() => evaluate(slug), cfg.simulator.evaluateDebounceMs));
});

const liveHandle = await startLive({ cfg, secrets, store, coins, log });

// Oracle: Chainlink when configured and reachable; otherwise the snapshot rates stay in place.
async function refreshOracle() {
  try {
    for (const p of await readChainlink(cfg, secrets)) store.setQuoteUsd(p.asset, p.usd, p.source, p.updatedAt);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "chainlink read failed; keeping previous quote prices");
  }
}
await refreshOracle();

sim = new PaperSimulator(cfg, {
  capitalUsd: cfg.simulator.startingCapitalUsd,
  chains: cfg.simulator.chains,
  coins: coins.map((c) => c.slug),
  quoteUsd: store.quoteUsdByChain(),
  tokenUsd: refPrice,
  rebalanceBelow: cfg.simulator.rebalanceBelow,
});
await insertRun(db, runId, cfg.simulator.startingCapitalUsd, redactSecrets({ simulator: cfg.simulator, risk: cfg.risk, costs: cfg.costs }));
log.info({ runId, equityUsd: sim.equityUsd(store.quoteUsdByChain(), refPrice).toFixed(2), quoteSource: store.quoteSource }, "simulator ready");
for (const c of coins) evaluate(c.slug);

const timers = [
  setInterval(() => {
    const now = Date.now();
    for (const [slug, s] of lastScan) {
      const sources = Object.fromEntries(
        (Object.entries(store.states.get(slug) ?? {}) as Array<[ChainName, LiveState]>).map(([c, st]) => [c, { source: st.source, ageSec: Math.round((now - st.updatedAt) / 1000) }]),
      );
      insertGapSnapshot(db, slug, s, sources).catch((e) => log.error({ err: (e as Error).message }, "insert gap failed"));
    }
  }, cfg.simulator.gapSnapshotEverySec * 1000),
  setInterval(() => {
    if (!sim) return;
    const equity = sim.equityUsd(store.quoteUsdByChain(), refPrice);
    insertPnl(db, runId, equity, sim.realizedUsd, sim).catch((e) => log.error({ err: (e as Error).message }, "insert pnl failed"));
    log.info({ equityUsd: equity.toFixed(2), expectedPnlUsd: sim.realizedUsd.toFixed(2), executed, rejected, quoteSource: store.quoteSource }, "pnl");
  }, cfg.simulator.pnlEverySec * 1000),
  setInterval(() => {
    const r = sim?.rebalance(market(), Date.now()) ?? [];
    if (r.length) log.info({ moves: r.length, costUsd: r.reduce((a, x) => a + x.costUsd, 0).toFixed(2) }, "simulated rebalance");
  }, cfg.simulator.rebalanceEverySec * 1000),
  setInterval(refreshOracle, 60_000),
];

const shutdown = async () => {
  log.info({ executed, rejected }, "stopping");
  timers.forEach(clearInterval);
  await liveHandle.stop();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
