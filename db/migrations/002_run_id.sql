-- Each bot start is a separate paper-trading run.
ALTER TABLE sim_trades ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE sim_pnl ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE gap_snapshots ADD COLUMN IF NOT EXISTS sources jsonb;
CREATE INDEX IF NOT EXISTS sim_trades_run_ts ON sim_trades (run_id, ts DESC);
CREATE TABLE IF NOT EXISTS sim_runs (
  run_id      text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  capital_usd double precision NOT NULL,
  config      jsonb NOT NULL
);
