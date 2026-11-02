// Phase 2 live bot. Same data feed and scanner as the paper-trading bot, but opportunities go to the
// LiveExecutor (quotes, simulation, guarded broadcast). DRY_RUN=true (default) never broadcasts.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PublicClient } from "viem";
import {
  createLogger,
  loadConfig,
  loadSecrets,
  lzMessageFeeUsd,
  redactUrl,
  scanCoin,
  type ChainName,
  type EvmChainName,
  type Venue,
} from "@true/core";
import {
  evmClient,
  getDb,
  LiveStore,
  loadCoinFees,
  PangeaPoolsClient,
  rpcChains,
  startLive,
  venueFromLive,
  type LiveState,
} from "@true/chains";
import {
  engageKill,
  evmLegOps,
  evmRecipient,
  isKilled,
  LiveExecutor,
  loadEvmWallet,
  lowBalances,
  parseOftSent,
  planOftSend,
  planTokenRebalance,
  explorerUrl,
  type GuardState,
  type LegOps,
} from "@true/executor";
import { insertBalance, insertBridge, insertLiveTrade, insertRiskEvent } from "./db.js";
import { loadPoolKeys } from "./pools.js";
import { parseCommand, Telegram, telegramFromEnv } from "./telegram.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const log = createLogger("live");
const cfg = loadConfig(`${ROOT}config/default.yaml`);
const live = cfg.live;
if (!live) throw new Error("config has no live section");
const secrets = loadSecrets();
const db = getDb(secrets.databaseUrl);
const runId = randomUUID().slice(0, 8);
const mode = cfg.liveArmed ? "live" : "dry";
const coins = loadCoinFees(`${ROOT}data/phase0/fees.json`);
const tg = telegramFromEnv() ? new Telegram(telegramFromEnv()!) : null;

const alert = async (text: string) => {
  log.warn({ alert: text }, "alert");
  try {
    await tg?.send(`[TRUE ${mode} ${runId}] ${text}`);
  } catch (e) {
    log.error({ err: (e as Error).message }, "telegram alert failed");
  }
};

// --- chains: only live-enabled EVM chains with an RPC; live mode also needs a signing key ---
const enabled = (Object.entries(live.chains) as Array<[ChainName, { enabled: boolean }]>)
  .filter(([c, v]) => v.enabled && c !== "solana")
  .map(([c]) => c);
const guard: GuardState = { breakerTripped: false, pausedCoins: new Set() };
const clients: Partial<Record<ChainName, PublicClient>> = {};
const legs: Partial<Record<ChainName, LegOps>> = {};
for (const chain of enabled) {
  const url = secrets.rpcHttp[chain];
  const wallet = loadEvmWallet(chain);
  if (!url || !wallet) {
    const why = !url ? `RPC_HTTP_${chain.toUpperCase()} missing` : `no wallet for ${chain}`;
    if (cfg.liveArmed) throw new Error(`refusing to arm live trading: ${why}. Run pnpm live:preflight.`);
    log.warn({ chain, why }, "chain unavailable in this dry run");
    continue;
  }
  if (cfg.liveArmed && !wallet.account)
    throw new Error(`refusing to arm live trading: no signing key for ${chain}`);
  clients[chain] = evmClient(cfg, secrets, chain as EvmChainName);
  legs[chain] = evmLegOps({ cfg, root: ROOT, guard, chain, client: clients[chain]!, wallet, rpcUrl: url });
  log.info({ chain, wallet: wallet.address, canSign: !!wallet.account, rpc: redactUrl(url) }, "chain ready");
}
const tradeChains = Object.keys(legs) as ChainName[];
log.info({ runId, mode, tradeChains, coins: coins.length }, "starting TRUE live bot");
if (cfg.liveArmed) await alert(`⚡ LIVE ARMED on ${tradeChains.join(", ")} with capital $${live.capitalUsd}`);

// --- data feed (shared with Phase 1) ---
const store = new LiveStore(rpcChains(secrets) as never);
const feed = await startLive({ cfg, secrets, store, coins, log });
const snapForKeys = await new PangeaPoolsClient(cfg.pangea.apiBase).get();
const poolInfo = await loadPoolKeys(
  cfg,
  ROOT,
  clients,
  snapForKeys,
  coins.map((c) => c.slug),
);

const quoteUsd = (c: ChainName) => store.quoteUsdByChain()[c] ?? 0;
const watched = rpcChains(secrets);
/**
 * Live: every traded chain must be followed by an on-chain watcher (its state is exact between swaps);
 * the executor additionally checks each leg against the V4Quoter. Dry run: /api/pools readings are fine.
 */
function usable(c: ChainName, s: LiveState, now: number): boolean {
  if (cfg.liveArmed) return watched.has(c as never);
  return s.source === "rpc" || now - s.updatedAt < cfg.simulator.maxSnapshotAgeSec * 1000;
}
function venuesOf(slug: string, now: number) {
  const venues: Partial<Record<ChainName, Venue>> = {};
  const states: Partial<Record<ChainName, LiveState>> = {};
  for (const [c, s] of Object.entries(store.states.get(slug) ?? {}) as Array<[ChainName, LiveState]>) {
    if (!tradeChains.includes(c) || !usable(c, s, now)) continue;
    venues[c] = venueFromLive(s, cfg.token.decimals);
    states[c] = s;
  }
  return { venues, states };
}
function refPrice(slug: string): number | undefined {
  const px = (Object.entries(venuesOf(slug, Date.now()).venues) as Array<[ChainName, Venue]>)
    .map(([c, v]) => v.midPriceInQuote() * quoteUsd(c))
    .sort((a, b) => a - b);
  return px.length ? px[Math.floor(px.length / 2)] : undefined;
}

const executor = new LiveExecutor({
  cfg,
  root: ROOT,
  guard,
  legs,
  coin: poolInfo,
  quoteUsd,
  tokenUsd: refPrice,
  record: (t) =>
    insertLiveTrade(db, runId, t).catch((e) =>
      log.error({ err: (e as Error).message }, "record trade failed"),
    ),
  riskEvent: (kind, detail) =>
    insertRiskEvent(db, runId, kind, detail).catch((e) =>
      log.error({ err: (e as Error).message }, "record risk event failed"),
    ),
  alert,
});

// --- engine ---
const lastTradeAt = new Map<string, number>();
const pending = new Map<string, NodeJS.Timeout>();
async function evaluate(slug: string) {
  pending.delete(slug);
  const now = Date.now();
  const meta = store.meta.get(slug);
  const { venues, states } = venuesOf(slug, now);
  if (Object.keys(venues).length < 2) return;
  const scan = scanCoin(
    cfg,
    venues,
    { quoteUsd: store.quoteUsdByChain(), gasPrice: {} },
    {
      slug,
      capitalUsd: live!.capitalUsd,
      marketCapUsd: meta?.marketCapUsd ?? null,
      chains: tradeChains,
      minGap: meta ? (2 * meta.feePips) / 1e6 + cfg.costs.bridgeFeeBps / 1e4 : 0,
    },
  );
  const opp = scan.bestExecutable;
  if (!opp?.best) return;
  const key = `${slug}:${opp.buyChain}>${opp.sellChain}`;
  const stateTs = Math.max(states[opp.buyChain]!.updatedAt, states[opp.sellChain]!.updatedAt);
  if ((lastTradeAt.get(key) ?? -1) >= stateTs) return; // wait for a new pool update after our own trade
  lastTradeAt.set(key, now);
  const t = await executor.execute(slug, opp.best);
  log.info(
    {
      slug,
      pair: `${opp.buyChain}>${opp.sellChain}`,
      status: t.status,
      expectedNetUsd: t.expectedNetUsd.toFixed(2),
      realNetUsd: t.realNetUsd?.toFixed(2),
      reasons: t.reasons,
    },
    "opportunity",
  );
}
store.on("update", (slug) => {
  if (!pending.has(slug))
    pending.set(
      slug,
      setTimeout(() => void evaluate(slug), cfg.simulator.evaluateDebounceMs),
    );
});

// --- balances, low-balance alerts, token rebalance ---
const lastLowAlert = new Map<string, number>();
async function checkBalances() {
  const rows: Array<{ chain: ChainName; asset: string; usd: number; kind: "gas" | "quote" | "token" }> = [];
  for (const chain of tradeChains) {
    const lo = legs[chain]!;
    const nat = await lo.nativeBalance();
    const usd = (Number(nat) / 1e18) * quoteUsd(chain);
    await insertBalance(db, runId, chain, cfg.chains[chain].quoteAsset, nat, usd);
    rows.push(
      { chain, asset: cfg.chains[chain].quoteAsset, usd, kind: "gas" },
      { chain, asset: cfg.chains[chain].quoteAsset, usd, kind: "quote" },
    );
    for (const c of coins) {
      const info = poolInfo(c.slug, chain);
      if (!info) continue;
      const bal = await lo.tokenBalance(info.token);
      const tusd = (Number(bal) / 1e9) * (refPrice(c.slug) ?? 0);
      await insertBalance(db, runId, chain, c.slug, bal, tusd);
      if (bal > 0n) rows.push({ chain, asset: c.slug, usd: tusd, kind: "token" });
    }
  }
  for (const l of lowBalances(rows, live!.lowBalanceUsd)) {
    const k = `${l.chain}:${l.asset}`;
    if (Date.now() - (lastLowAlert.get(k) ?? 0) < 3_600_000) continue;
    lastLowAlert.set(k, Date.now());
    await insertRiskEvent(db, runId, "low_balance", { ...l });
    const manual =
      l.asset === cfg.chains[l.chain].quoteAsset
        ? " — move it manually (quote assets are not rebalanced automatically)"
        : "";
    await alert(
      `🔋 Low balance: ${l.asset} on ${l.chain} = $${l.usd.toFixed(2)} (threshold $${l.thresholdUsd})${manual}`,
    );
  }
}

async function rebalanceTokens() {
  if (isKilled(cfg, ROOT).killed || guard.breakerTripped) return;
  for (const c of coins) {
    const balances: Partial<Record<ChainName, bigint>> = {};
    for (const chain of tradeChains) {
      const info = poolInfo(c.slug, chain);
      if (info) balances[chain] = await legs[chain]!.tokenBalance(info.token);
    }
    const vals = Object.values(balances);
    if (vals.length < 2 || vals.every((v) => v === 0n)) continue;
    const target = vals.reduce((a, b) => a + b, 0n) / BigInt(vals.length);
    const px = refPrice(c.slug) ?? 0;
    for (const m of planTokenRebalance({
      slug: c.slug,
      balances,
      target,
      below: live!.rebalanceBelow,
      tokenUsd: px,
      lzFeeUsd: (f, t) => lzMessageFeeUsd(cfg, f, t),
    })) {
      const from = legs[m.from]!;
      const to = legs[m.to]!;
      const info = poolInfo(c.slug, m.from)!;
      try {
        const plan = await planOftSend(clients[m.from]!, {
          token: info.token,
          dstEid: cfg.chains[m.to].lzEid,
          to: evmRecipient(to.address),
          amount: m.amount,
          refundTo: from.address,
        });
        const lzUsd = (Number(plan.nativeFee) / 1e18) * quoteUsd(m.from);
        const sim = await from.simulate(plan.tx);
        if (!sim.ok) throw new Error(`bridge simulation failed: ${sim.error}`);
        if (!cfg.liveArmed) {
          await insertBridge(db, {
            runId,
            mode,
            slug: c.slug,
            from: m.from,
            to: m.to,
            amountSent: plan.amountSent,
            amountReceived: plan.amountReceived,
            lzFeeNative: plan.nativeFee,
            lzFeeUsd: lzUsd,
            status: "simulated",
          });
          continue;
        }
        const hash = await from.send(plan.tx, c.slug);
        const r = await from.receipt(hash, live!.receiptTimeoutSec * 1000);
        const sent = parseOftSent(r.logs, info.token);
        const gasUsd = (Number(r.gasUsed * r.effectiveGasPrice) / 1e18) * quoteUsd(m.from);
        await insertBridge(db, {
          runId,
          mode,
          slug: c.slug,
          from: m.from,
          to: m.to,
          amountSent: plan.amountSent,
          amountReceived: sent?.amountReceived,
          lzFeeNative: plan.nativeFee,
          lzFeeUsd: lzUsd,
          txHash: hash,
          guid: sent?.guid,
          explorer: explorerUrl(cfg.chains[m.from].explorerTx, hash),
          status: r.status === "success" ? "sent" : "failed",
        });
        const feeUsd = (Number(plan.amountSent - plan.amountReceived) / 1e9) * px;
        await executor.addPnl(-(lzUsd + gasUsd + feeUsd), `rebalance ${c.slug} ${m.from}->${m.to}`);
      } catch (e) {
        await insertRiskEvent(db, runId, "error", {
          where: "rebalance",
          slug: c.slug,
          error: (e as Error).message,
        });
        await alert(`❗ Rebalance ${c.slug} ${m.from}→${m.to} failed: ${(e as Error).message}`);
      }
    }
  }
}

// --- kill switch, resume requests, Telegram commands ---
async function controlLoop() {
  const dir = `${ROOT}data/live`;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.startsWith("resume-"))) {
      const slug = f.slice("resume-".length);
      guard.pausedCoins.delete(slug);
      rmSync(`${dir}/${f}`);
      await insertRiskEvent(db, runId, "resume", { slug });
      await alert(`▶️ ${slug} resumed`);
    }
  }
}
async function telegramLoop() {
  while (tg) {
    try {
      for (const m of await tg.poll()) {
        const c = parseCommand(m.text);
        if (c.kind === "kill") {
          engageKill(cfg, ROOT, `${c.reason} (by ${m.from} via Telegram)`);
          await insertRiskEvent(db, runId, "kill", { by: m.from, reason: c.reason });
          await alert(`🛑 Kill switch engaged by ${m.from}: ${c.reason}`);
        } else if (c.kind === "resume") {
          guard.pausedCoins.delete(c.slug);
          await alert(`▶️ ${c.slug} resumed by ${m.from}`);
        } else if (c.kind === "status") {
          const k = isKilled(cfg, ROOT);
          await alert(
            `Status: mode ${mode}, chains ${tradeChains.join(",")}, daily PnL $${executor.dailyPnlUsd().toFixed(2)}, kill ${k.killed ? `ON (${k.reason})` : "off"}, breaker ${guard.breakerTripped ? "TRIPPED" : "ok"}, paused ${[...guard.pausedCoins].join(",") || "none"}`,
          );
        }
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "telegram poll failed");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

if (isKilled(cfg, ROOT).killed)
  await alert(
    `Kill switch is engaged at start (${isKilled(cfg, ROOT).reason}); no trades will be sent until the kill file is removed.`,
  );
for (const c of coins) void evaluate(c.slug);
void telegramLoop();
const timers = [
  setInterval(
    () => void checkBalances().catch((e) => log.error({ err: (e as Error).message }, "balance check failed")),
    live.balanceCheckEverySec * 1000,
  ),
  setInterval(
    () => void rebalanceTokens().catch((e) => log.error({ err: (e as Error).message }, "rebalance failed")),
    live.rebalanceEverySec * 1000,
  ),
  setInterval(() => void controlLoop(), 3000),
];
void checkBalances().catch((e) => log.error({ err: (e as Error).message }, "balance check failed"));

const shutdown = async () => {
  log.info("stopping");
  timers.forEach(clearInterval);
  await feed.stop();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (e) => {
  void alert(`❗ Uncaught error: ${e.message}. Engaging kill switch.`);
  engageKill(cfg, ROOT, `uncaught error: ${e.message}`);
});
