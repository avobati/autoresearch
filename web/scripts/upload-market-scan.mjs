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

const scanDir = process.env.MARKET_SCAN_DIR ?? "../data/polymarket_scan";
const notes = process.env.SCAN_NOTES ?? "Automated upload from all-market scan";
const scanDirAbs = path.resolve(process.cwd(), scanDir);

if (!fs.existsSync(scanDirAbs)) {
  console.error(`Scan directory not found: ${scanDirAbs}`);
  process.exit(1);
}

function findLatestScanFiles(directory) {
  const all = fs.readdirSync(directory);
  const csvFiles = all
    .filter((x) => /^market_scan_\d{8}_\d{6}\.csv$/.test(x))
    .map((name) => ({
      name,
      abs: path.join(directory, name),
      mtime: fs.statSync(path.join(directory, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!csvFiles.length) {
    throw new Error(`No market_scan_*.csv files found in ${directory}`);
  }
  const latest = csvFiles[0];
  const stem = latest.name.replace(/\.csv$/, "");
  const summaryName = `${stem}_summary.json`;
  const summaryAbs = path.join(directory, summaryName);
  return {
    csv: latest.abs,
    summary: fs.existsSync(summaryAbs) ? summaryAbs : null,
    stem,
  };
}

const files = findLatestScanFiles(scanDirAbs);
const csvPath = process.env.MARKET_SCAN_CSV_PATH
  ? path.resolve(process.cwd(), process.env.MARKET_SCAN_CSV_PATH)
  : files.csv;
const summaryPath = process.env.MARKET_SCAN_SUMMARY_PATH
  ? path.resolve(process.cwd(), process.env.MARKET_SCAN_SUMMARY_PATH)
  : files.summary;
const scanId = process.env.SCAN_ID ?? files.stem.replace("market_scan_", "scan_");

if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const csvText = fs.readFileSync(csvPath, "utf8");
const rows = parse(csvText, { columns: true, skip_empty_lines: true });
if (!rows.length) {
  console.error("CSV has no rows.");
  process.exit(1);
}

let summary = {};
if (summaryPath && fs.existsSync(summaryPath)) {
  summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
}

const toNum = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
};

const deepPricedCount = rows.filter((r) => toNum(r.buy_both_cost) !== null).length;
const positiveBuy = rows.filter((r) => (toNum(r.arb_buy_both_edge) ?? -999) > 0).length;
const positiveSell = rows.filter((r) => (toNum(r.arb_sell_both_edge) ?? -999) > 0).length;
const positiveBuyFresh = rows.filter(
  (r) => (toNum(r.arb_buy_both_edge) ?? -999) > 0 && toBool(r.book_fresh) === true
).length;
const positiveSellFresh = rows.filter(
  (r) => (toNum(r.arb_sell_both_edge) ?? -999) > 0 && toBool(r.book_fresh) === true
).length;

await sql`DELETE FROM market_scan_rows WHERE scan_id = ${scanId}`;
await sql`DELETE FROM market_scan_runs WHERE scan_id = ${scanId}`;

await sql`
  INSERT INTO market_scan_runs (
    scan_id, market_count, deep_priced_count, positive_buy_arb_count, positive_sell_arb_count,
    positive_buy_arb_fresh_count, positive_sell_arb_fresh_count, notes, source_csv, source_summary
  ) VALUES (
    ${scanId},
    ${rows.length},
    ${deepPricedCount},
    ${positiveBuy},
    ${positiveSell},
    ${positiveBuyFresh},
    ${positiveSellFresh},
    ${notes},
    ${path.relative(process.cwd(), csvPath)},
    ${summaryPath ? path.relative(process.cwd(), summaryPath) : null}
  )
`;

const preparedRows = rows.map((row) => ({
  market_id: row.market_id ?? null,
  slug: row.slug ?? null,
  question: row.question ?? null,
  end_date: row.end_date ?? null,
  outcome_1: row.outcome_1 ?? null,
  outcome_2: row.outcome_2 ?? null,
  token_1: row.token_1 ?? null,
  token_2: row.token_2 ?? null,
  mid_1: toNum(row.mid_1),
  mid_2: toNum(row.mid_2),
  mid_sum: toNum(row.mid_sum),
  complement_gap: toNum(row.complement_gap),
  spread: toNum(row.spread),
  volume24hr: toNum(row.volume24hr),
  liquidity: toNum(row.liquidity),
  one_hour_change: toNum(row.one_hour_change),
  one_day_change: toNum(row.one_day_change),
  movement_to_spread: toNum(row.movement_to_spread),
  maker_edge_est: toNum(row.maker_edge_est),
  taker_reversion_est: toNum(row.taker_reversion_est),
  confidence: toNum(row.confidence),
  base_score: toNum(row.base_score),
  recommendation: row.recommendation ?? null,
  buy_both_cost: toNum(row.buy_both_cost),
  sell_both_credit: toNum(row.sell_both_credit),
  arb_buy_both_edge: toNum(row.arb_buy_both_edge),
  arb_sell_both_edge: toNum(row.arb_sell_both_edge),
  book_age_ms: toNum(row.book_age_ms),
  book_fresh: toBool(row.book_fresh),
}));

const chunkSize = 300;
for (let i = 0; i < preparedRows.length; i += chunkSize) {
  const chunk = preparedRows.slice(i, i + chunkSize);
  await sql`
    INSERT INTO market_scan_rows (
      scan_id, market_id, slug, question, end_date,
      outcome_1, outcome_2, token_1, token_2,
      mid_1, mid_2, mid_sum, complement_gap,
      spread, volume24hr, liquidity, one_hour_change, one_day_change,
      movement_to_spread, maker_edge_est, taker_reversion_est,
      confidence, base_score, recommendation,
      buy_both_cost, sell_both_credit, arb_buy_both_edge, arb_sell_both_edge,
      book_age_ms, book_fresh
    )
    SELECT
      ${scanId},
      x->>'market_id',
      x->>'slug',
      x->>'question',
      x->>'end_date',
      x->>'outcome_1',
      x->>'outcome_2',
      x->>'token_1',
      x->>'token_2',
      NULLIF(x->>'mid_1','')::double precision,
      NULLIF(x->>'mid_2','')::double precision,
      NULLIF(x->>'mid_sum','')::double precision,
      NULLIF(x->>'complement_gap','')::double precision,
      NULLIF(x->>'spread','')::double precision,
      NULLIF(x->>'volume24hr','')::double precision,
      NULLIF(x->>'liquidity','')::double precision,
      NULLIF(x->>'one_hour_change','')::double precision,
      NULLIF(x->>'one_day_change','')::double precision,
      NULLIF(x->>'movement_to_spread','')::double precision,
      NULLIF(x->>'maker_edge_est','')::double precision,
      NULLIF(x->>'taker_reversion_est','')::double precision,
      NULLIF(x->>'confidence','')::double precision,
      NULLIF(x->>'base_score','')::double precision,
      x->>'recommendation',
      NULLIF(x->>'buy_both_cost','')::double precision,
      NULLIF(x->>'sell_both_credit','')::double precision,
      NULLIF(x->>'arb_buy_both_edge','')::double precision,
      NULLIF(x->>'arb_sell_both_edge','')::double precision,
      NULLIF(x->>'book_age_ms','')::double precision,
      CASE
        WHEN lower(x->>'book_fresh') = 'true' THEN true
        WHEN lower(x->>'book_fresh') = 'false' THEN false
        ELSE null
      END
    FROM jsonb_array_elements(${JSON.stringify(chunk)}::jsonb) x
  `;
}

console.log(
  `Uploaded scan ${scanId}: ${rows.length} markets, ${deepPricedCount} deep-priced, ` +
    `buy-arb>0=${positiveBuy} (fresh=${positiveBuyFresh}), ` +
    `sell-arb>0=${positiveSell} (fresh=${positiveSellFresh})`
);
