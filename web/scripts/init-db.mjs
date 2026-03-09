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

console.log("Neon schema initialized.");
