import pg from "pg";
import { redactUrl } from "@true/core";

let pool: pg.Pool | null = null;

export function getDb(databaseUrl: string | undefined): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    pool.on("error", (err) => {
      // never print the connection string itself
      console.error(`postgres pool error (${redactUrl(databaseUrl)}): ${err.message}`);
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
