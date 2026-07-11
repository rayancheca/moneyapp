import { and, eq, inArray, isNotNull, max, ne } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { isValidIsoDate } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { rebuildAccount } from "./derivation";

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
    postedOn: z.string().refine(isValidIsoDate, "postedOn must be a valid YYYY-MM-DD date"),
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

/**
 * A cash wallet is an account with NO external ground truth: no statement
 * periods, no non-manual anchors (statement/ofx_ledger imports or a real-time
 * `live` connection balance), and no imported transactions. The transaction
 * check matters for activity-CSV accounts (Robinhood) that carry imported rows
 * but no period records. A `live`-anchored connection account is authoritative
 * on its own balance, so a manual row there would fight that ground truth.
 */
export function isCashWallet(db: AppDatabase, accountId: string): boolean {
  const account = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return false;

  const period = db
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, accountId))
    .get();
  if (period) return false;

  const importAnchor = db
    .select({ id: balanceAnchors.id })
    .from(balanceAnchors)
    .where(
      and(
        eq(balanceAnchors.accountId, accountId),
        inArray(balanceAnchors.source, ["statement", "ofx_ledger", "live"]),
      ),
    )
    .get();
  if (importAnchor) return false;

  const importedTxn = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.importFileId)))
    .get();
  return importedTxn === undefined;
}

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

/** Deletes a manual row only — imported rows are the audit trail. */
export function deleteManualTransaction(db: AppDatabase, id: string): void {
  const txn = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!txn) throw new Error("Unknown transaction");
  if (txn.importFileId !== null) {
    throw new Error("Only manual transactions can be deleted — imported rows are the audit trail");
  }
  db.delete(transactions).where(eq(transactions.id, id)).run();
  rebuildAccount(db, txn.accountId);
}
