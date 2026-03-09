import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: ".env.local" });
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = neon(databaseUrl);

await sql`
CREATE TABLE IF NOT EXISTS research_runs (
  run_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_slug TEXT,
  market_question TEXT,
  sample_count INTEGER,
  duration_seconds INTEGER,
  notes TEXT,
  source_path TEXT
);
`;

await sql`
CREATE TABLE IF NOT EXISTS snapshots_summary (
  run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id) ON DELETE CASCADE,
  ts_start TIMESTAMPTZ,
  ts_end TIMESTAMPTZ,
  up_mid_avg DOUBLE PRECISION,
  down_mid_avg DOUBLE PRECISION,
  btc_mid_avg DOUBLE PRECISION,
  pm_book_age_abs_ms_p95 DOUBLE PRECISION
);
`;

await sql`
CREATE TABLE IF NOT EXISTS strategy_results (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(run_id) ON DELETE CASCADE,
  lookback_seconds INTEGER NOT NULL,
  hold_seconds INTEGER NOT NULL,
  threshold_bps DOUBLE PRECISION NOT NULL,
  max_entry_prob DOUBLE PRECISION NOT NULL,
  train_trades INTEGER NOT NULL,
  train_total_pnl DOUBLE PRECISION NOT NULL,
  train_win_rate DOUBLE PRECISION NOT NULL,
  test_trades INTEGER NOT NULL,
  test_total_pnl DOUBLE PRECISION NOT NULL,
  test_win_rate DOUBLE PRECISION NOT NULL,
  test_sharpe_like DOUBLE PRECISION NOT NULL,
  test_max_drawdown DOUBLE PRECISION NOT NULL
);
`;

await sql`
CREATE TABLE IF NOT EXISTS market_scan_runs (
  scan_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_count INTEGER NOT NULL,
  deep_priced_count INTEGER NOT NULL,
  positive_buy_arb_count INTEGER NOT NULL DEFAULT 0,
  positive_sell_arb_count INTEGER NOT NULL DEFAULT 0,
  positive_buy_arb_fresh_count INTEGER NOT NULL DEFAULT 0,
  positive_sell_arb_fresh_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  source_csv TEXT,
  source_summary TEXT
);
`;

await sql`
ALTER TABLE market_scan_runs
ADD COLUMN IF NOT EXISTS positive_buy_arb_fresh_count INTEGER NOT NULL DEFAULT 0;
`;

await sql`
ALTER TABLE market_scan_runs
ADD COLUMN IF NOT EXISTS positive_sell_arb_fresh_count INTEGER NOT NULL DEFAULT 0;
`;

await sql`
CREATE TABLE IF NOT EXISTS market_scan_rows (
  id BIGSERIAL PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES market_scan_runs(scan_id) ON DELETE CASCADE,
  market_id TEXT,
  slug TEXT,
  question TEXT,
  end_date TEXT,
  outcome_1 TEXT,
  outcome_2 TEXT,
  token_1 TEXT,
  token_2 TEXT,
  mid_1 DOUBLE PRECISION,
  mid_2 DOUBLE PRECISION,
  mid_sum DOUBLE PRECISION,
  complement_gap DOUBLE PRECISION,
  spread DOUBLE PRECISION,
  volume24hr DOUBLE PRECISION,
  liquidity DOUBLE PRECISION,
  one_hour_change DOUBLE PRECISION,
  one_day_change DOUBLE PRECISION,
  movement_to_spread DOUBLE PRECISION,
  maker_edge_est DOUBLE PRECISION,
  taker_reversion_est DOUBLE PRECISION,
  confidence DOUBLE PRECISION,
  base_score DOUBLE PRECISION,
  recommendation TEXT,
  buy_both_cost DOUBLE PRECISION,
  sell_both_credit DOUBLE PRECISION,
  arb_buy_both_edge DOUBLE PRECISION,
  arb_sell_both_edge DOUBLE PRECISION,
  book_age_ms DOUBLE PRECISION,
  book_fresh BOOLEAN
);
`;

await sql`
CREATE INDEX IF NOT EXISTS idx_market_scan_rows_scan_id ON market_scan_rows(scan_id);
`;

await sql`
CREATE TABLE IF NOT EXISTS funding_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  amount_usd DOUBLE PRECISION NOT NULL,
  source TEXT,
  tx_ref TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT
);
`;

await sql`
CREATE INDEX IF NOT EXISTS idx_funding_events_created_at ON funding_events(created_at DESC);
`;

await sql`
CREATE TABLE IF NOT EXISTS funding_intents (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount_usd DOUBLE PRECISION NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
`;

await sql`
CREATE INDEX IF NOT EXISTS idx_funding_intents_created_at ON funding_intents(created_at DESC);
`;

await sql`
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount_usd DOUBLE PRECISION NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDC',
  destination_address TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  processed_tx_ref TEXT
);
`;

await sql`
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status_created ON withdrawal_requests(status, created_at DESC);
`;

await sql`
CREATE TABLE IF NOT EXISTS opportunity_tasks (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_id TEXT REFERENCES market_scan_runs(scan_id) ON DELETE SET NULL,
  slug TEXT,
  question TEXT,
  strategy_mode TEXT NOT NULL,
  edge_score DOUBLE PRECISION,
  proposed_amount_usd DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'pending',
  rationale TEXT
);
`;

await sql`
CREATE INDEX IF NOT EXISTS idx_opportunity_tasks_status_created ON opportunity_tasks(status, created_at DESC);
`;

console.log("Neon schema initialized.");
