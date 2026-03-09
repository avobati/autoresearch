import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: ".env.local" });
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const sql = neon(databaseUrl);

const snapshotsPath = process.env.SNAPSHOTS_PATH ?? "../data/polymarket_delay/snapshots.jsonl";
const gridPath = process.env.GRID_RESULTS_PATH ?? "../data/polymarket_delay/grid_results.csv";
const notes = process.env.RUN_NOTES ?? "Automated upload from local backtest";
const runId =
  process.env.RUN_ID ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

const snapshotsAbs = path.resolve(process.cwd(), snapshotsPath);
const gridAbs = path.resolve(process.cwd(), gridPath);

if (!fs.existsSync(snapshotsAbs)) {
  console.error(`Snapshots file not found: ${snapshotsAbs}`);
  process.exit(1);
}
if (!fs.existsSync(gridAbs)) {
  console.error(`Grid CSV not found: ${gridAbs}`);
  process.exit(1);
}

const snapshotLines = fs
  .readFileSync(snapshotsAbs, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0);
const snapshots = snapshotLines.map((line) => JSON.parse(line));
if (snapshots.length === 0) {
  console.error("No snapshots found.");
  process.exit(1);
}

const tsValues = snapshots
  .map((x) => x.ts_iso)
  .filter(Boolean)
  .sort();
const tsStart = tsValues[0];
const tsEnd = tsValues[tsValues.length - 1];
const first = snapshots[0];
const marketSlug = first.market_slug ?? null;
const marketQuestion = first.market_question ?? null;
const sampleCount = snapshots.length;
const durationSeconds =
  tsStart && tsEnd ? Math.round(Math.max((Date.parse(tsEnd) - Date.parse(tsStart)) / 1000, 0)) : null;

const num = (arr, key) =>
  arr
    .map((x) => Number(x[key]))
    .filter((v) => Number.isFinite(v));

const avg = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
const p95 = (vals) => {
  if (!vals.length) return null;
  const copy = [...vals].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * (copy.length - 1));
  return copy[idx];
};

const upMidAvg = avg(num(snapshots, "up_mid"));
const downMidAvg = avg(num(snapshots, "down_mid"));
const btcMidAvg = avg(num(snapshots, "btc_mid"));
const bookAgeP95 = p95(num(snapshots, "pm_book_age_abs_ms"));

const csvText = fs.readFileSync(gridAbs, "utf8");
const records = parse(csvText, { columns: true, skip_empty_lines: true });

await sql`DELETE FROM strategy_results WHERE run_id = ${runId}`;
await sql`DELETE FROM snapshots_summary WHERE run_id = ${runId}`;
await sql`DELETE FROM research_runs WHERE run_id = ${runId}`;

await sql`
  INSERT INTO research_runs (
    run_id, market_slug, market_question, sample_count, duration_seconds, notes, source_path
  ) VALUES (
    ${runId}, ${marketSlug}, ${marketQuestion}, ${sampleCount}, ${durationSeconds}, ${notes}, ${snapshotsPath}
  )
`;

await sql`
  INSERT INTO snapshots_summary (
    run_id, ts_start, ts_end, up_mid_avg, down_mid_avg, btc_mid_avg, pm_book_age_abs_ms_p95
  ) VALUES (
    ${runId}, ${tsStart}, ${tsEnd}, ${upMidAvg}, ${downMidAvg}, ${btcMidAvg}, ${bookAgeP95}
  )
`;

for (const row of records) {
  await sql`
    INSERT INTO strategy_results (
      run_id,
      lookback_seconds, hold_seconds, threshold_bps, max_entry_prob,
      train_trades, train_total_pnl, train_win_rate,
      test_trades, test_total_pnl, test_win_rate, test_sharpe_like, test_max_drawdown
    ) VALUES (
      ${runId},
      ${Number(row.lookback_seconds) || 0},
      ${Number(row.hold_seconds) || 0},
      ${Number(row.threshold_bps) || 0},
      ${Number(row.max_entry_prob) || 0},
      ${Number(row.train_trades) || 0},
      ${Number(row.train_total_pnl) || 0},
      ${Number(row.train_win_rate) || 0},
      ${Number(row.test_trades) || 0},
      ${Number(row.test_total_pnl) || 0},
      ${Number(row.test_win_rate) || 0},
      ${Number(row.test_sharpe_like) || 0},
      ${Number(row.test_max_drawdown) || 0}
    )
  `;
}

console.log(`Uploaded run ${runId}: ${sampleCount} snapshots, ${records.length} strategy rows.`);
