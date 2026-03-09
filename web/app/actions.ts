"use server";

import { revalidatePath } from "next/cache";
import { getDbClient } from "../lib/db";

export async function createFundingIntent(formData: FormData) {
  const amountRaw = formData.get("amount_usd");
  const noteRaw = formData.get("note");
  const amount = Number(amountRaw);
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }

  const sql = getDbClient();
  await sql`
    INSERT INTO funding_intents (amount_usd, note, status)
    VALUES (${amount}, ${note || null}, 'pending')
  `;

  revalidatePath("/");
}

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function createWithdrawalRequest(formData: FormData) {
  const amountRaw = formData.get("amount_usd");
  const assetRaw = formData.get("asset");
  const destinationRaw = formData.get("destination_address");
  const noteRaw = formData.get("note");

  const amount = Number(amountRaw);
  const asset = typeof assetRaw === "string" ? assetRaw.toUpperCase().trim() : "";
  const destinationAddress = typeof destinationRaw === "string" ? destinationRaw.trim() : "";
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }
  if (asset !== "SOL" && asset !== "USDC") {
    return;
  }
  if (!SOLANA_ADDRESS_REGEX.test(destinationAddress)) {
    return;
  }

  const sql = getDbClient();
  await sql`
    INSERT INTO withdrawal_requests (amount_usd, asset, destination_address, note, status)
    VALUES (${amount}, ${asset}, ${destinationAddress}, ${note || null}, 'pending')
  `;

  revalidatePath("/");
}
