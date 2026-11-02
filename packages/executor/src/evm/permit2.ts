// Token approvals for selling through the Universal Router: token -> Permit2 (ERC-20 approve), then a
// Permit2 allowance for the router that is capped in amount and expires (default 24 h).
import { encodeFunctionData, maxUint160, type PublicClient } from "viem";
import { erc20Abi, permit2Abi } from "./abis.js";
import type { TxPlan } from "./v4Swap.js";

export async function plannedApprovals(
  client: PublicClient,
  o: {
    owner: `0x${string}`;
    token: `0x${string}`;
    permit2: `0x${string}`;
    router: `0x${string}`;
    amount: bigint;
    nowSec: number;
    ttlSec?: number;
  },
): Promise<TxPlan[]> {
  const plans: TxPlan[] = [];
  const erc20Allowance = await client.readContract({
    address: o.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [o.owner, o.permit2],
  });
  if (erc20Allowance < o.amount) {
    // Permit2 is the limiting control; the ERC-20 approval to Permit2 itself is the standard large value
    plans.push({
      to: o.token,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [o.permit2, maxUint160] }),
    });
  }
  const [amount, expiration] = await client.readContract({
    address: o.permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [o.owner, o.token, o.router],
  });
  if (amount < o.amount || expiration <= o.nowSec + 60) {
    const exp = o.nowSec + (o.ttlSec ?? 86_400);
    plans.push({
      to: o.permit2,
      value: 0n,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [o.token, o.router, o.amount, exp],
      }),
    });
  }
  return plans;
}
