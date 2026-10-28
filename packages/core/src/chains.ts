/** The five chains every Pangea coin lives on. */
export const CHAINS = ["ethereum", "base", "robinhood", "bsc", "solana"] as const;
export type ChainName = (typeof CHAINS)[number];

export const EVM_CHAINS = ["ethereum", "base", "robinhood", "bsc"] as const;
export type EvmChainName = (typeof EVM_CHAINS)[number];

export type QuoteAsset = "ETH" | "BNB" | "SOL";

export function isEvmChain(c: ChainName): c is EvmChainName {
  return c !== "solana";
}
