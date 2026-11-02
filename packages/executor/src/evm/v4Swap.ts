// Builds Universal Router calldata for a single-pool exact-input swap on a Pangea Uniswap v4 pool,
// using the official @uniswap/v4-sdk V4Planner and @uniswap/universal-router-sdk RoutePlanner.
// Pangea pools: currency0 = native (address 0), currency1 = token, LP fee 0, tickSpacing 60, plus a hook.
import { CommandType, RoutePlanner, UniversalRouterVersion } from "@uniswap/universal-router-sdk";
import { Actions, URVersion, V4Planner } from "@uniswap/v4-sdk";
import { encodeFunctionData, zeroAddress } from "viem";
import { universalRouterAbi } from "./abis.js";

export interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export type RouterVersion = "2.0" | "2.1.1" | "2.1.2" | "2.2.0";

export interface SwapTxRequest {
  router: `0x${string}`;
  routerVersion: RouterVersion;
  poolKey: PoolKey;
  /** buy = native in, token out; sell = token in, native out. */
  side: "buy" | "sell";
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint; // unix seconds
}

export interface TxPlan {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

const UINT128_MAX = (1n << 128n) - 1n;

export function pangeaPoolKey(
  token: `0x${string}`,
  hooks: `0x${string}`,
  fee = 0,
  tickSpacing = 60,
): PoolKey {
  return { currency0: zeroAddress, currency1: token, fee, tickSpacing, hooks };
}

export function buildV4SwapTx(r: SwapTxRequest): TxPlan {
  if (r.poolKey.currency0 !== zeroAddress)
    throw new Error("expected a native/token pool (currency0 = native)");
  if (r.amountIn <= 0n || r.amountIn > UINT128_MAX) throw new Error("amountIn out of range");
  if (r.amountOutMinimum <= 0n)
    throw new Error("amountOutMinimum must be > 0 (never swap without slippage protection)");
  const zeroForOne = r.side === "buy";
  const [inCur, outCur] = zeroForOne
    ? [r.poolKey.currency0, r.poolKey.currency1]
    : [r.poolKey.currency1, r.poolKey.currency0];
  const urv = r.routerVersion as unknown as URVersion;

  const v4 = new V4Planner();
  v4.addAction(
    Actions.SWAP_EXACT_IN_SINGLE,
    [
      {
        poolKey: r.poolKey,
        zeroForOne,
        amountIn: r.amountIn.toString(),
        amountOutMinimum: r.amountOutMinimum.toString(),
        // router >= 2.1.1 takes a per-hop minimum price; 0 = no extra check (amountOutMinimum protects us)
        minHopPriceX36: "0",
        hookData: "0x",
      },
    ],
    urv,
  );
  v4.addAction(Actions.SETTLE_ALL, [inCur, r.amountIn.toString()]);
  v4.addAction(Actions.TAKE_ALL, [outCur, r.amountOutMinimum.toString()]);

  const plan = new RoutePlanner();
  plan.addCommand(
    CommandType.V4_SWAP,
    [v4.finalize()],
    false,
    r.routerVersion as unknown as UniversalRouterVersion,
  );
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [plan.commands as `0x${string}`, plan.inputs as `0x${string}`[], r.deadline],
  });
  return { to: r.router, data, value: zeroForOne ? r.amountIn : 0n };
}

/** amountOutMinimum from an expected output and a slippage tolerance in bps (rounded down). */
export function minOut(expected: bigint, slippageBps: number): bigint {
  return (expected * BigInt(10_000 - Math.round(slippageBps))) / 10_000n;
}
