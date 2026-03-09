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

const idText = arg("id", null);
const status = (arg("status", "processed") ?? "").toLowerCase();
const txRef = arg("tx-ref", null);
const source = arg("source", "solana");
const notes = arg("notes", null);

const id = Number(idText);
if (!Number.isInteger(id) || id <= 0) {
  console.error("Provide a valid --id value.");
  process.exit(1);
}

if (status !== "processed" && status !== "rejected") {
  console.error("Provide --status processed|rejected");
  process.exit(1);
}

const rows = await sql`
  SELECT id, amount_usd, asset, destination_address, status
  FROM withdrawal_requests
  WHERE id = ${id}
  LIMIT 1
`;
const request = rows[0];
if (!request) {
  console.error(`Withdrawal request ${id} not found.`);
  process.exit(1);
}
if (request.status !== "pending") {
  console.error(`Withdrawal request ${id} is already ${request.status}.`);
  process.exit(1);
}

if (status === "processed") {
  const amountUsd = -Math.abs(Number(request.amount_usd));
  const noteParts = [
    notes,
    `withdrawal ${request.asset} to ${request.destination_address}`,
    `request:${id}`,
  ].filter(Boolean);

  await sql`
    INSERT INTO funding_events (event_type, amount_usd, source, tx_ref, status, notes)
    VALUES ('withdrawal', ${amountUsd}, ${source}, ${txRef}, 'confirmed', ${noteParts.join(" | ")})
  `;
}

await sql`
  UPDATE withdrawal_requests
  SET status = ${status}, processed_tx_ref = ${txRef}
  WHERE id = ${id}
`;

console.log(`Withdrawal request ${id} marked ${status}.`);
