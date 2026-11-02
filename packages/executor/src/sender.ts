// The ONLY function in the repository that broadcasts a transaction. It re-checks the guard right before
// signing, so DRY_RUN, LIVE_CONFIRM, the chain switch, the kill file and the circuit breaker all apply.
import { createWalletClient, http, type Chain, type PublicClient } from "viem"; // safety-check: allow
import type { ChainName, Config } from "@true/core";
import { assertCanBroadcast, type GuardState } from "./guard.js";
import type { BotWallet } from "./wallets.js";
import type { TxPlan } from "./evm/v4Swap.js";

export interface SendContext {
  cfg: Config;
  root: string;
  guard: GuardState;
  chain: ChainName;
  slug?: string;
  rpcUrl: string;
}

export async function sendGuarded(
  ctx: SendContext,
  wallet: BotWallet,
  client: PublicClient,
  plan: TxPlan,
): Promise<`0x${string}`> {
  assertCanBroadcast(ctx.cfg, ctx.root, ctx.chain, ctx.guard, ctx.slug);
  if (!wallet.account)
    throw new Error(`${ctx.chain}: no signing key configured (BOT_PK_${ctx.chain.toUpperCase()})`); // safety-check: allow
  const opts = { account: wallet.account, chain: client.chain as Chain, transport: http(ctx.rpcUrl) };
  const wc = createWalletClient(opts); // safety-check: allow
  const req = { to: plan.to, data: plan.data, value: plan.value, chain: client.chain as Chain };
  return wc.sendTransaction(req); // safety-check: allow
}
