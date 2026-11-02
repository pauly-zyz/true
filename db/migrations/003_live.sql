-- Phase 2: live (or dry-run) execution records. Every attempted trade is recorded, including aborts.
CREATE TABLE IF NOT EXISTS live_trades (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  run_id        text NOT NULL,
  mode          text NOT NULL,              -- dry | live
  slug          text NOT NULL,
  buy_chain     text NOT NULL,
  sell_chain    text NOT NULL,
  status        text NOT NULL,              -- aborted | simulated | sent | success | partial | failed
  reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  model         jsonb NOT NULL,             -- model evaluation (amounts, costs, expected net)
  simulation    jsonb,                      -- eth_call / quoter results per leg
  real          jsonb,                      -- realised amounts and costs per leg
  expected_net_usd double precision,
  real_net_usd     double precision,        -- realised PnL of the trade (excludes later rebalance costs)
  real_costs_usd   double precision
);
CREATE INDEX IF NOT EXISTS live_trades_run_ts ON live_trades (run_id, ts DESC);

CREATE TABLE IF NOT EXISTS live_legs (
  id              bigserial PRIMARY KEY,
  trade_id        bigint NOT NULL REFERENCES live_trades(id),
  chain           text NOT NULL,
  side            text NOT NULL,            -- buy | sell
  tx_hash         text,
  explorer_url    text,
  status          text NOT NULL,            -- simulated | sent | success | reverted | timeout | error
  block           bigint,
  gas_used        numeric,
  effective_gas_price numeric,
  gas_usd         double precision,
  amount_in       numeric,
  amount_out      numeric,
  hook_fee        numeric,
  error           text
);

CREATE TABLE IF NOT EXISTS live_bridges (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  run_id        text NOT NULL,
  mode          text NOT NULL,
  slug          text NOT NULL,
  from_chain    text NOT NULL,
  to_chain      text NOT NULL,
  amount_sent   numeric NOT NULL,
  amount_received numeric,
  lz_fee_native numeric,
  lz_fee_usd    double precision,
  gas_usd       double precision,
  tx_hash       text,
  guid          text,
  explorer_url  text,
  status        text NOT NULL,              -- simulated | sent | delivered | failed
  error         text
);

CREATE TABLE IF NOT EXISTS live_balances (
  ts      timestamptz NOT NULL DEFAULT now(),
  run_id  text NOT NULL,
  chain   text NOT NULL,
  asset   text NOT NULL,                    -- native symbol or coin slug
  amount  numeric NOT NULL,
  usd     double precision,
  PRIMARY KEY (run_id, chain, asset, ts)
);

CREATE TABLE IF NOT EXISTS risk_events (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  run_id  text,
  kind    text NOT NULL,                    -- circuit_breaker | kill | leg_failed | low_balance | error | resume
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb
);
