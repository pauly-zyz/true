import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadConfig, loadSecrets } from "@true/core";
import { parsePoolsResponse, quoteLiquidityUsd, type PangeaLaunch, type PangeaPoolsResponse } from "@true/chains";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DATA = `${ROOT}data/phase0`;

if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

export const cfg = loadConfig(`${ROOT}config/default.yaml`);
export const secrets = loadSecrets();

export function snapshotFiles(): string[] {
  const dir = `${DATA}/snapshots`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json.gz"))
    .sort()
    .map((f) => `${dir}/${f}`);
}

export function readSnapshot(file: string): PangeaPoolsResponse {
  return parsePoolsResponse(JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")));
}

/** Top N real (non-test) launches by quote liquidity across chains. */
export function topLaunches(snap: PangeaPoolsResponse, n: number): PangeaLaunch[] {
  return snap.launches
    .filter((l) => !l.test)
    .sort((a, b) => quoteLiquidityUsd(b) - quoteLiquidityUsd(a))
    .slice(0, n);
}

export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
