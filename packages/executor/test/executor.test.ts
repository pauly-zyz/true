import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { formatTransactionReceipt, type RpcTransactionReceipt } from "viem";
import { parseConfig, type ArbEvaluation, type ChainName } from "@true/core";
import { LiveExecutor, type ExecutorDeps, type TradeRecord } from "../src/executor.js";
import type { LegOps } from "../src/legOps.js";
import { pangeaPoolKey } from "../src/evm/v4Swap.js";

const raw = parse(readFileSync(new URL("../../../config/default.yaml", import.meta.url), "utf8"));
// both legs reuse the real Robinhood PANGEA receipts, so point Base's PoolManager at Robinhood's
const RH_PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
raw.chains.base.uniswapV4.poolManager = RH_PM;
const POOL_ID = "0xcfe04bc182706f8683f4f486104b52fb6a4115cfe9e4471c468fca65703f9b9d" as const; // poolId
const HOOK = "0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc" as const;
const TOKEN = "0x30de7AE4c9578D110a97367EDe9F7765Cdce06ea" as const;
const receipt = (f: string) =>
  formatTransactionReceipt(
    (
      JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as {
        result: RpcTransactionReceipt;
      }
    ).result,
  );

const ev: ArbEvaluation = {
  buyChain: "robinhood",
  sellChain: "base",
  quoteIn: 4225189901291545n,
  tokenBought: 6690958706615n,
  tokenSold: 13933980185700n,
  quoteOut: 8622688569412733n,
  notionalUsd: 12.68,
  grossUsd: 13.2,
  costs: {
    gasUsd: 0.05,
    bridgeFeeUsd: 0.05,
    lzFeeUsd: 0.26,
    quoteRebalanceUsd: 0.03,
    riskMarginUsd: 0.04,
    tradingFeeUsd: 0.4,
    slippageUsd: 0.01,
    total: 0.43,
  },
  netUsd: 12.7,
  netBps: 10_000,
  partialFill: false,
};

function mockLeg(chain: ChainName, o: Partial<LegOps> = {}): LegOps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    chain,
    address: "0x000000000000000000000000000000000000bEEF",
    canSign: true,
    quote: async (_k, side) => (side === "buy" ? ev.tokenBought : ev.quoteOut),
    simulate: async () => ({ ok: true, gas: 300_000n }),
    approvalsFor: async () => [],
    nativeBalance: async () => 10n ** 18n,
    tokenBalance: async () => 10n ** 15n,
    gasPrice: async () => 20_000_000n,
    send: async (plan) => {
      sent.push(plan);
      return `0x${(sent.length + (chain === "base" ? 10 : 0)).toString(16).padStart(64, "0")}` as `0x${string}`;
    },
    receipt: async () =>
      receipt(chain === "robinhood" ? "receipt-0x5f911c4b.json" : "receipt-0x3f260878.json"),
    ...o,
    sent,
  } as LegOps & { sent: unknown[] };
}

let root: string;
let records: TradeRecord[];
let alerts: string[];
let events: string[];

function setup(env: Record<string, string>, legOverrides: Partial<Record<ChainName, Partial<LegOps>>> = {}) {
  const cfg = parseConfig(raw, env);
  const legs = {
    robinhood: mockLeg("robinhood", legOverrides.robinhood),
    base: mockLeg("base", legOverrides.base),
  };
  const deps: ExecutorDeps = {
    cfg,
    root,
    guard: { breakerTripped: false, pausedCoins: new Set() },
    legs,
    coin: () => ({ token: TOKEN, poolId: POOL_ID, poolKey: pangeaPoolKey(TOKEN, HOOK) }),
    quoteUsd: () => 3000,
    tokenUsd: () => 0.0015,
    record: async (t) => void records.push(structuredClone(t)),
    riskEvent: async (k) => void events.push(k),
    alert: async (m) => void alerts.push(m),
  };
  return { ex: new LiveExecutor(deps), deps, legs, cfg };
}
const ARMED = { DRY_RUN: "false", LIVE_CONFIRM: "yes" };

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/true-exec-`) + "/";
  records = [];
  alerts = [];
  events = [];
});

describe("LiveExecutor", () => {
  it("dry run: quotes and simulates both legs but never sends", async () => {
    const { ex, legs } = setup({});
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.mode).toBe("dry");
    expect(t.status).toBe("simulated");
    expect(t.legs.map((l) => l.status)).toEqual(["simulated", "simulated"]);
    expect(legs.robinhood.sent).toHaveLength(0);
    expect(legs.base.sent).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it("live: sends both legs and books realised PnL from the receipts", async () => {
    const { ex, legs } = setup(ARMED);
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.mode).toBe("live");
    expect(t.status).toBe("success");
    expect(legs.robinhood.sent).toHaveLength(1);
    expect(legs.base.sent).toHaveLength(1);
    expect(t.legs[0]!.result!.amountOut).toBe(6690958706615n);
    expect(t.legs[1]!.result!.amountOut).toBe(8622688569412733n);
    const expected =
      0.008622688569412733 * 3000 -
      0.004225189901291545 * 3000 +
      (6690.958706615 - 13933.9801857) * 0.0015 -
      t.realCostsUsd!;
    expect(t.realNetUsd).toBeCloseTo(expected, 6);
    expect(ex.dailyPnlUsd()).toBeCloseTo(expected, 6);
    expect(alerts).toHaveLength(0);
  });

  it("aborts when a quote differs from the model beyond tolerance", async () => {
    const { ex, legs } = setup(ARMED, { base: { quote: async () => (ev.quoteOut * 98n) / 100n } });
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.status).toBe("aborted");
    expect(t.reasons[0]).toMatch(/sell quote differs/);
    expect(legs.base.sent).toHaveLength(0);
  });

  it("aborts when the simulation reverts", async () => {
    const { ex } = setup(ARMED, {
      robinhood: { simulate: async () => ({ ok: false, error: "V4TooLittleReceived" }) },
    });
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.reasons[0]).toMatch(/buy simulation failed: V4TooLittleReceived/);
  });

  it("a failed leg keeps inventory, pauses the coin and alerts", async () => {
    const reverted = { ...receipt("receipt-0x3f260878.json"), status: "reverted" as const };
    const { ex, deps } = setup(ARMED, { base: { receipt: async () => reverted } });
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.status).toBe("partial");
    expect(deps.guard.pausedCoins.has("pangea-dadd0d")).toBe(true);
    expect(events).toContain("leg_failed");
    expect(alerts[0]).toMatch(/PARTIAL.*paused/);
    const again = await ex.execute("pangea-dadd0d", ev);
    expect(again.reasons[0]).toMatch(/paused/);
  });

  it("circuit breaker: a 3% daily loss stops trading and writes the kill file", async () => {
    const { ex, cfg } = setup(ARMED);
    await ex.addPnl(-0.03 * cfg.live!.capitalUsd - 0.01, "test");
    expect(existsSync(`${root}${cfg.live!.killFile}`)).toBe(true);
    expect(events).toContain("circuit_breaker");
    expect(alerts[0]).toMatch(/Circuit breaker/);
    const t = await ex.execute("pangea-dadd0d", ev);
    expect(t.status).toBe("aborted");
    rmSync(`${root}${cfg.live!.killFile}`);
  });

  it("enforces live limits: chain switch, size, trades per hour, inventory", async () => {
    const { ex } = setup(ARMED);
    expect((await ex.execute("x", { ...ev, sellChain: "solana" })).reasons[0]).toMatch(
      /solana is not enabled/,
    );
    expect((await ex.execute("x", { ...ev, notionalUsd: 500 })).reasons[0]).toMatch(/live max/);
    const low = setup(ARMED, { base: { tokenBalance: async () => 1n } }).ex;
    expect((await low.execute("x", ev)).reasons[0]).toMatch(/inventory/);
    const many = setup(ARMED).ex;
    const now = vi.fn(() => Date.UTC(2026, 10, 2, 12));
    (many as unknown as { d: ExecutorDeps }).d.now = now;
    for (let i = 0; i < 20; i++) await many.execute(`c${i}`, ev);
    expect((await many.execute("c99", ev)).reasons[0]).toMatch(/per hour/);
  });

  it("aborts when live quotes plus real gas leave too little profit", async () => {
    const thin = { ...ev, quoteOut: ev.quoteIn + 10n ** 12n };
    const { ex } = setup(ARMED, { base: { quote: async () => thin.quoteOut } });
    const t = await ex.execute("pangea-dadd0d", thin);
    expect(t.reasons[0]).toMatch(/below minimum/);
  });
});
