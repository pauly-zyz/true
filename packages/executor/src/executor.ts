// Two-leg inventory-mode execution (RANCANGAN 2.1 step 3): buy on the cheap chain and sell on the
// expensive chain at the same time, from inventory already held on both chains.
//
// Order of checks for every opportunity:
//   live limits (size, trades/hour, one active trade per coin, chains enabled)
//   -> real balances -> V4Quoter quotes vs model (tolerance) -> net profit re-check with quoted amounts
//   -> build txs with amountOutMinimum -> eth_call simulation of both txs
//   -> [dry run stops here] -> guard -> send both -> receipts -> realised PnL -> records/alerts
// A failed leg keeps the filled side as inventory, pauses the coin and alerts (no automatic unwind).
import type { ArbEvaluation, ChainName, Config } from "@true/core";
import { buildV4SwapTx, minOut, type PoolKey, type TxPlan } from "./evm/v4Swap.js";
import { diffBps } from "./evm/simulate.js";
import { explorerUrl, parseSwapReceipt, type SwapLegResult } from "./evm/receipts.js";
import { BroadcastBlocked, engageKill, isKilled, type GuardState } from "./guard.js";
import type { LegOps } from "./legOps.js";

export interface CoinChainInfo {
  token: `0x${string}`;
  poolId: `0x${string}`;
  poolKey: PoolKey;
}

export interface LegRecord {
  chain: ChainName;
  side: "buy" | "sell";
  status: "simulated" | "sent" | "success" | "reverted" | "timeout" | "error" | "skipped";
  txHash?: `0x${string}`;
  explorer?: string | null;
  quotedOut?: bigint;
  minOut?: bigint;
  result?: SwapLegResult;
  gasUsd?: number;
  error?: string;
}

export interface TradeRecord {
  ts: number;
  mode: "dry" | "live";
  slug: string;
  buyChain: ChainName;
  sellChain: ChainName;
  status: "aborted" | "simulated" | "success" | "partial" | "failed";
  reasons: string[];
  model: ArbEvaluation;
  legs: LegRecord[];
  expectedNetUsd: number;
  realNetUsd?: number;
  realCostsUsd?: number;
}

export interface ExecutorDeps {
  cfg: Config;
  root: string;
  guard: GuardState;
  legs: Partial<Record<ChainName, LegOps>>;
  coin: (slug: string, chain: ChainName) => CoinChainInfo | undefined;
  quoteUsd: (chain: ChainName) => number;
  tokenUsd: (slug: string) => number | undefined;
  record: (t: TradeRecord) => Promise<void>;
  riskEvent: (kind: string, detail: Record<string, unknown>) => Promise<void>;
  alert: (text: string) => Promise<void>;
  now?: () => number;
}

const DEC = 9;

export class LiveExecutor {
  private readonly recent: number[] = [];
  private readonly active = new Set<string>();
  private dayKey = "";
  private dayPnlUsd = 0;
  constructor(private readonly d: ExecutorDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  get armed(): boolean {
    return this.d.cfg.liveArmed && !this.d.cfg.dryRun;
  }

  dailyPnlUsd(): number {
    this.rollDay();
    return this.dayPnlUsd;
  }

  private rollDay() {
    const k = new Date(this.now()).toISOString().slice(0, 10);
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.dayPnlUsd = 0;
    }
  }

  /** Record realised PnL (trades, rebalance costs, inventory marks) and trip the breaker if needed. */
  async addPnl(usd: number, source: string): Promise<void> {
    this.rollDay();
    this.dayPnlUsd += usd;
    const limit = -this.d.cfg.risk.dailyLossLimitFraction * this.d.cfg.live!.capitalUsd;
    if (this.dayPnlUsd <= limit && !this.d.guard.breakerTripped) {
      this.d.guard.breakerTripped = true;
      engageKill(
        this.d.cfg,
        this.d.root,
        `circuit breaker: daily PnL ${this.dayPnlUsd.toFixed(2)} USD <= ${limit.toFixed(2)} (${source})`,
      );
      await this.d.riskEvent("circuit_breaker", { dayPnlUsd: this.dayPnlUsd, limit, source });
      await this.d.alert(
        `🛑 Circuit breaker: daily PnL $${this.dayPnlUsd.toFixed(2)} (limit $${limit.toFixed(2)}). Trading stopped; kill file written. Restart manually after review.`,
      );
    }
  }

  async execute(slug: string, ev: ArbEvaluation): Promise<TradeRecord> {
    const cfg = this.d.cfg;
    const live = cfg.live!;
    const t: TradeRecord = {
      ts: this.now(),
      mode: this.armed ? "live" : "dry",
      slug,
      buyChain: ev.buyChain,
      sellChain: ev.sellChain,
      status: "aborted",
      reasons: [],
      model: ev,
      legs: [],
      expectedNetUsd: ev.netUsd,
    };
    const abort = async (reason: string) => {
      t.reasons.push(reason);
      await this.d.record(t);
      return t;
    };

    // --- live limits ---
    for (const c of [ev.buyChain, ev.sellChain])
      if (!live.chains[c]?.enabled) return abort(`${c} is not enabled for live trading`);
    if (isKilled(cfg, this.d.root).killed) return abort("kill switch engaged");
    if (this.d.guard.breakerTripped) return abort("circuit breaker tripped");
    if (this.d.guard.pausedCoins.has(slug)) return abort(`${slug} is paused after a failed leg`);
    if (ev.notionalUsd > live.maxTradeUsd)
      return abort(`size $${ev.notionalUsd.toFixed(2)} > live max $${live.maxTradeUsd}`);
    const hourAgo = this.now() - 3_600_000;
    while (this.recent.length && this.recent[0]! < hourAgo) this.recent.shift();
    if (this.recent.length >= live.maxTradesPerHour) return abort("max trades per hour reached");
    if (this.active.has(slug)) return abort("a trade on this coin is already in flight");

    const buy = this.d.legs[ev.buyChain];
    const sell = this.d.legs[ev.sellChain];
    const bi = this.d.coin(slug, ev.buyChain);
    const si = this.d.coin(slug, ev.sellChain);
    if (!buy || !sell || !bi || !si) return abort("missing chain handle or pool info");

    this.active.add(slug);
    try {
      // --- balances ---
      const [buyNative, sellNative, sellToken, buyGasPrice, sellGasPrice] = await Promise.all([
        buy.nativeBalance(),
        sell.nativeBalance(),
        sell.tokenBalance(si.token),
        buy.gasPrice(),
        sell.gasPrice(),
      ]);
      const gasUnits = (c: ChainName) => BigInt(cfg.chains[c].swapGasUnits);
      const buyGas = buyGasPrice * gasUnits(ev.buyChain) * 2n; // 2x buffer
      const sellGas = sellGasPrice * gasUnits(ev.sellChain) * 3n; // approvals may be needed
      if (buyNative < ev.quoteIn + buyGas) return await abort(`insufficient ${ev.buyChain} native balance`);
      if (sellNative < sellGas) return await abort(`insufficient ${ev.sellChain} gas balance`);
      if (sellToken < ev.tokenSold) return await abort(`insufficient ${slug} inventory on ${ev.sellChain}`);

      // --- quotes vs model ---
      const qBuy = await buy.quote(bi.poolKey, "buy", ev.quoteIn);
      const qSell = await sell.quote(si.poolKey, "sell", ev.tokenSold);
      const dBuy = diffBps(qBuy, ev.tokenBought);
      const dSell = diffBps(qSell, ev.quoteOut);
      if (Math.abs(dBuy) > live.simToleranceBps)
        return await abort(`buy quote differs from model by ${dBuy.toFixed(1)} bps`);
      if (Math.abs(dSell) > live.simToleranceBps)
        return await abort(`sell quote differs from model by ${dSell.toFixed(1)} bps`);

      // --- net profit re-check with quoted amounts ---
      const qbUsd = this.d.quoteUsd(ev.buyChain);
      const qsUsd = this.d.quoteUsd(ev.sellChain);
      const gasUsdEst =
        (Number(buyGasPrice * gasUnits(ev.buyChain)) / 1e18) * qbUsd +
        (Number(sellGasPrice * gasUnits(ev.sellChain)) / 1e18) * qsUsd;
      const nonGasCosts = ev.costs.total - ev.costs.gasUsd;
      const quotedNet =
        (Number(qSell) / 1e18) * qsUsd - (Number(ev.quoteIn) / 1e18) * qbUsd - gasUsdEst - nonGasCosts;
      t.expectedNetUsd = quotedNet;
      if (
        quotedNet < cfg.risk.minNetProfitUsd ||
        (quotedNet / ev.notionalUsd) * 1e4 < cfg.risk.minNetProfitBps
      ) {
        return await abort(`net with live quotes and gas $${quotedNet.toFixed(2)} below minimum`);
      }

      // --- build and simulate ---
      const deadline = BigInt(Math.floor(this.now() / 1000) + live.deadlineSec);
      const mk = (
        chain: ChainName,
        side: "buy" | "sell",
        key: PoolKey,
        amountIn: bigint,
        quoted: bigint,
      ): TxPlan => {
        const v4 = cfg.chains[chain].uniswapV4;
        return buildV4SwapTx({
          router: v4.universalRouter as `0x${string}`,
          routerVersion: v4.universalRouterVersion!,
          poolKey: key,
          side,
          amountIn,
          amountOutMinimum: minOut(quoted, live.slippageBps),
          deadline,
        });
      };
      const buyTx = mk(ev.buyChain, "buy", bi.poolKey, ev.quoteIn, qBuy);
      const sellTx = mk(ev.sellChain, "sell", si.poolKey, ev.tokenSold, qSell);
      const buyLeg: LegRecord = {
        chain: ev.buyChain,
        side: "buy",
        status: "simulated",
        quotedOut: qBuy,
        minOut: minOut(qBuy, live.slippageBps),
      };
      const sellLeg: LegRecord = {
        chain: ev.sellChain,
        side: "sell",
        status: "simulated",
        quotedOut: qSell,
        minOut: minOut(qSell, live.slippageBps),
      };
      t.legs = [buyLeg, sellLeg];

      const approvals = await sell.approvalsFor(si.token, ev.tokenSold);
      const simBuy = await buy.simulate(buyTx);
      if (!simBuy.ok) return await abort(`buy simulation failed: ${simBuy.error}`);
      if (approvals.length === 0) {
        const simSell = await sell.simulate(sellTx);
        if (!simSell.ok) return await abort(`sell simulation failed: ${simSell.error}`);
      } else {
        t.reasons.push(`${approvals.length} Permit2/ERC-20 approval(s) needed on ${ev.sellChain}`);
      }

      if (!this.armed) {
        t.status = "simulated";
        t.reasons.push("dry run: not broadcast");
        await this.d.record(t);
        return t;
      }

      // --- live: approvals (if any), then both legs at once ---
      for (const a of approvals) {
        const h = await sell.send(a, slug);
        const r = await sell.receipt(h, live.receiptTimeoutSec * 1000);
        if (r.status !== "success") return await abort(`approval reverted on ${ev.sellChain} (${h})`);
      }
      if (approvals.length) {
        const simSell = await sell.simulate(sellTx);
        if (!simSell.ok) return await abort(`sell simulation failed after approval: ${simSell.error}`);
      }
      this.recent.push(this.now());
      const sent = await Promise.allSettled([buy.send(buyTx, slug), sell.send(sellTx, slug)]);
      const legOf = [buyLeg, sellLeg];
      const ops = [buy, sell];
      const infos = [bi, si];
      await Promise.all(
        sent.map(async (s, i) => {
          const leg = legOf[i]!;
          if (s.status === "rejected") {
            leg.status = "error";
            leg.error =
              s.reason instanceof BroadcastBlocked
                ? s.reason.message
                : String((s.reason as Error)?.message ?? s.reason);
            return;
          }
          leg.status = "sent";
          leg.txHash = s.value;
          leg.explorer = explorerUrl(cfg.chains[leg.chain].explorerTx, s.value);
          try {
            const r = await ops[i]!.receipt(s.value, live.receiptTimeoutSec * 1000);
            const info = infos[i]!;
            leg.result = parseSwapReceipt(r, {
              poolManager: cfg.chains[leg.chain].uniswapV4.poolManager as `0x${string}`,
              poolId: info.poolId,
              hook: info.poolKey.hooks,
              side: leg.side,
            });
            leg.status = leg.result.success ? "success" : "reverted";
            leg.gasUsd = (Number(leg.result.gasCostNative) / 1e18) * this.d.quoteUsd(leg.chain);
          } catch (e) {
            leg.status = "timeout";
            leg.error = (e as Error).message;
          }
        }),
      );

      const ok = legOf.filter((l) => l.status === "success").length;
      t.status = ok === 2 ? "success" : ok === 1 ? "partial" : "failed";
      t.realCostsUsd = legOf.reduce((a, l) => a + (l.gasUsd ?? 0), 0);
      const nativeIn = buyLeg.status === "success" ? Number(buyLeg.result!.amountIn) / 1e18 : 0;
      const nativeOut = sellLeg.status === "success" ? Number(sellLeg.result!.amountOut) / 1e18 : 0;
      const tokIn = buyLeg.status === "success" ? Number(buyLeg.result!.amountOut) / 10 ** DEC : 0;
      const tokOut = sellLeg.status === "success" ? Number(sellLeg.result!.amountIn) / 10 ** DEC : 0;
      const ref = this.d.tokenUsd(slug) ?? 0;
      t.realNetUsd = nativeOut * qsUsd - nativeIn * qbUsd + (tokIn - tokOut) * ref - t.realCostsUsd;
      await this.d.record(t);
      await this.addPnl(t.realNetUsd, `trade ${slug}`);

      if (t.status !== "success") {
        this.d.guard.pausedCoins.add(slug);
        await this.d.riskEvent("leg_failed", {
          slug,
          legs: legOf.map((l) => ({
            chain: l.chain,
            side: l.side,
            status: l.status,
            tx: l.txHash,
            error: l.error,
          })),
        });
        await this.d.alert(
          `⚠️ ${t.status.toUpperCase()} trade ${slug} ${ev.buyChain}→${ev.sellChain}: ` +
            legOf
              .map(
                (l) =>
                  `${l.side}@${l.chain} ${l.status}${l.explorer ? ` ${l.explorer}` : l.txHash ? ` ${l.txHash}` : ""}${l.error ? ` (${l.error})` : ""}`,
              )
              .join("; ") +
            `. ${slug} paused; filled side kept as inventory. Resume with: pnpm live:resume ${slug}`,
        );
      }
      return t;
    } catch (e) {
      await this.d.riskEvent("error", { slug, error: (e as Error).message });
      await this.d.alert(`❗ Executor error on ${slug}: ${(e as Error).message}`);
      return abort(`error: ${(e as Error).message}`);
    } finally {
      this.active.delete(slug);
    }
  }
}
