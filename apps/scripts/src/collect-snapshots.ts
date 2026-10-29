// Phase 0: save one /api/pools reading every `intervalSec` (default 300 s = config poolsRefreshSec).
// Raw JSON only; analysis happens offline. Usage: tsx src/collect-snapshots.ts [count]
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createLogger, loadConfig } from "@true/core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const log = createLogger("collect");
const cfg = loadConfig(`${root}config/default.yaml`);
const count = Number(process.argv[2] ?? 36);
const intervalSec = Math.max(60, cfg.pangea.poolsRefreshSec);
const dir = `${root}data/phase0/snapshots`;
mkdirSync(dir, { recursive: true });

for (let i = 0; i < count; i++) {
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.pangea.apiBase}/api/pools`, { headers: { accept: "application/json" } });
    const body = await res.text();
    if (!res.ok) throw new Error(`status ${res.status}`);
    const file = `${dir}/${new Date(started).toISOString().replace(/[:.]/g, "-")}.json.gz`;
    writeFileSync(file, gzipSync(body));
    log.info({ i: i + 1, count, bytes: body.length }, "snapshot saved");
  } catch (e) {
    log.warn({ err: (e as Error).message }, "snapshot failed");
  }
  if (i + 1 < count) await new Promise((r) => setTimeout(r, Math.max(0, intervalSec * 1000 - (Date.now() - started))));
}
