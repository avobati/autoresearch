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

const [latest] = await sql`
  SELECT scan_id
  FROM market_scan_runs
  ORDER BY created_at DESC
  LIMIT 1
`;
if (!latest?.scan_id) {
  console.log("No scan run found. Nothing to queue.");
  process.exit(0);
}
const scanId = latest.scan_id;

const [funding] = await sql`
  SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN amount_usd ELSE 0 END), 0) AS net_capital
  FROM funding_events
`;
const netCapital = Number(funding?.net_capital ?? 0);
if (!Number.isFinite(netCapital) || netCapital <= 0) {
  console.log("No confirmed capital available. Queue not generated.");
  process.exit(0);
}

const perTask = Math.max(15, Math.min(netCapital * 0.25, 50));

const arb = await sql`
  SELECT slug, question, GREATEST(COALESCE(arb_buy_both_edge, 0), COALESCE(arb_sell_both_edge, 0)) AS edge_score
  FROM market_scan_rows
  WHERE scan_id = ${scanId}
    AND book_fresh = true
    AND GREATEST(COALESCE(arb_buy_both_edge, 0), COALESCE(arb_sell_both_edge, 0)) >= 0.001
    AND volume24hr >= 5000
  ORDER BY edge_score DESC
  LIMIT 3
`;

const maker = await sql`
  SELECT slug, question, maker_edge_est AS edge_score
  FROM market_scan_rows
  WHERE scan_id = ${scanId}
    AND maker_edge_est >= 0.001
    AND volume24hr >= 5000
    AND spread BETWEEN 0.005 AND 0.03
    AND confidence >= 0.2
  ORDER BY edge_score DESC, volume24hr DESC
  LIMIT 4
`;

const momentum = await sql`
  SELECT slug, question, movement_to_spread AS edge_score
  FROM market_scan_rows
  WHERE scan_id = ${scanId}
    AND movement_to_spread >= 6
    AND volume24hr >= 5000
    AND spread <= 0.02
  ORDER BY edge_score DESC
  LIMIT 3
`;

await sql`DELETE FROM opportunity_tasks WHERE status='pending'`;

const queueRows = [
  ...arb.map((r) => ({
    strategy: "arb",
    row: r,
    rationale: "Fresh cross-outcome arb edge over fee/slippage floor.",
  })),
  ...maker.map((r) => ({
    strategy: "maker",
    row: r,
    rationale: "Maker spread edge in higher-liquidity market.",
  })),
  ...momentum.map((r) => ({
    strategy: "momentum",
    row: r,
    rationale: "Short-term movement/spread ratio indicates follow-through.",
  })),
];

for (const item of queueRows) {
  await sql`
    INSERT INTO opportunity_tasks (
      scan_id, slug, question, strategy_mode, edge_score, proposed_amount_usd, status, rationale
    )
    VALUES (
      ${scanId},
      ${item.row.slug ?? null},
      ${item.row.question ?? null},
      ${item.strategy},
      ${Number(item.row.edge_score ?? 0)},
      ${perTask},
      'pending',
      ${item.rationale}
    )
  `;
}

console.log(
  `Queue refreshed from ${scanId}: ${queueRows.length} pending tasks, proposed ${perTask.toFixed(
    2
  )} USD each.`
);

