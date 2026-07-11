"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createCashWallet, cashWalletInputSchema, type CashWalletInput } from "@/services/cash-wallets";
import { deleteManualTransaction } from "@/services/manual-transactions";
import type { ActionResult } from "@/app/transactions/action-types";

/**
 * Cash-wallet actions (ux-overhaul-plan §3.7). Manual-transaction insertion
 * reuses addManualTransactionAction from the transactions action layer; these
 * cover the wallet lifecycle. All revalidate Accounts + the dashboard net worth.
 */

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "Unexpected error" };
}

function revalidateAccounts(): void {
  revalidatePath("/accounts");
  revalidatePath("/");
}

export async function createCashWalletAction(
  input: CashWalletInput,
): Promise<ActionResult<{ accountId: string }>> {
  try {
    const parsed = cashWalletInputSchema.parse(input);
    const accountId = createCashWallet(getDb(), parsed);
    revalidateAccounts();
    return { ok: true, data: { accountId } };
  } catch (error: unknown) {
    return fail(error);
  }
}

export async function deleteManualTransactionAction(
  id: string,
): Promise<ActionResult<{ deleted: boolean }>> {
  try {
    const parsed = z.string().min(1).parse(id);
    deleteManualTransaction(getDb(), parsed);
    revalidateAccounts();
    revalidatePath("/transactions");
    return { ok: true, data: { deleted: true } };
  } catch (error: unknown) {
    return fail(error);
  }
}
