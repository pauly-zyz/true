// PoolKey (token, hook, fee, tickSpacing) and poolId per coin per live chain, read from each pool's
// Initialize event at its launch block and cached in data/live/poolkeys.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PublicClient } from "viem";
import type { ChainName, Config } from "@true/core";
import { readPoolInit, type PangeaPoolsResponse } from "@true/chains";
import { pangeaPoolKey, type CoinChainInfo } from "@true/executor";

type Cache = Record<
  string,
  Partial<
    Record<ChainName, { token: string; poolId: string; hooks: string; fee: number; tickSpacing: number }>
  >
>;

export async function loadPoolKeys(
  cfg: Config,
  root: string,
  clients: Partial<Record<ChainName, PublicClient>>,
  snap: PangeaPoolsResponse,
  slugs: string[],
): Promise<(slug: string, chain: ChainName) => CoinChainInfo | undefined> {
  const file = `${root}data/live/poolkeys.json`;
  const cache: Cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const slug of slugs) {
    const l = snap.launches.find((x) => x.slug === slug);
    if (!l) continue;
    for (const [chain, client] of Object.entries(clients) as Array<[ChainName, PublicClient]>) {
      if (cache[slug]?.[chain]) continue;
      const p = l.pools.find((x) => x.chain === chain);
      if (!p?.poolId || !p.token || !p.launchBlock) continue;
      const init = await readPoolInit(
        client,
        cfg.chains[chain].uniswapV4.poolManager as `0x${string}`,
        p.poolId as `0x${string}`,
        BigInt(p.launchBlock),
      );
      if (!init) continue;
      if (init.currency1.toLowerCase() !== p.token.toLowerCase())
        throw new Error(`${slug}@${chain}: Initialize currency1 is not the token from /api/pools`);
      cache[slug] = {
        ...cache[slug],
        [chain]: {
          token: p.token,
          poolId: p.poolId,
          hooks: init.hooks,
          fee: init.fee,
          tickSpacing: init.tickSpacing,
        },
      };
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  mkdirSync(`${root}data/live`, { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 1));
  return (slug, chain) => {
    const c = cache[slug]?.[chain];
    if (!c) return undefined;
    return {
      token: c.token as `0x${string}`,
      poolId: c.poolId as `0x${string}`,
      poolKey: pangeaPoolKey(c.token as `0x${string}`, c.hooks as `0x${string}`, c.fee, c.tickSpacing),
    };
  };
}
