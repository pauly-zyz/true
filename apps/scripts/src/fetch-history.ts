// Phase 0: one /api/history?hours=168 read per top coin (limit: 30 uncached reads / 10 min).
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createLogger } from "@true/core";
import { cfg, DATA, readSnapshot, snapshotFiles, topLaunches } from "./common.js";

const log = createLogger("history");
const n = Math.min(25, Number(process.argv[2] ?? cfg.phase0.topN));
const hours = Number(process.argv[3] ?? 168);
const snap = readSnapshot(snapshotFiles().at(-1)!);
mkdirSync(`${DATA}/history`, { recursive: true });
for (const l of topLaunches(snap, n)) {
  const res = await fetch(`${cfg.pangea.apiBase}/api/history?launch=${encodeURIComponent(l.slug)}&hours=${hours}`);
  if (res.status === 429) {
    log.warn({ slug: l.slug }, "rate limited; stopping");
    break;
  }
  const body = await res.text();
  writeFileSync(`${DATA}/history/${l.slug}-${hours}h.json.gz`, gzipSync(body));
  log.info({ slug: l.slug, status: res.status, bytes: body.length }, "history saved");
  await new Promise((r) => setTimeout(r, 2500)); // be gentle
}
