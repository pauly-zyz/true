// The only path to broadcasting a transaction. Every check is re-evaluated right before each send.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainName, Config } from "@true/core";

export class BroadcastBlocked extends Error {
  constructor(readonly reason: string) {
    super(`broadcast blocked: ${reason}`);
  }
}

export interface GuardState {
  /** Set by the daily-loss circuit breaker; cleared only by a manual restart. */
  breakerTripped: boolean;
  /** Coins paused after a failed leg, until `pnpm live:resume <slug>`. */
  pausedCoins: Set<string>;
}

export function killFilePath(cfg: Config, root: string): string {
  return `${root}${cfg.live!.killFile}`;
}

export function isKilled(cfg: Config, root: string): { killed: boolean; reason?: string } {
  const f = killFilePath(cfg, root);
  if (!existsSync(f)) return { killed: false };
  return { killed: true, reason: readFileSync(f, "utf8").trim() || "kill file present" };
}

export function engageKill(cfg: Config, root: string, reason: string): void {
  const f = killFilePath(cfg, root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${new Date().toISOString()} ${reason}\n`);
}

/**
 * Throws BroadcastBlocked unless live trading is armed (DRY_RUN=false and LIVE_CONFIRM=yes), the chain is
 * enabled for live trading, no kill switch is engaged, the circuit breaker has not tripped and the coin
 * is not paused.
 */
export function assertCanBroadcast(
  cfg: Config,
  root: string,
  chain: ChainName,
  state: GuardState,
  slug?: string,
): void {
  if (cfg.dryRun || !cfg.liveArmed)
    throw new BroadcastBlocked("dry run (set DRY_RUN=false and LIVE_CONFIRM=yes to arm)");
  if (!cfg.live) throw new BroadcastBlocked("no live section in config");
  if (!cfg.live.chains[chain]?.enabled)
    throw new BroadcastBlocked(`${chain} is not enabled for live trading`);
  const k = isKilled(cfg, root);
  if (k.killed) throw new BroadcastBlocked(`kill switch: ${k.reason}`);
  if (state.breakerTripped) throw new BroadcastBlocked("daily loss circuit breaker tripped");
  if (slug && state.pausedCoins.has(slug)) throw new BroadcastBlocked(`${slug} is paused after a failed leg`);
}
