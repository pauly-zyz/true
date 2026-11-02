// Realised amounts and costs of a swap leg from its receipt. On Pangea pools the PoolManager Swap event
// carries the pool's deltas without the hook fee; the hook's fee is its ERC-6909 claim (currency id 0 =
// native) minted in the same transaction. Verified against real Robinhood transactions (test/receipts.test.ts).
import { decodeEventLog, type Log, type TransactionReceipt } from "viem";
import { erc6909TransferAbi, poolManagerEventsAbi } from "@true/chains";

export interface SwapLegResult {
  success: boolean;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** Gas paid, in native units (wei). L2 data/L1 fees, if any, are not included. */
  gasCostNative: bigint;
  /** What the wallet paid: native (buy) or tokens (sell), raw units. */
  amountIn: bigint;
  /** What the wallet received: tokens (buy) or native (sell), raw units. */
  amountOut: bigint;
  hookFee: bigint;
  blockNumber: bigint;
}

type ReceiptLike = Pick<TransactionReceipt, "status" | "gasUsed" | "effectiveGasPrice" | "blockNumber"> & {
  logs: readonly Log[];
};

export function parseSwapReceipt(
  receipt: ReceiptLike,
  o: { poolManager: `0x${string}`; poolId: `0x${string}`; hook: `0x${string}`; side: "buy" | "sell" },
): SwapLegResult {
  const base = {
    success: receipt.status === "success",
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostNative: receipt.gasUsed * receipt.effectiveGasPrice,
    blockNumber: receipt.blockNumber,
  };
  if (!base.success) return { ...base, amountIn: 0n, amountOut: 0n, hookFee: 0n };

  const pm = o.poolManager.toLowerCase();
  let amount0: bigint | null = null;
  let amount1: bigint | null = null;
  let hookFee = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== pm) continue;
    try {
      const d = decodeEventLog({ abi: poolManagerEventsAbi, data: l.data, topics: l.topics });
      if (d.eventName === "Swap" && d.args.id.toLowerCase() === o.poolId.toLowerCase()) {
        if (amount0 !== null) throw new Error("more than one swap on this pool in one transaction");
        amount0 = d.args.amount0;
        amount1 = d.args.amount1;
      }
      continue;
    } catch (e) {
      if ((e as Error).message.startsWith("more than one")) throw e;
    }
    try {
      const t = decodeEventLog({ abi: erc6909TransferAbi, data: l.data, topics: l.topics });
      if (t.args.to.toLowerCase() === o.hook.toLowerCase() && t.args.id === 0n) hookFee += t.args.amount;
    } catch {
      /* other PoolManager event */
    }
  }
  if (amount0 === null || amount1 === null) throw new Error("no Swap event for this pool in the receipt");
  // v4 deltas are from the swapper's side: negative = paid, positive = received
  if (o.side === "buy") {
    if (amount0 >= 0n || amount1 <= 0n) throw new Error("receipt does not look like a buy");
    return { ...base, amountIn: -amount0 + hookFee, amountOut: amount1, hookFee };
  }
  if (amount1 >= 0n || amount0 <= 0n) throw new Error("receipt does not look like a sell");
  return { ...base, amountIn: -amount1, amountOut: amount0 - hookFee, hookFee };
}

export function explorerUrl(prefix: string | null, txHash: string): string | null {
  return prefix ? `${prefix}${txHash}` : null;
}
