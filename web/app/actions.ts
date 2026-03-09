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

