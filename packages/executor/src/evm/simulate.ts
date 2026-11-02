// Pre-trade checks for one swap leg: (1) V4Quoter gives the exact output the swapper would receive
// (PoolManager returns deltas after hook adjustments, so the Pangea hook fee is included); (2) eth_call of
// the exact Universal Router transaction from the bot wallet must not revert; (3) the quoted output must
// match our model within a tolerance.
import { BaseError, ContractFunctionRevertedError, type PublicClient, type StateOverride } from "viem";
import { v4QuoterAbi } from "./abis.js";
import type { PoolKey, TxPlan } from "./v4Swap.js";

export async function quoteExactInputSingle(
  client: PublicClient,
  quoter: `0x${string}`,
  poolKey: PoolKey,
  side: "buy" | "sell",
  amountIn: bigint,
): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne: side === "buy", exactAmount: amountIn, hookData: "0x" }],
  });
  return { amountOut: result[0], gasEstimate: result[1] };
}

export interface TxSimulation {
  ok: boolean;
  gas?: bigint;
  error?: string;
}

/** eth_call + eth_estimateGas of the exact transaction, from the wallet that will send it. */
export async function simulateTx(
  client: PublicClient,
  from: `0x${string}`,
  tx: TxPlan,
  stateOverride?: StateOverride,
): Promise<TxSimulation> {
  try {
    await client.call({ account: from, to: tx.to, data: tx.data, value: tx.value, stateOverride });
    const gas = stateOverride
      ? undefined
      : await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true, gas };
  } catch (e) {
    return { ok: false, error: describeRevert(e) };
  }
}

export function describeRevert(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.reason ?? r.signature ?? r.shortMessage;
    return e.shortMessage;
  }
  return (e as Error).message ?? String(e);
}

/** Relative difference between the quoted and the modelled output, in bps (positive = quote better). */
export function diffBps(quoted: bigint, modelled: bigint): number {
  if (modelled === 0n) return quoted === 0n ? 0 : Infinity;
  return Number(((quoted - modelled) * 1_000_000n) / modelled) / 100;
}

export function withinTolerance(quoted: bigint, modelled: bigint, toleranceBps: number): boolean {
  return Math.abs(diffBps(quoted, modelled)) <= toleranceBps;
}
