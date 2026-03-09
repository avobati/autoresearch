"use server";

import { revalidatePath } from "next/cache";
import { getDbClient } from "../lib/db";

export type ActionState = {
  ok: boolean;
  message: string;
};

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

export async function recordWalletDeposit(formData: FormData) {
  const amountRaw = formData.get("amount_usd");
  const txRefRaw = formData.get("tx_ref");
  const noteRaw = formData.get("note");

  const amount = Number(amountRaw);
  const txRef = typeof txRefRaw === "string" ? txRefRaw.trim() : "";
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  if (!Number.isFinite(amount) || amount <= 0 || !txRef) {
    return;
  }

  const sql = getDbClient();
  const existing = await sql`
    SELECT id
    FROM funding_events
    WHERE event_type = 'deposit' AND tx_ref = ${txRef}
    LIMIT 1
  `;
  if (existing.length > 0) {
    revalidatePath("/");
    return;
  }

  await sql`
    INSERT INTO funding_events (event_type, amount_usd, source, tx_ref, status, notes)
    VALUES ('deposit', ${amount}, 'solana_wallet', ${txRef}, 'confirmed', ${note || 'Wallet deposit'})
  `;

  revalidatePath("/");
}

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function createWithdrawalRequest(
  prevOrFormData: ActionState | FormData | null,
  maybeFormData?: FormData
): Promise<ActionState> {
  const formData = prevOrFormData instanceof FormData ? prevOrFormData : maybeFormData;
  if (!formData) {
    return { ok: false, message: "Invalid withdrawal form submission." };
  }

  const amountRaw = formData.get("amount_usd");
  const assetRaw = formData.get("asset");
  const destinationRaw = formData.get("destination_address");
  const noteRaw = formData.get("note");

  const amount = Number(amountRaw);
  const asset = typeof assetRaw === "string" ? assetRaw.toUpperCase().trim() : "";
  const destinationAddress = typeof destinationRaw === "string" ? destinationRaw.trim() : "";
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter a valid withdrawal amount." };
  }
  if (asset !== "SOL" && asset !== "USDC") {
    return { ok: false, message: "Select SOL or USDC." };
  }
  if (!SOLANA_ADDRESS_REGEX.test(destinationAddress)) {
    return { ok: false, message: "Connect a valid Solana wallet address first." };
  }

  const sql = getDbClient();
  const rows = await sql`
    INSERT INTO withdrawal_requests (amount_usd, asset, destination_address, note, status)
    VALUES (${amount}, ${asset}, ${destinationAddress}, ${note || null}, 'pending')
    RETURNING id
  `;

  revalidatePath("/");
  const requestId = rows[0]?.id ? Number(rows[0].id) : null;
  return {
    ok: true,
    message: requestId
      ? `Withdrawal request #${requestId} submitted (status: pending).`
      : "Withdrawal request submitted (status: pending).",
  };
}
