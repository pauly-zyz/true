// Per-chain operations used by the executor. The EVM implementation wires the audited building blocks;
// tests replace it with a mock.
import type { PublicClient, TransactionReceipt } from "viem";
import type { ChainName, Config } from "@true/core";
import { erc20Abi } from "./evm/abis.js";
import { plannedApprovals } from "./evm/permit2.js";
import { quoteExactInputSingle, simulateTx, type TxSimulation } from "./evm/simulate.js";
import type { PoolKey, TxPlan } from "./evm/v4Swap.js";
import type { GuardState } from "./guard.js";
import { sendGuarded } from "./sender.js";
import type { BotWallet } from "./wallets.js";

export interface LegOps {
  chain: ChainName;
  address: `0x${string}`;
  canSign: boolean;
  quote(poolKey: PoolKey, side: "buy" | "sell", amountIn: bigint): Promise<bigint>;
  simulate(plan: TxPlan): Promise<TxSimulation>;
  approvalsFor(token: `0x${string}`, amount: bigint): Promise<TxPlan[]>;
  nativeBalance(): Promise<bigint>;
  tokenBalance(token: `0x${string}`): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  send(plan: TxPlan, slug?: string): Promise<`0x${string}`>;
  receipt(hash: `0x${string}`, timeoutMs: number): Promise<TransactionReceipt>;
}

export function evmLegOps(o: {
  cfg: Config;
  root: string;
  guard: GuardState;
  chain: ChainName;
  client: PublicClient;
  wallet: BotWallet;
  rpcUrl: string;
}): LegOps {
  const v4 = o.cfg.chains[o.chain].uniswapV4;
  const need = (x: string | null, what: string) => {
    if (!x) throw new Error(`${o.chain}: ${what} not configured`);
    return x as `0x${string}`;
  };
  return {
    chain: o.chain,
    address: o.wallet.address,
    canSign: !!o.wallet.account,
    quote: async (key, side, amountIn) =>
      (await quoteExactInputSingle(o.client, need(v4.quoter, "V4Quoter"), key, side, amountIn)).amountOut,
    simulate: (plan) => simulateTx(o.client, o.wallet.address, plan),
    approvalsFor: (token, amount) =>
      plannedApprovals(o.client, {
        owner: o.wallet.address,
        token,
        permit2: need(v4.permit2, "Permit2"),
        router: need(v4.universalRouter, "Universal Router"),
        amount,
        nowSec: Math.floor(Date.now() / 1000),
      }),
    nativeBalance: () => o.client.getBalance({ address: o.wallet.address }),
    tokenBalance: (token) =>
      o.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [o.wallet.address],
      }),
    gasPrice: () => o.client.getGasPrice(),
    send: (plan, slug) =>
      sendGuarded(
        { cfg: o.cfg, root: o.root, guard: o.guard, chain: o.chain, slug, rpcUrl: o.rpcUrl },
        o.wallet,
        o.client,
        plan,
      ),
    receipt: (hash, timeoutMs) => o.client.waitForTransactionReceipt({ hash, timeout: timeoutMs }),
  };
}
