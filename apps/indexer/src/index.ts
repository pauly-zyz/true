// Phase 1 indexer: follows Swap events of the watched Pangea pools on every chain with an RPC and
// stores them in Postgres. Read-only: no keys, no transactions.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger, loadConfig, loadSecrets, redactUrl } from "@true/core";
import { getDb, insertV4Swap, LiveStore, loadCoinFees, rpcChains, startLive } from "@true/chains";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
const log = createLogger("indexer");
const cfg = loadConfig(`${ROOT}config/default.yaml`);
const secrets = loadSecrets();
const db = getDb(secrets.databaseUrl);
const coins = loadCoinFees(`${ROOT}data/phase0/fees.json`);
log.info({ dryRun: cfg.dryRun, coins: coins.length, db: redactUrl(secrets.databaseUrl!), rpc: [...rpcChains(secrets)] }, "starting indexer");

const store = new LiveStore(rpcChains(secrets) as never);
let n = 0;
const live = await startLive({
  cfg,
  secrets,
  store,
  coins,
  log,
  onSwap: (chain, u, slug) => {
    n++;
    insertV4Swap(db, chain, slug, u).catch((e) => log.error({ err: (e as Error).message }, "insert swap failed"));
    log.info({ chain, slug, block: u.blockNumber.toString(), tick: u.tick }, "swap");
  },
});

const shutdown = async () => {
  log.info({ swaps: n }, "stopping");
  await live.stop();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
