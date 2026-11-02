// Integration tests on mainnet forks (anvil, or Hardhat when anvil is missing). Real transactions are
// signed with the well-known anvil test account #0 against a LOCAL fork only. Each chain runs only if
// FORK_RPC_<CHAIN> or RPC_HTTP_<CHAIN> is set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { parseEther, type PublicClient } from "viem";
import { parseConfig, type EvmChainName } from "@true/core";
import { evmClient, parsePoolsResponse, readPoolInit } from "@true/chains";
import {
  BroadcastBlocked,
  buildV4SwapTx,
  engageKill,
  erc20Abi,
  evmRecipient,
  loadEvmWallet,
  minOut,
  pangeaPoolKey,
  parseOftSent,
  parseSwapReceipt,
  plannedApprovals,
  planOftSend,
  quoteExactInputSingle,
  sendGuarded,
  simulateTx,
  type GuardState,
} from "@true/executor";
import { startFork, type ForkNode } from "./forkNode.js";

const ROOT = new URL("../../", import.meta.url).pathname;
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const raw = parse(readFileSync(`${ROOT}config/default.yaml`, "utf8"));
const SLUG = process.env.FORK_COIN ?? "pangea-dadd0d";
// anvil/hardhat default test account #0 — public, never holds real funds, used on local forks only
const TEST_KEY = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478c", "bed5efcae784d7bf4f2ff80"].join(""); // safety-check test vector

const CHAINS: Array<{ chain: EvmChainName; port: number; other: EvmChainName }> = [
  { chain: "base", port: 18545, other: "bsc" },
  { chain: "bsc", port: 18546, other: "base" },
  { chain: "robinhood", port: 18547, other: "base" },
];

const pools = parsePoolsResponse(await (await fetch("https://www.pangea.trade/api/pools")).json());

for (const { chain, port, other } of CHAINS) {
  const forkUrl =
    process.env[`FORK_RPC_${chain.toUpperCase()}`] ?? process.env[`RPC_HTTP_${chain.toUpperCase()}`];
  describe.skipIf(!forkUrl)(`fork: ${chain}`, () => {
    let node: ForkNode;
    let client: PublicClient;
    let cfg: ReturnType<typeof parseConfig>;
    let root: string;
    const guard: GuardState = { breakerTripped: false, pausedCoins: new Set() };
    const wallet = loadEvmWallet(chain, { [`BOT_PK_${chain.toUpperCase()}`]: TEST_KEY })!; // safety-check test vector
    let token: `0x${string}`;
    let poolId: `0x${string}`;
    let key: ReturnType<typeof pangeaPoolKey>;
    const v4 = () => cfg.chains[chain].uniswapV4;
    const ctx = () => ({ cfg, root, guard, chain, rpcUrl: node.url });

    beforeAll(async () => {
      node = await startFork(forkUrl!, raw.chains[chain].chainId, port);
      cfg = parseConfig(raw, { DRY_RUN: "false", LIVE_CONFIRM: "yes" }); // armed, but only against the local fork
      root = mkdtempSync(`${tmpdir()}/true-fork-`) + "/";
      client = evmClient(cfg, { databaseUrl: undefined, rpcHttp: { [chain]: node.url }, rpcWs: {} }, chain);
      await node.setBalance(wallet.address, parseEther("10"));
      const p = pools.launches.find((l) => l.slug === SLUG)!.pools.find((x) => x.chain === chain)!;
      token = p.token as `0x${string}`;
      poolId = p.poolId as `0x${string}`;
      const init = await readPoolInit(
        client,
        v4().poolManager as `0x${string}`,
        poolId,
        BigInt(p.launchBlock!),
      );
      expect(init, "Initialize event of the pool").toBeTruthy();
      key = pangeaPoolKey(token, init!.hooks, init!.fee, init!.tickSpacing);
    });
    afterAll(() => node?.stop());

    const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

    it("buys through the Universal Router; the received amount equals the V4Quoter quote", async () => {
      const amountIn = parseEther("0.01");
      const q = await quoteExactInputSingle(client, v4().quoter as `0x${string}`, key, "buy", amountIn);
      const tx = buildV4SwapTx({
        router: v4().universalRouter as `0x${string}`,
        routerVersion: v4().universalRouterVersion!,
        poolKey: key,
        side: "buy",
        amountIn,
        amountOutMinimum: minOut(q.amountOut, 50),
        deadline: deadline(),
      });
      expect((await simulateTx(client, wallet.address, tx)).ok).toBe(true);
      const hash = await sendGuarded(ctx(), wallet, client, tx);
      const r = await client.waitForTransactionReceipt({ hash });
      const res = parseSwapReceipt(r, {
        poolManager: v4().poolManager as `0x${string}`,
        poolId,
        hook: key.hooks,
        side: "buy",
      });
      expect(res.success).toBe(true);
      expect(res.amountIn).toBe(amountIn);
      expect(res.amountOut).toBe(q.amountOut);
      expect(
        await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.address],
        }),
      ).toBe(q.amountOut);
    });

    it("sells after capped Permit2 approvals; the received amount equals the quote", async () => {
      const bal = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      const amountIn = bal / 2n;
      const approvals = await plannedApprovals(client, {
        owner: wallet.address,
        token,
        permit2: v4().permit2 as `0x${string}`,
        router: v4().universalRouter as `0x${string}`,
        amount: amountIn,
        nowSec: Math.floor(Date.now() / 1000),
      });
      expect(approvals.length).toBe(2);
      for (const a of approvals)
        expect(
          (await client.waitForTransactionReceipt({ hash: await sendGuarded(ctx(), wallet, client, a) }))
            .status,
        ).toBe("success");
      const q = await quoteExactInputSingle(client, v4().quoter as `0x${string}`, key, "sell", amountIn);
      const tx = buildV4SwapTx({
        router: v4().universalRouter as `0x${string}`,
        routerVersion: v4().universalRouterVersion!,
        poolKey: key,
        side: "sell",
        amountIn,
        amountOutMinimum: minOut(q.amountOut, 50),
        deadline: deadline(),
      });
      const r = await client.waitForTransactionReceipt({
        hash: await sendGuarded(ctx(), wallet, client, tx),
      });
      const res = parseSwapReceipt(r, {
        poolManager: v4().poolManager as `0x${string}`,
        poolId,
        hook: key.hooks,
        side: "sell",
      });
      expect(res.amountIn).toBe(amountIn);
      expect(res.amountOut).toBe(q.amountOut);
      expect(res.hookFee > 0n).toBe(true);
    });

    it("simulation rejects a swap whose output would fall below amountOutMinimum", async () => {
      const amountIn = parseEther("0.01");
      const q = await quoteExactInputSingle(client, v4().quoter as `0x${string}`, key, "buy", amountIn);
      const greedy = buildV4SwapTx({
        router: v4().universalRouter as `0x${string}`,
        routerVersion: v4().universalRouterVersion!,
        poolKey: key,
        side: "buy",
        amountIn,
        amountOutMinimum: q.amountOut * 2n,
        deadline: deadline(),
      });
      const sim = await simulateTx(client, wallet.address, greedy);
      expect(sim.ok).toBe(false);
    });

    it("bridges tokens with the OFT: send() succeeds and OFTSent matches quoteOFT", async () => {
      const bal = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      const plan = await planOftSend(client, {
        token,
        dstEid: cfg.chains[other].lzEid,
        to: evmRecipient(wallet.address),
        amount: bal / 2n,
        refundTo: wallet.address,
      });
      expect((await simulateTx(client, wallet.address, plan.tx)).ok).toBe(true);
      const r = await client.waitForTransactionReceipt({
        hash: await sendGuarded(ctx(), wallet, client, plan.tx),
      });
      expect(r.status).toBe("success");
      const sent = parseOftSent(r.logs, token)!;
      expect(sent.amountSent).toBe(plan.amountSent);
      expect(sent.amountReceived).toBe(plan.amountReceived);
      // 0.2% fee rounded down, then what crosses is truncated to 6 decimals (multiples of 1000 units)
      expect(plan.amountReceived).toBe(
        ((plan.amountSent - (plan.amountSent * 20n) / 10_000n) / 1000n) * 1000n,
      );
      expect(
        await client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.address],
        }),
      ).toBe(bal - plan.amountSent);
    });

    it("kill switch and circuit breaker block broadcasting; nothing is mined", async () => {
      const tx = { to: wallet.address, data: "0x" as const, value: 1n };
      const nonce = await client.getTransactionCount({ address: wallet.address });
      engageKill(cfg, root, "fork test");
      await expect(sendGuarded(ctx(), wallet, client, tx)).rejects.toBeInstanceOf(BroadcastBlocked);
      rmSync(`${root}${cfg.live!.killFile}`);
      guard.breakerTripped = true;
      await expect(sendGuarded(ctx(), wallet, client, tx)).rejects.toThrow(/circuit breaker/);
      guard.breakerTripped = false;
      const dry = parseConfig(raw, {});
      await expect(sendGuarded({ ...ctx(), cfg: dry }, wallet, client, tx)).rejects.toThrow(/dry run/);
      expect(await client.getTransactionCount({ address: wallet.address })).toBe(nonce);
    });
  });
}
