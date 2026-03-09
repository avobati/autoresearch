import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;

export function hasDatabase() {
  return Boolean(databaseUrl);
}

export function getSql() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return neon(databaseUrl);
}

export type DashboardRun = {
  run_id: string;
  created_at: string;
  market_slug: string | null;
  market_question: string | null;
  sample_count: number | null;
  duration_seconds: number | null;
  notes: string | null;
  source_path: string | null;
  ts_start: string | null;
  ts_end: string | null;
  up_mid_avg: number | null;
  down_mid_avg: number | null;
  btc_mid_avg: number | null;
  pm_book_age_abs_ms_p95: number | null;
};

export type StrategyRow = {
  lookback_seconds: number;
  hold_seconds: number;
  threshold_bps: number;
  max_entry_prob: number;
  train_trades: number;
  train_total_pnl: number;
  train_win_rate: number;
  test_trades: number;
  test_total_pnl: number;
  test_win_rate: number;
  test_sharpe_like: number;
  test_max_drawdown: number;
};

export async function listRecentRuns(limit = 12): Promise<DashboardRun[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      r.run_id,
      r.created_at,
      r.market_slug,
      r.market_question,
      r.sample_count,
      r.duration_seconds,
      r.notes,
      r.source_path,
      s.ts_start,
      s.ts_end,
      s.up_mid_avg,
      s.down_mid_avg,
      s.btc_mid_avg,
      s.pm_book_age_abs_ms_p95
    FROM research_runs r
    LEFT JOIN snapshots_summary s ON s.run_id = r.run_id
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;
  return rows as DashboardRun[];
}

export async function getStrategies(runId: string, limit = 25): Promise<StrategyRow[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      lookback_seconds,
      hold_seconds,
      threshold_bps,
      max_entry_prob,
      train_trades,
      train_total_pnl,
      train_win_rate,
      test_trades,
      test_total_pnl,
      test_win_rate,
      test_sharpe_like,
      test_max_drawdown
    FROM strategy_results
    WHERE run_id = ${runId}
    ORDER BY test_total_pnl DESC, test_sharpe_like DESC, test_win_rate DESC
    LIMIT ${limit}
  `;
  return rows as StrategyRow[];
}

