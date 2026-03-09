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

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const eventType = arg("type", "deposit");
const amountText = arg("amount", process.env.FUND_AMOUNT_USD ?? null);
const source = arg("source", process.env.FUND_SOURCE ?? "manual");
const txRef = arg("tx-ref", process.env.FUND_TX_REF ?? null);
const notes = arg("notes", process.env.FUND_NOTES ?? null);
const status = arg("status", process.env.FUND_STATUS ?? "confirmed");

const amount = Number(amountText);
if (!Number.isFinite(amount) || amount === 0) {
  console.error("Provide a non-zero --amount value.");
  process.exit(1);
}

await sql`
  INSERT INTO funding_events (event_type, amount_usd, source, tx_ref, status, notes)
  VALUES (${eventType}, ${amount}, ${source}, ${txRef}, ${status}, ${notes})
`;

const rows = await sql`
  SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN amount_usd ELSE 0 END), 0) AS net_capital
  FROM funding_events
`;
console.log(`Funding event recorded: ${eventType} ${amount} USD (${status}).`);
console.log(`Net confirmed capital: ${rows[0].net_capital}`);

