// Chainlink AggregatorV3 reader for ETH/BNB/SOL in USD. Feeds are used only when their address is
// configured (after verification) and the feed's chain has an RPC; the description and staleness
// are checked on every read.
import { isEvmChain, type Config, type Secrets } from "@true/core";
import { chainlinkAggregatorAbi } from "../evm/abi.js";
import { evmClient } from "../evm/clients.js";

export interface OraclePrice {
  asset: "ETH" | "BNB" | "SOL";
  usd: number;
  updatedAt: number; // ms
  source: string;
}

export async function readChainlink(cfg: Config, secrets: Secrets, now = Date.now()): Promise<OraclePrice[]> {
  const out: OraclePrice[] = [];
  for (const asset of ["ETH", "BNB", "SOL"] as const) {
    const f = cfg.oracle.feeds[asset];
    if (!f.address || !isEvmChain(f.chain) || !secrets.rpcHttp[f.chain]) continue;
    const client = evmClient(cfg, secrets, f.chain);
    const address = f.address as `0x${string}`;
    const [desc, decimals, round] = await Promise.all([
      client.readContract({ address, abi: chainlinkAggregatorAbi, functionName: "description" }),
      client.readContract({ address, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
      client.readContract({ address, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
    ]);
    if (desc !== f.description) throw new Error(`${asset} feed description is "${desc}", expected "${f.description}"`);
    const updatedAt = Number(round[3]) * 1000;
    if (now - updatedAt > f.maxStalenessSec * 1000) throw new Error(`${asset} feed is stale`);
    out.push({ asset, usd: Number(round[1]) / 10 ** decimals, updatedAt, source: `chainlink:${f.chain}` });
  }
  return out;
}
