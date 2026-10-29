// Phase 0: measure each top coin's trading fee on Robinhood Chain (LP fee 0 + Pangea hook fee).
// Pangea sets the fee once per launch for all chains, so one chain is enough to learn it.
import { mkdirSync, writeFileSync } from "node:fs";
import { createLogger, requireAddress } from "@true/core";
import { evmClient, poolOn, readPoolInit, roundToBps, sampleHookFees } from "@true/chains";
import { cfg, DATA, json, readSnapshot, secrets, snapshotFiles, topLaunches } from "./common.js";

const log = createLogger("fees");
const files = snapshotFiles();
if (!files.length) throw new Error("no snapshots yet; run collect-snapshots first");
const snap = readSnapshot(files.at(-1)!);
const client = evmClient(cfg, secrets, "robinhood");
const pm = requireAddress(cfg.chains.robinhood.uniswapV4.poolManager, "robinhood PoolManager");
const n = Number(process.argv[2] ?? cfg.phase0.topN);

const out: Record<string, unknown> = {};
for (const l of topLaunches(snap, n)) {
  const p = poolOn(l, "robinhood");
  if (!p?.poolId || !p.launchBlock) {
    out[l.slug] = { error: "no robinhood pool" };
    continue;
  }
  const id = p.poolId as `0x${string}`;
  const start = BigInt(p.launchBlock);
  const init = await readPoolInit(client, pm, id, start);
  if (!init) {
    out[l.slug] = { error: "Initialize not found at launch block" };
    continue;
  }
  const samples = [];
  for (let k = 0n; k < 20n && samples.length < 3; k++) {
    const from = start + k * 50_000n;
    await new Promise((r) => setTimeout(r, 300));
    samples.push(...(await sampleHookFees(client, pm, init.hooks, id, from, from + 49_999n, 3 - samples.length)));
  }
  const bps = [...new Set(samples.map((s) => roundToBps(s.pips)))];
  out[l.slug] = {
    symbol: l.symbol,
    lpFee: init.fee,
    tickSpacing: init.tickSpacing,
    hooks: init.hooks,
    feePips: bps.length === 1 ? bps[0] : null,
    consistent: bps.length === 1,
    samples,
  };
  log.info({ slug: l.slug, lpFee: init.fee, tickSpacing: init.tickSpacing, feePips: bps, n: samples.length }, "fee");
}
mkdirSync(DATA, { recursive: true });
writeFileSync(`${DATA}/fees.json`, json({ readAt: new Date().toISOString(), chain: "robinhood", coins: out }));
log.info({ file: `${DATA}/fees.json` }, "done");
