import { createPublicClient, defineChain, http, webSocket, type PublicClient } from "viem";
import type { Config, EvmChainName, Secrets } from "@true/core";

/** Read-only viem client. There is deliberately no wallet client anywhere in Phase 0/1. */
export function evmClient(cfg: Config, secrets: Secrets, chain: EvmChainName, transport: "http" | "ws" = "http"): PublicClient {
  const c = cfg.chains[chain];
  if (!c.chainId) throw new Error(`${chain}: chainId not configured`);
  const url = transport === "http" ? secrets.rpcHttp[chain] : secrets.rpcWs[chain];
  if (!url) throw new Error(`${chain}: RPC_${transport === "http" ? "HTTP" : "WS"}_${chain.toUpperCase()} is not set`);
  const def = defineChain({
    id: c.chainId,
    name: chain,
    nativeCurrency: { name: c.quoteAsset, symbol: c.quoteAsset, decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createPublicClient({
    chain: def,
    transport: transport === "http" ? http(url, { retryCount: 6, retryDelay: 1500, batch: false }) : webSocket(url, { retryCount: 10 }),
  }) as PublicClient;
}
