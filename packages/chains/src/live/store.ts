// In-memory live state for the coins being watched, plus quote-asset USD prices.
import { EventEmitter } from "node:events";
import { CHAINS, type ChainName } from "@true/core";
import { marketCapUsd, type PangeaPoolsResponse } from "../pangea/pools.js";
import { applyDammUpdate, applyV4Swap, liveStateFromPangea, type LiveState } from "./state.js";

export interface CoinMeta {
  slug: string;
  symbol: string;
  feePips: number;
  tickSpacing: number;
  marketCapUsd: number | null;
}

export type QuoteSymbol = "ETH" | "BNB" | "SOL";
export const QUOTE_OF: Record<ChainName, QuoteSymbol> = { ethereum: "ETH", base: "ETH", robinhood: "ETH", bsc: "BNB", solana: "SOL" };

export interface StoreEvents {
  update: [slug: string, chain: ChainName];
}

export class LiveStore extends EventEmitter<StoreEvents> {
  readonly states = new Map<string, Partial<Record<ChainName, LiveState>>>();
  readonly meta = new Map<string, CoinMeta>();
  readonly quoteUsd: Partial<Record<QuoteSymbol, number>> = {};
  quoteSource = "none";
  quoteUpdatedAt = 0;
  private readonly byPool = new Map<string, string>(); // `${chain}:${poolId}` -> slug

  /** Chains whose state comes from an RPC feed; snapshots never overwrite them once live. */
  constructor(private readonly rpcChains: ReadonlySet<ChainName> = new Set()) {
    super();
  }

  slugOfPool(chain: ChainName, poolId: string): string | undefined {
    return this.byPool.get(`${chain}:${poolId.toLowerCase()}`);
  }

  poolIds(chain: ChainName): string[] {
    const out: string[] = [];
    for (const s of this.states.values()) {
      const st = s[chain];
      if (st) out.push(st.poolId);
    }
    return out;
  }

  /** Seed or refresh from an /api/pools reading for the given fee table. */
  seedFromSnapshot(snap: PangeaPoolsResponse, coins: ReadonlyArray<Omit<CoinMeta, "marketCapUsd">>, now = Date.now()): void {
    const readAt = Date.parse(snap.readAt) || now;
    for (const c of coins) {
      const l = snap.launches.find((x) => x.slug === c.slug);
      if (!l) continue;
      this.meta.set(c.slug, { ...c, marketCapUsd: marketCapUsd(l) });
      const cur = this.states.get(c.slug) ?? {};
      for (const p of l.pools) {
        if (p.error || !CHAINS.includes(p.chain)) continue;
        const prev = cur[p.chain];
        if (prev && prev.source === "rpc" && this.rpcChains.has(p.chain) && prev.updatedAt >= readAt) continue;
        try {
          cur[p.chain] = liveStateFromPangea(p, c.feePips, readAt, c.tickSpacing);
          this.byPool.set(`${p.chain}:${p.poolId!.toLowerCase()}`, c.slug);
          this.emit("update", c.slug, p.chain);
        } catch {
          /* unreadable pool in this snapshot */
        }
      }
      this.states.set(c.slug, cur);
    }
    const usd = snap.rates?.usd;
    if (usd && this.quoteSource !== "chainlink") {
      for (const q of ["ETH", "BNB", "SOL"] as const) if (typeof usd[q] === "number") this.quoteUsd[q] = usd[q];
      this.quoteSource = "pangea-rates";
      this.quoteUpdatedAt = readAt;
    }
  }

  onV4Swap(chain: ChainName, poolId: string, ev: { sqrtPriceX96: bigint; tick: number; liquidity: bigint }, ts = Date.now()): boolean {
    const slug = this.slugOfPool(chain, poolId);
    if (!slug) return false;
    const s = this.states.get(slug)?.[chain];
    if (!s || s.kind !== "v4") return false;
    this.states.get(slug)![chain] = applyV4Swap(s, ev, ts);
    this.emit("update", slug, chain);
    return true;
  }

  onDammUpdate(poolId: string, u: { sqrtPrice: bigint; liquidity: bigint }, ts = Date.now()): boolean {
    const slug = this.slugOfPool("solana", poolId);
    if (!slug) return false;
    const s = this.states.get(slug)?.solana;
    if (!s || s.kind !== "damm") return false;
    this.states.get(slug)!.solana = applyDammUpdate(s, u, ts);
    this.emit("update", slug, "solana");
    return true;
  }

  setQuoteUsd(q: QuoteSymbol, usd: number, source: string, ts = Date.now()): void {
    this.quoteUsd[q] = usd;
    this.quoteSource = source;
    this.quoteUpdatedAt = ts;
  }

  quoteUsdByChain(): Partial<Record<ChainName, number>> {
    const out: Partial<Record<ChainName, number>> = {};
    for (const c of CHAINS) {
      const v = this.quoteUsd[QUOTE_OF[c]];
      if (v) out[c] = v;
    }
    return out;
  }
}
