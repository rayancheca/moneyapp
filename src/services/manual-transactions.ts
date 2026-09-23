import { and, eq, max, ne } from "drizzle-orm";
import { z } from "zod";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { financialWindowMessage, isWithinFinancialWindow } from "@/lib/date-window";
import { isValidIsoDate } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { rebuildAccount } from "./derivation";
import { accountsOfTransactions, restoreDuplicatesLosingTheirSurvivor } from "./duplicate-lifecycle";
import { seriesOfTransactions, settleSeriesStats } from "./recurring-import-links";
import { CASH_INSTITUTION_NAME, cashWalletIds, cashWalletInstitutionId, isCashWallet } from "./cash-wallet-rule";

/** The wallet rule has its own module so the budgets page can ask it without importing db/backup (see cash-wallet-rule.ts). */
export { CASH_INSTITUTION_NAME, cashWalletIds, cashWalletInstitutionId, isCashWallet } from "./cash-wallet-rule";

/**
 * Manual transactions (ux-overhaul-plan §3.7): allowed ONLY on manual
 * cash-wallet accounts. On statement-anchored accounts derivation replays
 * every active transaction between anchors — a manual row would break
 * to-the-cent anchor closure, the app's core invariant. Manual is defined
 * by data, not schema: importFileId IS NULL.
 */

export const manualTxnInputSchema = z
  .object({
    accountId: z.string().min(1),
    // manual rows drive the wallet's replay, so a typo'd year would make
    // derivation emit one row per day back to it — bound the year, not just
    // the shape (derivation.ts holds the matching cap for non-UI callers)
    postedOn: z
      .string()
      .refine(isValidIsoDate, "postedOn must be a valid YYYY-MM-DD date")
      .refine(isWithinFinancialWindow, financialWindowMessage("postedOn")),
    amountCents: z
      .number()
      .int()
      .refine((n) => n !== 0, "Amount cannot be zero"),
    description: z.string().trim().min(1).max(200),
    categoryId: z.string().min(1).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type ManualTxnInput = z.infer<typeof manualTxnInputSchema>;

/** Inserts a manual row and rebuilds the wallet's derived balances. */
export function addManualTransaction(db: AppDatabase, input: ManualTxnInput): string {
  const parsed = manualTxnInputSchema.parse(input);

  const account = db.select().from(accounts).where(eq(accounts.id, parsed.accountId)).get();
  if (!account) throw new Error("Unknown account");
  if (!isCashWallet(db, parsed.accountId)) {
    throw new Error(
      `Manual transactions are only allowed on cash-wallet accounts. ` +
        `"${account.name}" is fed by imports — a manual row would break its ` +
        `to-the-cent statement reconciliation.`,
    );
  }
  if (parsed.categoryId) {
    const category = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, parsed.categoryId))
      .get();
    if (!category) throw new Error("Unknown category");
  }

  const rawDescription = parsed.description;
  // same-tuple occurrence counter keeps the (account, dedupeHash) identity
  // unique — two identical $20 cash coffees on one day are both real
  const maxIndex =
    db
      .select({ m: max(transactions.occurrenceIndex) })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, parsed.accountId),
          eq(transactions.postedOn, parsed.postedOn),
          eq(transactions.amountCents, parsed.amountCents),
          eq(transactions.rawDescription, rawDescription),
          ne(transactions.status, "superseded"),
        ),
      )
      .get()?.m ?? null;
  const occurrenceIndex = maxIndex === null ? 0 : maxIndex + 1;

  const id = db
    .insert(transactions)
    .values({
      accountId: parsed.accountId,
      postedOn: parsed.postedOn,
      amountCents: parsed.amountCents,
      rawDescription,
      normalizedDescription: normalizeDescription(rawDescription),
      occurrenceIndex,
      dedupeHash: dedupeHash({
        accountId: parsed.accountId,
        postedOn: parsed.postedOn,
        amountCents: parsed.amountCents,
        rawDescription,
        occurrenceIndex,
      }),
      needsReview: false,
      ...(parsed.categoryId
        ? {
            categoryId: parsed.categoryId,
            categorizationSource: "user" as const,
            categorizationConfidence: 1,
          }
        : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
    })
    .returning({ id: transactions.id })
    .get().id;

  // manual rows DO drive balance derivation on cash wallets (§3.7)
  rebuildAccount(db, parsed.accountId);
  return id;
}

export const manualTxnEditSchema = z
  .object({
    postedOn: z
      .string()
      .refine(isValidIsoDate, "postedOn must be a valid YYYY-MM-DD date")
      .refine(isWithinFinancialWindow, financialWindowMessage("postedOn"))
      .optional(),
    amountCents: z
      .number()
      .int()
      .refine((n) => n !== 0, "Amount cannot be zero")
      .optional(),
    description: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((p) => p.postedOn !== undefined || p.amountCents !== undefined || p.description !== undefined, {
    message: "Nothing to change",
  });
export type ManualTxnEdit = z.infer<typeof manualTxnEditSchema>;

/**
 * Edits a manual row's imported-fact fields (date / amount / description) —
 * the S4 "nothing read-only" slice. Imported rows stay immutable (the audit
 * trail); manual rows are user-authored, so the user may correct them. The
 * row's dedupe identity (occurrence index + hash) is recomputed for the new
 * tuple, and the wallet's derived balances rebuild.
 */
export function editManualTransaction(db: AppDatabase, id: string, patch: ManualTxnEdit): void {
  const parsed = manualTxnEditSchema.parse(patch);
  const txn = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.importFileId !== null) {
    throw new Error("Only manual transactions can be edited — imported rows are the audit trail");
  }

  const postedOn = parsed.postedOn ?? txn.postedOn;
  const amountCents = parsed.amountCents ?? txn.amountCents;
  const rawDescription = parsed.description ?? txn.rawDescription;
  const identityChanged =
    postedOn !== txn.postedOn || amountCents !== txn.amountCents || rawDescription !== txn.rawDescription;
  if (!identityChanged) return;

  // Changing the amount would break the split invariant (parts must sum to the
  // parent) — the splits are enforced only at write time in setSplits, so the
  // stale parts would silently under/over-count analytics forever. Block it.
  if (amountCents !== txn.amountCents) {
    const hasSplits = db
      .select({ id: transactionSplits.id })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, id))
      .get();
    if (hasSplits) {
      throw new Error("Remove the split before changing this transaction's amount.");
    }
  }

  // same-tuple occurrence counter as addManualTransaction, excluding this row
  const maxIndex =
    db
      .select({ m: max(transactions.occurrenceIndex) })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, txn.accountId),
          eq(transactions.postedOn, postedOn),
          eq(transactions.amountCents, amountCents),
          eq(transactions.rawDescription, rawDescription),
          ne(transactions.status, "superseded"),
          ne(transactions.id, id),
        ),
      )
      .get()?.m ?? null;
  const occurrenceIndex = maxIndex === null ? 0 : maxIndex + 1;

  db.update(transactions)
    .set({
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: normalizeDescription(rawDescription),
      occurrenceIndex,
      dedupeHash: dedupeHash({
        accountId: txn.accountId,
        postedOn,
        amountCents,
        rawDescription,
        occurrenceIndex,
      }),
    })
    .where(eq(transactions.id, id))
    .run();

  rebuildAccount(db, txn.accountId);
}

/** Deletes a manual row only — imported rows are the audit trail. */
export function deleteManualTransaction(db: AppDatabase, id: string): void {
  const txn = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.importFileId !== null) {
    throw new Error("Only manual transactions can be deleted — imported rows are the audit trail");
  }
  // Nothing re-imports a manual row — the deletion is the whole history.
  withPreMutationSnapshot(db, "delete-manual-transaction", () => {
    // If another copy of this charge was retired as a duplicate OF this row,
    // deleting this one alone would leave the money recorded by nothing at all.
    // Put the retired copy back first — same reasoning, and same atomicity
    // requirement, as unimportFile.
    let restored: string[] = [];
    db.transaction((tx) => {
      restored = restoreDuplicatesLosingTheirSurvivor(tx, [id]);
      tx.delete(transactions).where(eq(transactions.id, id)).run();
    });
    for (const accountId of new Set([txn.accountId, ...accountsOfTransactions(db, restored)])) {
      rebuildAccount(db, accountId);
    }
    // …and the series that just lost this row, or got a restored copy back:
    // `last_matched_on` must not go on naming a posting that is gone, and must
    // not omit one that is back. Read the deleted row's series BEFORE the
    // delete (nothing is left to ask afterwards), the restored copies' after.
    settleSeriesStats(db, [
      ...(txn.recurringSeriesId === null ? [] : [txn.recurringSeriesId]),
      ...seriesOfTransactions(db, restored),
    ]);
  });
}
