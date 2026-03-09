import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;

export function hasDatabase() {
  return Boolean(databaseUrl);
}

function getSql() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return neon(databaseUrl);
}

export function getDbClient() {
  return getSql();
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

export type MarketScanRun = {
  scan_id: string;
  created_at: string;
  market_count: number;
  deep_priced_count: number;
  positive_buy_arb_count: number;
  positive_sell_arb_count: number;
  positive_buy_arb_fresh_count: number;
  positive_sell_arb_fresh_count: number;
  notes: string | null;
  source_csv: string | null;
  source_summary: string | null;
};

export type MarketScanMetrics = {
  avg_spread: number | null;
  avg_volume24hr: number | null;
  avg_liquidity: number | null;
  avg_base_score: number | null;
  fresh_book_ratio: number | null;
  arb_recommendation_count: number;
  maker_recommendation_count: number;
  momentum_recommendation_count: number;
};

export type OpportunityRow = {
  slug: string | null;
  question: string | null;
  end_date: string | null;
  recommendation: string | null;
  base_score: number | null;
  confidence: number | null;
  spread: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  movement_to_spread: number | null;
  maker_edge_est: number | null;
  taker_reversion_est: number | null;
  buy_both_cost: number | null;
  sell_both_credit: number | null;
  arb_buy_both_edge: number | null;
  arb_sell_both_edge: number | null;
  book_age_ms: number | null;
  book_fresh: boolean | null;
};

export type FundingSummary = {
  net_capital: number;
  confirmed_deposits: number;
  confirmed_allocations: number;
  pending_intents: number;
};

export type FundingEvent = {
  id: number;
  created_at: string;
  event_type: string;
  amount_usd: number;
  source: string | null;
  tx_ref: string | null;
  status: string;
  notes: string | null;
};

export type FundingIntent = {
  id: number;
  created_at: string;
  amount_usd: number;
  note: string | null;
  status: string;
};

export type OpportunityTask = {
  id: number;
  created_at: string;
  scan_id: string | null;
  slug: string | null;
  question: string | null;
  strategy_mode: string;
  edge_score: number | null;
  proposed_amount_usd: number | null;
  status: string;
  rationale: string | null;
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

export async function listRecentScans(limit = 8): Promise<MarketScanRun[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      scan_id,
      created_at,
      market_count,
      deep_priced_count,
      positive_buy_arb_count,
      positive_sell_arb_count,
      positive_buy_arb_fresh_count,
      positive_sell_arb_fresh_count,
      notes,
      source_csv,
      source_summary
    FROM market_scan_runs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as MarketScanRun[];
}

export async function getScanMetrics(scanId: string): Promise<MarketScanMetrics | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      AVG(spread) AS avg_spread,
      AVG(volume24hr) AS avg_volume24hr,
      AVG(liquidity) AS avg_liquidity,
      AVG(base_score) AS avg_base_score,
      AVG(CASE WHEN book_fresh THEN 1.0 ELSE 0.0 END) AS fresh_book_ratio,
      SUM(CASE WHEN recommendation ILIKE 'Cross-outcome arbitrage%' THEN 1 ELSE 0 END)::int AS arb_recommendation_count,
      SUM(CASE WHEN recommendation ILIKE 'Spread capture%' THEN 1 ELSE 0 END)::int AS maker_recommendation_count,
      SUM(CASE WHEN recommendation ILIKE 'Momentum%' THEN 1 ELSE 0 END)::int AS momentum_recommendation_count
    FROM market_scan_rows
    WHERE scan_id = ${scanId}
  `;
  return (rows[0] as MarketScanMetrics) ?? null;
}

export async function getTopOpportunityRows(
  scanId: string,
  mode: "overall" | "arb" | "maker" | "momentum",
  limit = 25
): Promise<OpportunityRow[]> {
  const sql = getSql();
  if (mode === "arb") {
    const rows = await sql`
      SELECT
        slug, question, end_date, recommendation, base_score, confidence, spread, volume24hr, liquidity,
        movement_to_spread, maker_edge_est, taker_reversion_est, buy_both_cost, sell_both_credit,
        arb_buy_both_edge, arb_sell_both_edge, book_age_ms, book_fresh
      FROM market_scan_rows
      WHERE scan_id = ${scanId}
        AND book_fresh = true
        AND GREATEST(COALESCE(arb_buy_both_edge, -99), COALESCE(arb_sell_both_edge, -99)) > 0
      ORDER BY GREATEST(COALESCE(arb_buy_both_edge, -99), COALESCE(arb_sell_both_edge, -99)) DESC, base_score DESC
      LIMIT ${limit}
    `;
    return rows as OpportunityRow[];
  }
  if (mode === "maker") {
    const rows = await sql`
      SELECT
        slug, question, end_date, recommendation, base_score, confidence, spread, volume24hr, liquidity,
        movement_to_spread, maker_edge_est, taker_reversion_est, buy_both_cost, sell_both_credit,
        arb_buy_both_edge, arb_sell_both_edge, book_age_ms, book_fresh
      FROM market_scan_rows
      WHERE scan_id = ${scanId}
        AND volume24hr >= 2000
        AND spread BETWEEN 0.005 AND 0.08
        AND confidence >= 0.15
      ORDER BY maker_edge_est DESC, volume24hr DESC, confidence DESC
      LIMIT ${limit}
    `;
    return rows as OpportunityRow[];
  }
  if (mode === "momentum") {
    const rows = await sql`
      SELECT
        slug, question, end_date, recommendation, base_score, confidence, spread, volume24hr, liquidity,
        movement_to_spread, maker_edge_est, taker_reversion_est, buy_both_cost, sell_both_credit,
        arb_buy_both_edge, arb_sell_both_edge, book_age_ms, book_fresh
      FROM market_scan_rows
      WHERE scan_id = ${scanId}
        AND volume24hr >= 2000
        AND spread <= 0.03
        AND movement_to_spread >= 2
      ORDER BY movement_to_spread DESC, volume24hr DESC, confidence DESC
      LIMIT ${limit}
    `;
    return rows as OpportunityRow[];
  }
  const rows = await sql`
    SELECT
      slug, question, end_date, recommendation, base_score, confidence, spread, volume24hr, liquidity,
      movement_to_spread, maker_edge_est, taker_reversion_est, buy_both_cost, sell_both_credit,
      arb_buy_both_edge, arb_sell_both_edge, book_age_ms, book_fresh
    FROM market_scan_rows
    WHERE scan_id = ${scanId}
      AND volume24hr >= 1000
      AND spread BETWEEN 0.001 AND 0.08
      AND confidence >= 0.1
    ORDER BY base_score DESC, confidence DESC, volume24hr DESC
    LIMIT ${limit}
  `;
  return rows as OpportunityRow[];
}

export async function getFundingSummary(): Promise<FundingSummary> {
  const sql = getSql();
  const [events] = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN status='confirmed' THEN amount_usd ELSE 0 END), 0)::double precision AS net_capital,
      COALESCE(SUM(CASE WHEN status='confirmed' AND event_type='deposit' THEN amount_usd ELSE 0 END), 0)::double precision AS confirmed_deposits,
      COALESCE(SUM(CASE WHEN status='confirmed' AND event_type='allocation' THEN ABS(amount_usd) ELSE 0 END), 0)::double precision AS confirmed_allocations
    FROM funding_events
  `;
  const [intents] = await sql`
    SELECT COUNT(*)::int AS pending_intents
    FROM funding_intents
    WHERE status='pending'
  `;
  return {
    net_capital: Number(events?.net_capital ?? 0),
    confirmed_deposits: Number(events?.confirmed_deposits ?? 0),
    confirmed_allocations: Number(events?.confirmed_allocations ?? 0),
    pending_intents: Number(intents?.pending_intents ?? 0),
  };
}

export async function listFundingEvents(limit = 12): Promise<FundingEvent[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, created_at, event_type, amount_usd, source, tx_ref, status, notes
    FROM funding_events
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as FundingEvent[];
}

export async function listFundingIntents(limit = 12): Promise<FundingIntent[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, created_at, amount_usd, note, status
    FROM funding_intents
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as FundingIntent[];
}

export async function listOpportunityTasks(limit = 20): Promise<OpportunityTask[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, created_at, scan_id, slug, question, strategy_mode, edge_score, proposed_amount_usd, status, rationale
    FROM opportunity_tasks
    ORDER BY
      CASE WHEN status='pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT ${limit}
  `;
  return rows as OpportunityTask[];
}
