// Plans token rebalances between chains (inventory mode). Quote assets (ETH/BNB) are NOT moved
// automatically: the bot only raises a low-balance alert and a person moves them (decision for Phase 2).
import type { ChainName } from "@true/core";

export interface TokenMove {
  slug: string;
  from: ChainName;
  to: ChainName;
  amount: bigint; // raw token units, already truncated to bridge precision
}

export interface RebalanceInput {
  slug: string;
  /** Raw token balance per live-enabled chain. */
  balances: Partial<Record<ChainName, bigint>>;
  /** Target raw balance per chain. */
  target: bigint;
  /** Rebalance a chain when it is below this fraction of target. */
  below: number;
  /** Token price in USD, to compare the move's value with its LayerZero fee. */
  tokenUsd: number;
  lzFeeUsd: (from: ChainName, to: ChainName) => number;
  /** Skip a move whose LayerZero fee is above this share of the value moved. */
  maxFeeShare?: number;
}

const UNIT = 1000n; // 9 -> 6 decimals

export function planTokenRebalance(i: RebalanceInput): TokenMove[] {
  const moves: TokenMove[] = [];
  const bal = { ...i.balances };
  const threshold = (i.target * BigInt(Math.round(i.below * 1e6))) / 1_000_000n;
  const chains = Object.keys(bal) as ChainName[];
  for (const to of chains) {
    if ((bal[to] ?? 0n) >= threshold) continue;
    const from = chains.filter((c) => c !== to).sort((a, b) => ((bal[b] ?? 0n) > (bal[a] ?? 0n) ? 1 : -1))[0];
    if (!from) continue;
    const surplus = (bal[from] ?? 0n) - i.target;
    const need = i.target - (bal[to] ?? 0n);
    let amount = surplus < need ? surplus : need;
    amount = (amount / UNIT) * UNIT;
    if (amount <= 0n) continue;
    const valueUsd = (Number(amount) / 1e9) * i.tokenUsd;
    if (i.lzFeeUsd(from, to) > (i.maxFeeShare ?? 0.02) * valueUsd) continue;
    moves.push({ slug: i.slug, from, to, amount });
    bal[from] = (bal[from] ?? 0n) - amount;
    bal[to] = (bal[to] ?? 0n) + amount;
  }
  return moves;
}

export interface LowBalance {
  chain: ChainName;
  asset: string;
  usd: number;
  thresholdUsd: number;
}

export function lowBalances(
  balancesUsd: Array<{ chain: ChainName; asset: string; usd: number; kind: "gas" | "quote" | "token" }>,
  thresholds: { gas: number; quote: number; token: number },
): LowBalance[] {
  return balancesUsd
    .filter((b) => b.usd < thresholds[b.kind])
    .map((b) => ({ chain: b.chain, asset: b.asset, usd: b.usd, thresholdUsd: thresholds[b.kind] }));
}
