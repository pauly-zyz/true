import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, loadSecrets } from "@true/core";
import { closeDb, getDb } from "@true/chains";

const log = createLogger("migrate");

async function main() {
  const db = getDb(loadSecrets().databaseUrl);
  const dir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    log.info({ migration: f }, "applying");
    await db.query("BEGIN");
    try {
      await db.query(readFileSync(join(dir, f), "utf8"));
      await db.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
  log.info("migrations up to date");
  await closeDb();
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, "migration failed");
  process.exit(1);
});
