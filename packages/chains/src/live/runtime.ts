// Starts the live data pipeline shared by apps/indexer and apps/bot:
//  - an /api/pools poller (coin list, static ranges, fallback prices; never faster than 60 s)
//  - one Swap follower per EVM chain that has an RPC configured
//  - one account watcher on Solana if an RPC is configured
import { Connection } from "@solana/web3.js";
import { EVM_CHAINS, requireAddress, type Config, type EvmChainName, type Secrets } from "@true/core";
import type { Logger } from "pino";
import { evmClient } from "../evm/clients.js";
import { PangeaPoolsClient } from "../pangea/pools.js";
import { EvmSwapWatcher, type SwapUpdate } from "./evmWatcher.js";
import { SolanaPoolWatcher, type DammAccountUpdate } from "./solanaWatcher.js";
import type { CoinMeta, LiveStore } from "./store.js";

export interface RuntimeOptions {
  cfg: Config;
  secrets: Secrets;
  store: LiveStore;
  coins: ReadonlyArray<Omit<CoinMeta, "marketCapUsd">>;
  log: Logger;
  onSwap?: (chain: EvmChainName, u: SwapUpdate, slug: string) => void;
  onDamm?: (u: DammAccountUpdate, slug: string) => void;
}

export function rpcChains(secrets: Secrets): Set<EvmChainName | "solana"> {
  const s = new Set<EvmChainName | "solana">();
  for (const c of EVM_CHAINS) if (secrets.rpcHttp[c] || secrets.rpcWs[c]) s.add(c);
  if (secrets.rpcHttp.solana) s.add("solana");
  return s;
}

export async function startLive(o: RuntimeOptions): Promise<{ stop: () => Promise<void> }> {
  const { cfg, secrets, store, log } = o;
  const pools = new PangeaPoolsClient(cfg.pangea.apiBase, 60);
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;

  const refresh = async () => {
    try {
      const snap = await pools.get();
      store.seedFromSnapshot(snap, o.coins);
      log.info({ readAt: snap.readAt, coins: o.coins.length }, "pangea pools refreshed");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "pangea pools refresh failed");
    }
    if (!stopped) pollTimer = setTimeout(refresh, cfg.pangea.poolsRefreshSec * 1000);
  };
  await refresh();

  const watchers: EvmSwapWatcher[] = [];
  for (const chain of EVM_CHAINS) {
    if (!cfg.chains[chain].enabled || !(secrets.rpcHttp[chain] || secrets.rpcWs[chain])) continue;
    const client = evmClient(cfg, secrets, chain, secrets.rpcWs[chain] ? "ws" : "http");
    const pm = requireAddress(cfg.chains[chain].uniswapV4.poolManager, `${chain} PoolManager`);
    const w = new EvmSwapWatcher({
      client,
      poolManager: pm,
      poolIds: () => store.poolIds(chain) as `0x${string}`[],
      pollMs: cfg.simulator.evmPollMs,
      maxRange: BigInt(cfg.chains[chain].logChunkBlocks),
      onSwap: (u) => {
        if (store.onV4Swap(chain, u.poolId, u)) o.onSwap?.(chain, u, store.slugOfPool(chain, u.poolId)!);
      },
      onError: (e) => log.warn({ chain, err: e.message.split("\n")[0] }, "evm watcher error (will retry)"),
    });
    w.start();
    watchers.push(w);
    log.info({ chain, transport: secrets.rpcWs[chain] ? "ws" : "http-poll", pools: store.poolIds(chain).length }, "swap watcher started");
  }

  let sol: SolanaPoolWatcher | null = null;
  if (cfg.chains.solana.enabled && secrets.rpcHttp.solana) {
    const conn = new Connection(secrets.rpcHttp.solana, { commitment: "confirmed", wsEndpoint: secrets.rpcWs.solana });
    sol = new SolanaPoolWatcher(
      conn,
      (u) => {
        if (store.onDammUpdate(u.poolId, u)) o.onDamm?.(u, store.slugOfPool("solana", u.poolId)!);
      },
      (e) => log.warn({ chain: "solana", err: e.message }, "solana watcher error"),
    );
    sol.watch(store.poolIds("solana"));
    log.info({ pools: store.poolIds("solana").length }, "solana watcher started");
  }

  const missing = [...EVM_CHAINS, "solana" as const].filter((c) => !rpcChains(secrets).has(c));
  if (missing.length) log.warn({ chains: missing }, "no RPC configured: these chains use /api/pools readings only");

  return {
    stop: async () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const w of watchers) w.stop();
      await sol?.stop();
    },
  };
}
