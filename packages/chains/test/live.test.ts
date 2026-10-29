import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { blockRanges, EvmSwapWatcher, toSwapUpdates, type SwapUpdate } from "../src/live/evmWatcher.js";
import { dammUpdateFromDecoded } from "../src/live/solanaWatcher.js";
import { LiveStore } from "../src/live/store.js";
import { parsePoolsResponse } from "../src/pangea/pools.js";
import { venueFromLive } from "../src/live/state.js";

const snap = parsePoolsResponse(JSON.parse(readFileSync(new URL("./fixtures/pools-2026-10-29.json", import.meta.url), "utf8")));
const coins = [{ slug: "pangea-dadd0d", symbol: "PANGEA", feePips: 10_000, tickSpacing: 60 }];

const PANGEA_RH_POOL = "0xcfe04bc182706f8683f4f486104b52fb6a4115cfe9e4471c468fca65703f9b9d"; // poolId
const log = (block: bigint, idx: number, sqrt: bigint) => ({
  args: { id: PANGEA_RH_POOL, sqrtPriceX96: sqrt, tick: -64379, liquidity: 1097456632423063954n, amount0: 1n, amount1: -1n, fee: 0 },
  blockNumber: block,
  transactionHash: `0x${"ab".repeat(32)}` as `0x${string}`,
  logIndex: idx,
});

describe("EVM swap watcher", () => {
  it("splits block ranges", () => {
    expect(blockRanges(10n, 25n, 10n)).toEqual([
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(blockRanges(5n, 5n, 10n)).toEqual([[5n, 5n]]);
  });

  it("orders logs chronologically", () => {
    const u = toSwapUpdates([log(2n, 0, 3n), log(1n, 5, 2n), log(1n, 1, 1n)]);
    expect(u.map((x) => x.sqrtPriceX96)).toEqual([1n, 2n, 3n]);
  });

  it("catches up from the last processed block, chunked, without gaps or repeats", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return fromBlock <= 150n && 150n <= toBlock ? [log(150n, 0, 42n)] : [];
      },
    };
    const got: SwapUpdate[] = [];
    const w = new EvmSwapWatcher({ client: client as never, poolManager: "0x0000000000000000000000000000000000000001", poolIds: () => ["0x01"], onSwap: (u) => got.push(u), maxRange: 100n, startBehind: 0n });
    expect(await w.catchUp(100n)).toBe(0); // first call only sets the cursor
    expect(await w.catchUp(260n)).toBe(1); // e.g. after a disconnect: 101..260 backfilled
    expect(calls).toEqual([
      [101n, 200n],
      [201n, 260n],
    ]);
    expect(await w.catchUp(260n)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(got[0]!.sqrtPriceX96).toBe(42n);
  });
});

describe("LiveStore", () => {
  it("seeds from a snapshot and applies on-chain swaps", () => {
    const store = new LiveStore(new Set(["robinhood"]));
    const updates: string[] = [];
    store.on("update", (s, c) => updates.push(`${s}:${c}`));
    store.seedFromSnapshot(snap, coins, Date.parse(snap.readAt));
    expect(Object.keys(store.states.get("pangea-dadd0d")!)).toHaveLength(5);
    expect(store.quoteSource).toBe("pangea-rates");
    expect(store.quoteUsdByChain().bsc).toBeCloseTo(747.8, 1);

    const rh = store.states.get("pangea-dadd0d")!.robinhood!;
    expect(rh.kind).toBe("v4");
    const ok = store.onV4Swap("robinhood", rh.poolId.toUpperCase().replace("0X", "0x"), { sqrtPriceX96: 3169438688913804107048125812n, tick: -64379, liquidity: 1097456632423063954n }, Date.parse(snap.readAt) + 1000);
    expect(ok).toBe(true);
    const after = store.states.get("pangea-dadd0d")!.robinhood!;
    expect(after.source).toBe("rpc");
    expect(updates.at(-1)).toBe("pangea-dadd0d:robinhood");

    // a later snapshot with an older readAt does not overwrite the fresher RPC state
    store.seedFromSnapshot(snap, coins, Date.parse(snap.readAt));
    expect(store.states.get("pangea-dadd0d")!.robinhood!.source).toBe("rpc");
    expect(store.onV4Swap("robinhood", "0xdeadbeef", { sqrtPriceX96: 1n, tick: 0, liquidity: 0n })).toBe(false);
    expect(venueFromLive(after).midPriceInQuote()).toBeGreaterThan(0);
  });

  it("maps decoded DAMM v2 accounts", () => {
    const u = dammUpdateFromDecoded("pool", { sqrtPrice: 5n, liquidity: 7n, sqrtMinPrice: 1n, sqrtMaxPrice: 9n, collectFeeMode: 1 });
    expect(u).toEqual({ poolId: "pool", sqrtPrice: 5n, liquidity: 7n, sqrtMinPrice: 1n, sqrtMaxPrice: 9n, collectFeeMode: 1 });
  });
});
