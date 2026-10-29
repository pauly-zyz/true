// Client for GET https://www.pangea.trade/api/pools (metadata + a shared on-chain reading).
// Pangea asks not to crawl: calls are throttled to at most one per `minIntervalSec`.
import { z } from "zod";
import { CHAINS, type ChainName } from "@true/core";

const num = z.number().nullable().optional();

export const pangeaPoolSchema = z
  .object({
    chain: z.enum(CHAINS),
    token: z.string().nullable().optional(),
    poolId: z.string().nullable().optional(),
    venue: z.string().nullable().optional(), // "uniswap-v4" | "meteora"
    price: num, // quote per token
    priceUsd: num,
    reserves: num, // quote asset (human units)
    tokenReserves: num, // tokens (human units)
    reservesUsd: num,
    tokenReservesUsd: num,
    liquidity: z.string().nullable().optional(),
    sqrtPriceX96: z.string().nullable().optional(), // X96 on v4; Q64.64 sqrt price on Meteora
    tick: z.number().nullable().optional(),
    inRange: z.boolean().nullable().optional(),
    quoteSymbol: z.string().nullable().optional(),
    quoteDecimals: z.number().nullable().optional(),
    localSupply: num,
    launchBlock: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
export type PangeaPool = z.infer<typeof pangeaPoolSchema>;

export const pangeaLaunchSchema = z
  .object({
    slug: z.string(),
    name: z.string().nullable().optional(),
    symbol: z.string(),
    test: z.boolean().optional(),
    pools: z.array(pangeaPoolSchema),
    capSupply: num,
    launchTotal: num,
    spreadUsd: num,
    listedAt: num,
    cheapest: z.object({ chain: z.string(), usd: z.number() }).nullable().optional(),
  })
  .passthrough();
export type PangeaLaunch = z.infer<typeof pangeaLaunchSchema>;

export const pangeaPoolsResponseSchema = z
  .object({
    live: z.boolean(),
    readAt: z.string(),
    rates: z.object({ usd: z.record(z.string(), z.number()) }).passthrough().nullable().optional(),
    launches: z.array(pangeaLaunchSchema),
  })
  .passthrough();
export type PangeaPoolsResponse = z.infer<typeof pangeaPoolsResponseSchema>;

export function parsePoolsResponse(json: unknown): PangeaPoolsResponse {
  return pangeaPoolsResponseSchema.parse(json);
}

/** Market cap as Pangea defines it: average USD price x capSupply (whole supply across chains). */
export function marketCapUsd(l: PangeaLaunch): number | null {
  const prices = l.pools.map((p) => p.priceUsd).filter((x): x is number => typeof x === "number" && x > 0);
  if (!prices.length || !l.capSupply) return null;
  return (prices.reduce((a, b) => a + b, 0) / prices.length) * l.capSupply;
}

/** Quote-asset liquidity across all chains, in USD (what sellers can actually be paid). */
export function quoteLiquidityUsd(l: PangeaLaunch): number {
  return l.pools.reduce((s, p) => s + (p.reservesUsd ?? 0), 0);
}

export function poolOn(l: PangeaLaunch, chain: ChainName): PangeaPool | undefined {
  return l.pools.find((p) => p.chain === chain && !p.error);
}

export class PangeaPoolsClient {
  private last: { at: number; data: PangeaPoolsResponse } | null = null;
  constructor(
    private readonly apiBase: string,
    private readonly minIntervalSec = 60,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Returns the cached reading if it is younger than `minIntervalSec`; never calls more often. */
  async get(): Promise<PangeaPoolsResponse> {
    const now = Date.now();
    if (this.last && now - this.last.at < this.minIntervalSec * 1000) return this.last.data;
    const res = await this.fetchImpl(`${this.apiBase}/api/pools`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET /api/pools -> ${res.status}`);
    const data = parsePoolsResponse(await res.json());
    this.last = { at: now, data };
    return data;
  }
}
