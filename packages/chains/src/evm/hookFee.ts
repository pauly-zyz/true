// Infers a Pangea pool's trading fee from on-chain evidence. Pangea's EVM pools have LP fee 0; the
// hook takes the fee in the quote asset (ETH/BNB) and mints itself an ERC-6909 claim on the
// PoolManager in the same transaction. The fee rate = claim / quote amount on the fee side.
import { decodeEventLog, parseAbi, type PublicClient } from "viem";
import { poolManagerEventsAbi } from "./abi.js";

/** ERC-6909 Transfer as emitted by the v4 PoolManager (v4-core ERC6909.sol). */
export const erc6909TransferAbi = parseAbi([
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)",
]);

export interface PoolInit {
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
}

export async function readPoolInit(
  client: PublicClient,
  poolManager: `0x${string}`,
  poolId: `0x${string}`,
  launchBlock: bigint,
): Promise<PoolInit | null> {
  const logs = await client.getLogs({
    address: poolManager,
    event: poolManagerEventsAbi[0],
    args: { id: poolId },
    fromBlock: launchBlock,
    toBlock: launchBlock,
  });
  const a = logs[0]?.args;
  if (!a || a.fee === undefined || a.tickSpacing === undefined || !a.hooks || !a.currency0 || !a.currency1) return null;
  return { fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks, currency0: a.currency0, currency1: a.currency1 };
}

export interface HookFeeSample {
  txHash: string;
  side: "buy" | "sell";
  quoteAmount: bigint; // the quote amount the fee was charged on
  hookFee: bigint;
  pips: number;
}

/**
 * Given one swap's pool deltas (v4 sign convention, swapper perspective: negative = paid) and the hook's
 * claim in the same transaction, compute the fee in pips. Quote is currency0 (native).
 */
export function hookFeePips(amount0: bigint, hookFee: bigint): HookFeeSample["pips"] {
  // buy: swapper pays currency0 -> fee taken before the swap from the gross input
  if (amount0 < 0n) return Number((hookFee * 1_000_000n) / (-amount0 + hookFee));
  // sell: swapper receives currency0 -> fee taken from the pool output
  return Number((hookFee * 1_000_000n) / amount0);
}

/** Round a measured fee to the nearest basis point (100 pips); Pangea fees are whole bps. */
export function roundToBps(pips: number): number {
  return Math.round(pips / 100) * 100;
}

export async function sampleHookFees(
  client: PublicClient,
  poolManager: `0x${string}`,
  hook: `0x${string}`,
  poolId: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  maxSamples = 3,
): Promise<HookFeeSample[]> {
  const swaps = await client.getLogs({ address: poolManager, event: poolManagerEventsAbi[2], args: { id: poolId }, fromBlock, toBlock });
  const out: HookFeeSample[] = [];
  for (const s of swaps.slice(0, maxSamples * 3)) {
    if (out.length >= maxSamples) break;
    const amount0 = s.args.amount0;
    if (amount0 === undefined || amount0 === 0n) continue;
    const receipt = await client.getTransactionReceipt({ hash: s.transactionHash });
    // the hook's claim: ERC-6909 Transfer on the PoolManager, minted (from = 0) to the hook, id 0 = native
    const claims = receipt.logs
      .filter((l) => l.address.toLowerCase() === poolManager.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: erc6909TransferAbi, data: l.data, topics: l.topics });
        } catch {
          return null;
        }
      })
      .filter((d) => d && d.args.to.toLowerCase() === hook.toLowerCase() && d.args.id === 0n);
    if (claims.length !== 1) continue; // ambiguous (multi-swap tx); skip
    const hookFee = claims[0]!.args.amount;
    out.push({
      txHash: s.transactionHash,
      side: amount0 < 0n ? "buy" : "sell",
      quoteAmount: amount0 < 0n ? -amount0 + hookFee : amount0,
      hookFee,
      pips: hookFeePips(amount0, hookFee),
    });
  }
  return out;
}
