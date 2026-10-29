// Follows PoolManager Swap events for the watched pools on one EVM chain.
// HTTP: polls eth_getLogs from the last processed block (gaps after a disconnect are backfilled
// automatically). WS: subscribes, and backfills the same way after every reconnect.
import type { PublicClient } from "viem";
import { poolManagerEventsAbi } from "../evm/abi.js";

export interface SwapUpdate {
  poolId: `0x${string}`;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  fee: number;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

export interface EvmWatcherOptions {
  client: PublicClient;
  poolManager: `0x${string}`;
  poolIds: () => `0x${string}`[];
  onSwap: (u: SwapUpdate) => void;
  onError?: (e: Error) => void;
  pollMs?: number;
  /** Max block span per eth_getLogs request. */
  maxRange?: bigint;
  /** Start this many blocks behind head on first run (0 = only new blocks). */
  startBehind?: bigint;
}

export function toSwapUpdates(logs: ReadonlyArray<{ args: Record<string, unknown>; blockNumber: bigint | null; transactionHash: `0x${string}` | null; logIndex: number | null }>): SwapUpdate[] {
  const out: SwapUpdate[] = [];
  for (const l of logs) {
    const a = l.args as { id?: `0x${string}`; sqrtPriceX96?: bigint; tick?: number; liquidity?: bigint; amount0?: bigint; amount1?: bigint; fee?: number };
    if (!a.id || a.sqrtPriceX96 === undefined || a.tick === undefined || a.liquidity === undefined || l.blockNumber === null || !l.transactionHash || l.logIndex === null) continue;
    out.push({
      poolId: a.id,
      sqrtPriceX96: a.sqrtPriceX96,
      tick: a.tick,
      liquidity: a.liquidity,
      amount0: a.amount0 ?? 0n,
      amount1: a.amount1 ?? 0n,
      fee: a.fee ?? 0,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
    });
  }
  // chronological order matters: the last swap in a block defines the state
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

/** Split [from, to] into chunks of at most `max` blocks. */
export function blockRanges(from: bigint, to: bigint, max: bigint): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let a = from; a <= to; a += max) out.push([a, a + max - 1n < to ? a + max - 1n : to]);
  return out;
}

export class EvmSwapWatcher {
  private last: bigint | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly o: EvmWatcherOptions) {}

  /** Process all logs between the last processed block and `head`. Exposed for tests. */
  async catchUp(head: bigint): Promise<number> {
    const ids = this.o.poolIds();
    if (this.last === null) this.last = head - (this.o.startBehind ?? 0n);
    if (head <= this.last || ids.length === 0) {
      this.last = head > this.last ? head : this.last;
      return 0;
    }
    let n = 0;
    for (const [from, to] of blockRanges(this.last + 1n, head, this.o.maxRange ?? 2000n)) {
      const logs = await this.o.client.getLogs({ address: this.o.poolManager, event: poolManagerEventsAbi[2], args: { id: ids }, fromBlock: from, toBlock: to });
      for (const u of toSwapUpdates(logs as never)) {
        this.o.onSwap(u);
        n++;
      }
      this.last = to;
    }
    return n;
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.catchUp(await this.o.client.getBlockNumber({ cacheTime: 0 }));
      } catch (e) {
        this.o.onError?.(e as Error);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.o.pollMs ?? 1000);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
