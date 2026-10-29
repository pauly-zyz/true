import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CHAINS, type ChainName } from "./chains.js";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte address");

/**
 * Addresses that have not been verified against official sources are `null`.
 * Code that needs them must refuse to run rather than guess.
 */
const nullableAddress = hexAddress.nullable().default(null);

const chainSchema = z.object({
  enabled: z.boolean().default(true),
  kind: z.enum(["evm", "solana"]),
  /** EVM chain id; null = not yet verified. */
  chainId: z.number().int().positive().nullable().default(null),
  quoteAsset: z.enum(["ETH", "BNB", "SOL"]),
  quoteDecimals: z.number().int().min(0).max(36),
  lzEid: z.number().int().positive(),
  venue: z.enum(["uniswap-v4", "meteora-damm-v2"]),
  /** Gas units of one swap, used for cost estimation. Solana: compute units. */
  swapGasUnits: z.number().int().positive(),
  /** Fallback gas price when no live value is available (gwei for EVM, micro-lamports/CU priority for Solana). */
  fallbackGasPrice: z.number().nonnegative(),
  /** Solana only: base fee per signature in lamports. */
  baseFeeLamports: z.number().int().nonnegative().default(5000),
  /** Max block range per eth_getLogs request during backfill. */
  logChunkBlocks: z.number().int().positive().default(5000),
  /** Approx block time, used to convert "days" to a block range for backfill. */
  blockTimeSec: z.number().positive(),
  uniswapV4: z
    .object({
      poolManager: nullableAddress,
      stateView: nullableAddress,
    })
    .default({ poolManager: null, stateView: null }),
});
export type ChainConfig = z.infer<typeof chainSchema>;

const oracleFeedSchema = z.object({
  /** Chain where the Chainlink aggregator proxy is read. */
  chain: z.enum(CHAINS),
  address: nullableAddress,
  /** Expected `description()` of the feed, checked on startup, e.g. "ETH / USD". */
  description: z.string(),
  maxStalenessSec: z.number().int().positive().default(3600),
});

export const configSchema = z.object({
  dryRun: z.literal(true, { message: "DRY_RUN must be true in Phase 0/1" }),
  pangea: z.object({
    apiBase: z.string().url(),
    /** How often the coin list is refreshed. Pangea asks not to crawl; 60 s cache server side. */
    poolsRefreshSec: z.number().int().min(60).default(300),
  }),
  chains: z.object(Object.fromEntries(CHAINS.map((c) => [c, chainSchema])) as Record<ChainName, typeof chainSchema>),
  token: z.object({
    /** Pangea token decimals (all chains). */
    decimals: z.number().int().default(9),
    /** OFT bridge shared decimals: amounts are truncated to this precision. */
    bridgeDecimals: z.number().int().default(6),
  }),
  oracle: z.object({
    source: z.literal("chainlink"),
    feeds: z.object({ ETH: oracleFeedSchema, BNB: oracleFeedSchema, SOL: oracleFeedSchema }),
  }),
  costs: z.object({
    /** Bridge fee in basis points of bridged amount (0.2% = 20 bps). */
    bridgeFeeBps: z.number().nonnegative(),
    /** LayerZero message fee in USD: by destination chain, with a separate figure out of Solana. */
    lzMessageFeeUsd: z.object({
      byDestination: z.record(z.enum(CHAINS), z.number().nonnegative()),
      fromSolana: z.number().nonnegative(),
    }),
    /**
     * Inventory mode bridges tokens back in batched rebalances. The LZ fee of one rebalance is
     * spread over this many trades. 1 = charge a full LZ fee to every trade (most conservative).
     */
    lzAmortizeOverTrades: z.number().int().positive().default(1),
    /** Cost of moving quote asset (ETH/BNB/SOL) back to the cheap chain during rebalance, in bps. */
    quoteRebalanceBps: z.number().nonnegative().default(10),
    /** Extra safety margin applied to every opportunity, in bps of trade notional. */
    riskMarginBps: z.number().nonnegative(),
  }),
  risk: z.object({
    minNetProfitUsd: z.number().nonnegative(),
    minNetProfitBps: z.number().nonnegative(),
    maxTradeFractionOfSmallerPool: z.number().positive().max(1),
    maxExposurePerCoinFraction: z.number().positive().max(1),
    minMarketCapUsd: z.number().nonnegative(),
    dailyLossLimitFraction: z.number().positive().max(1),
    excludedCoins: z.array(z.string()).default([]),
  }),
  trueScore: z.object({
    /** TrueScore = max(0, 100 - spreadPct * multiplier). */
    multiplier: z.number().positive().default(20),
  }),
  simulator: z.object({
    startingCapitalUsd: z.number().positive(),
    /** Fraction of capital held as quote asset on each chain at start; the rest is spread as coin inventory. */
    quoteFraction: z.number().min(0).max(1),
    /** Chains the simulator is allowed to trade on (priority order). */
    chains: z.array(z.enum(CHAINS)).min(2),
    /** Bridge mode is disabled by default in Phase 1 (inventory mode only). */
    allowBridgeMode: z.boolean().default(false),
  }),
  phase0: z.object({
    topN: z.number().int().positive(),
    days: z.number().positive(),
    capitalTiersUsd: z.array(z.number().positive()).min(1),
    /** Share of profitable episodes TRUE is assumed to win against competing bots. */
    captureRates: z.array(z.number().min(0).max(1)).min(1),
  }),
});
export type Config = z.infer<typeof configSchema>;

/** Secrets live only in env and are never part of `Config` (so config dumps are safe to log). */
export interface Secrets {
  databaseUrl: string | undefined;
  rpcHttp: Partial<Record<ChainName, string>>;
  rpcWs: Partial<Record<ChainName, string>>;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const rpcHttp: Partial<Record<ChainName, string>> = {};
  const rpcWs: Partial<Record<ChainName, string>> = {};
  for (const c of CHAINS) {
    const h = env[`RPC_HTTP_${c.toUpperCase()}`];
    const w = env[`RPC_WS_${c.toUpperCase()}`];
    if (h) rpcHttp[c] = h;
    if (w) rpcWs[c] = w;
  }
  return { databaseUrl: env.DATABASE_URL || undefined, rpcHttp, rpcWs };
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * Parse a raw config object, applying env overrides. DRY_RUN defaults to true; any
 * other value makes validation fail, so the system cannot start in a live mode.
 */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const obj = (raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;
  const envDry = parseBoolEnv(env.DRY_RUN);
  obj.dryRun = envDry ?? (obj.dryRun as boolean | undefined) ?? true;
  return configSchema.parse(obj);
}

export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = resolve(path ?? env.TRUE_CONFIG ?? "config/default.yaml");
  const raw = parseYaml(readFileSync(file, "utf8"));
  return parseConfig(raw, env);
}

/** Throws if a required, verified address is missing. Never fall back to a guess. */
export function requireAddress(value: string | null, what: string): `0x${string}` {
  if (!value) {
    throw new Error(`${what} is not configured. Fill it in config after verifying against official docs.`);
  }
  return value as `0x${string}`;
}
