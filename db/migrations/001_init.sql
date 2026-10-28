-- TRUE Phase 0/1 schema. Uses TimescaleDB hypertables when the extension is available
-- (docker-compose.yml ships it); falls back to plain Postgres tables otherwise.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb not available; using plain tables';
END $$;

CREATE OR REPLACE FUNCTION true_make_hypertable(tbl regclass, col text) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable(tbl, col, if_not_exists => TRUE);
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS coins (
  slug        text PRIMARY KEY,
  symbol      text NOT NULL,
  name        text,
  market_cap_usd double precision,
  liquidity_usd  double precision,
  raw         jsonb NOT NULL,          -- full /api/pools entry, for auditing
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pools (
  slug          text NOT NULL REFERENCES coins(slug) ON DELETE CASCADE,
  chain         text NOT NULL,
  venue         text NOT NULL,         -- uniswap-v4 | meteora-damm-v2
  token_address text NOT NULL,
  pool_id       text NOT NULL,         -- v4 PoolId (bytes32) or Solana pool account
  fee           integer,               -- v4: pips; DAMM v2: numerator/1e9 base fee if known
  tick_spacing  integer,
  hooks         text,
  extra         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, chain)
);

-- One row per swap event, any chain.
CREATE TABLE IF NOT EXISTS swaps (
  ts            timestamptz NOT NULL,
  chain         text NOT NULL,
  slug          text NOT NULL,
  block         bigint NOT NULL,       -- block number (EVM) or slot (Solana)
  tx_hash       text NOT NULL,
  log_index     integer NOT NULL,      -- EVM log index / Solana inner event index
  sqrt_price    numeric NOT NULL,      -- after the swap: X96 (v4) or Q64.64 (DAMM v2)
  liquidity     numeric,
  tick          integer,
  amount_token  numeric NOT NULL,      -- signed, pool perspective (+ = into the pool)
  amount_quote  numeric NOT NULL,
  fee           integer,               -- v4 event fee (pips)
  price_quote   double precision NOT NULL, -- token price in quote asset
  price_usd     double precision,
  PRIMARY KEY (chain, tx_hash, log_index, ts)
);
SELECT true_make_hypertable('swaps', 'ts');
CREATE INDEX IF NOT EXISTS swaps_slug_ts ON swaps (slug, ts DESC);

CREATE TABLE IF NOT EXISTS quote_prices (
  ts        timestamptz NOT NULL,
  asset     text NOT NULL,             -- ETH | BNB | SOL
  price_usd double precision NOT NULL,
  source    text NOT NULL,             -- chainlink:<chain>:<address>
  round_id  numeric,
  PRIMARY KEY (asset, ts)
);
SELECT true_make_hypertable('quote_prices', 'ts');

-- Live gap engine snapshots (Phase 1).
CREATE TABLE IF NOT EXISTS gap_snapshots (
  ts          timestamptz NOT NULL,
  slug        text NOT NULL,
  spread      double precision,
  true_score  double precision,
  prices_usd  jsonb NOT NULL,
  PRIMARY KEY (slug, ts)
);
SELECT true_make_hypertable('gap_snapshots', 'ts');

-- Simulated (paper) trades. Nothing here ever touched a chain.
CREATE TABLE IF NOT EXISTS sim_trades (
  id            bigserial,
  ts            timestamptz NOT NULL DEFAULT now(),
  slug          text NOT NULL,
  buy_chain     text NOT NULL,
  sell_chain    text NOT NULL,
  quote_in      numeric NOT NULL,
  token_amount  numeric NOT NULL,
  quote_out     numeric NOT NULL,
  notional_usd  double precision NOT NULL,
  gross_usd     double precision NOT NULL,
  net_usd       double precision NOT NULL,
  costs         jsonb NOT NULL,
  executed      boolean NOT NULL,      -- false = rejected by risk checks (kept for analysis)
  reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (id, ts)
);
SELECT true_make_hypertable('sim_trades', 'ts');

CREATE TABLE IF NOT EXISTS sim_pnl (
  ts            timestamptz NOT NULL,
  equity_usd    double precision NOT NULL,
  realized_usd  double precision NOT NULL,
  inventory     jsonb NOT NULL,
  PRIMARY KEY (ts)
);
SELECT true_make_hypertable('sim_pnl', 'ts');

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
