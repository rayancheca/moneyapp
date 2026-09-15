import { and, eq, inArray, isNotNull, max, ne } from "drizzle-orm";
import { z } from "zod";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { financialWindowMessage, isWithinFinancialWindow } from "@/lib/date-window";
import { isValidIsoDate } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { rebuildAccount } from "./derivation";
import { accountsOfTransactions, restoreDuplicatesLosingTheirSurvivor } from "./duplicate-lifecycle";

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

/** The institution every intentional cash wallet lives under. */
export const CASH_INSTITUTION_NAME = "Cash";

/** The "Cash" institution's id, or null if none exists yet. */
export function cashWalletInstitutionId(db: AppDatabase): string | null {
  return (
    db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.name, CASH_INSTITUTION_NAME))
      .get()?.id ?? null
  );
}

/**
 * A cash wallet is an INTENTIONAL manual wallet — one created under the "Cash"
 * institution — that also has NO external ground truth: no statement periods,
 * no import anchors (statement/ofx_ledger/live), and no imported transactions.
 * The institution marker is load-bearing: a structural-only check would
 * misclassify any freshly-created, not-yet-imported REGULAR bank account as a
 * cash wallet and let a manual row land on it, which would later break that
 * account's to-the-cent statement reconciliation. The structural checks then
 * stay as defense-in-depth (a "Cash" account never legitimately has imports).
 *
 * ⛔ The rule lives in `cashWalletIds`; this asks it about one account.
 */
export function isCashWallet(db: AppDatabase, accountId: string): boolean {
  return cashWalletIds(db).has(accountId);
}

/**
 * Every cash wallet in the ledger, by the rule `isCashWallet` states: under the
 * "Cash" institution, with no statement period, no import anchor and no
 * imported row.
 *
 * ⛔ ONE rule for both spellings. `/budgets` asks "which of the accounts this
 * category was spent from are wallets" on every row of the page, and a second,
 * batch copy of these checks beside `isCashWallet` would be two definitions of a
 * wallet that can drift — the write guard in `addManualTransaction` and a page
 * that leaves wallets out would then disagree about the same account.
 *
 * ⚠️ Archived wallets are included: archiving an account does not let an import
 * reach it, and a category spent from one inside a window is still spent from a
 * wallet.
 */
export function cashWalletIds(db: AppDatabase): ReadonlySet<string> {
  const cashInstId = cashWalletInstitutionId(db);
  if (cashInstId === null) return new Set();
  const underCash = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.institutionId, cashInstId))
    .all();
  return new Set(underCash.map((a) => a.id).filter((id) => !hasImportGroundTruth(db, id)));
}

/** A statement period, an import anchor (statement/ofx_ledger/live) or an imported row on the account. */
function hasImportGroundTruth(db: AppDatabase, accountId: string): boolean {
  const period = db
    .select({ id: statementPeriods.id })
    .from(statementPeriods)
    .where(eq(statementPeriods.accountId, accountId))
    .get();
  if (period) return true;

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
  if (importAnchor) return true;

  const importedTxn = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.importFileId)))
    .get();
  return importedTxn !== undefined;
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
  });
}
