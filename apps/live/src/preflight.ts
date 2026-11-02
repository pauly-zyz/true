// Read-only checks that must all pass before live trading: RPCs, chain ids, contract bytecode, wallets,
// balances, pool keys, and the pool model against the official V4Quoter on every live chain.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEther } from "viem";
import { loadConfig, loadSecrets, type ChainName } from "@true/core";
import {
  evmClient,
  liveStateFromPangea,
  loadCoinFees,
  PangeaPoolsClient,
  stateViewAbi,
  venueFromLive,
} from "@true/chains";
import { diffBps, loadEvmWallet, quoteExactInputSingle, walletEnvHint } from "@true/executor";
import { loadPoolKeys } from "./pools.js";
import { telegramFromEnv } from "./telegram.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const cfg = loadConfig(`${ROOT}config/default.yaml`);
const secrets = loadSecrets();
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const note = (check: string, ok: boolean, detail = "") => results.push({ check, ok, detail });

const chains = (Object.entries(cfg.live!.chains) as Array<[ChainName, { enabled: boolean }]>)
  .filter(([, c]) => c.enabled)
  .map(([c]) => c);
const clients: Partial<Record<ChainName, ReturnType<typeof evmClient>>> = {};
for (const chain of chains) {
  if (chain === "solana") {
    note(
      `${chain}: executor`,
      false,
      "Solana live execution is not implemented in Phase 2; keep it disabled",
    );
    continue;
  }
  if (!secrets.rpcHttp[chain]) {
    note(`${chain}: RPC`, false, `RPC_HTTP_${chain.toUpperCase()} not set`);
    continue;
  }
  const c = evmClient(cfg, secrets, chain);
  clients[chain] = c;
  try {
    const id = await c.getChainId();
    note(`${chain}: chain id`, id === cfg.chains[chain].chainId, `${id}`);
    const v4 = cfg.chains[chain].uniswapV4;
    for (const [name, addr] of Object.entries({
      PoolManager: v4.poolManager,
      StateView: v4.stateView,
      V4Quoter: v4.quoter,
      UniversalRouter: v4.universalRouter,
      Permit2: v4.permit2,
    })) {
      const code = addr ? await c.getCode({ address: addr as `0x${string}` }) : undefined;
      note(`${chain}: ${name} bytecode`, !!code && code.length > 2, addr ?? "not configured");
    }
    const w = loadEvmWallet(chain);
    note(
      `${chain}: wallet`,
      !!w,
      w ? `${w.address}${w.account ? " (can sign)" : " (address only: dry run)"}` : walletEnvHint(chain),
    );
    if (w) {
      const bal = await c.getBalance({ address: w.address });
      note(`${chain}: native balance`, bal > 0n, `${Number(bal) / 1e18}`);
    }
  } catch (e) {
    note(`${chain}: RPC`, false, (e as Error).message.split("\n")[0]!);
  }
}

const coins = loadCoinFees(`${ROOT}data/phase0/fees.json`);
const snap = await new PangeaPoolsClient(cfg.pangea.apiBase).get();
const poolKey = await loadPoolKeys(
  cfg,
  ROOT,
  clients,
  snap,
  coins.map((c) => c.slug),
);
for (const coin of coins.slice(0, 10)) {
  for (const chain of Object.keys(clients) as ChainName[]) {
    const info = poolKey(coin.slug, chain);
    if (!info) {
      note(`${coin.slug}@${chain}: pool key`, false, "not found");
      continue;
    }
    note(
      `${coin.slug}@${chain}: pool key`,
      info.poolKey.fee === 0 && info.poolKey.tickSpacing === 60,
      `fee ${info.poolKey.fee} tickSpacing ${info.poolKey.tickSpacing} hooks ${info.poolKey.hooks}`,
    );
    try {
      const c = clients[chain]!;
      const v4 = cfg.chains[chain].uniswapV4;
      const p = snap.launches.find((l) => l.slug === coin.slug)!.pools.find((x) => x.chain === chain)!;
      const st = liveStateFromPangea(p, coin.feePips, Date.now()) as ReturnType<
        typeof liveStateFromPangea
      > & { sqrtPriceX96: bigint; tick: number; liquidity: bigint };
      const [sqrt, tick] = await c.readContract({
        address: v4.stateView as `0x${string}`,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [info.poolId],
      });
      const L = await c.readContract({
        address: v4.stateView as `0x${string}`,
        abi: stateViewAbi,
        functionName: "getLiquidity",
        args: [info.poolId],
      });
      Object.assign(st, { sqrtPriceX96: sqrt, tick, liquidity: L });
      const amt = parseEther("0.001");
      const q = await quoteExactInputSingle(c, v4.quoter as `0x${string}`, info.poolKey, "buy", amt);
      const m = venueFromLive(st).buyToken(amt).amountOut;
      const d = diffBps(q.amountOut, m);
      note(
        `${coin.slug}@${chain}: model vs V4Quoter`,
        Math.abs(d) <= cfg.live!.simToleranceBps,
        `${d.toFixed(3)} bps`,
      );
    } catch (e) {
      note(`${coin.slug}@${chain}: model vs V4Quoter`, false, (e as Error).message.split("\n")[0]!);
    }
  }
}
note(
  "telegram",
  !!telegramFromEnv(),
  telegramFromEnv() ? "configured" : "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set",
);
note("mode", true, cfg.liveArmed ? "LIVE ARMED (DRY_RUN=false, LIVE_CONFIRM=yes)" : "dry run");

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(42)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed: do not go live.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
