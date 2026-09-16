import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accountNumbers } from "@/db/schema/account-numbers";
import { accounts } from "@/db/schema/accounts";

/**
 * The numbers an account's statements printed before its current one (`account_numbers`): a card reissued under a new
 * number. ONE reading for the three places the import names an account by the number a statement prints —
 * `resolveAccount`, the tracked accounts a multi-account profile may read (`parseContextFor`), and the account a
 * withheld section belongs to.
 */

/** Of `candidates`, the ones whose statements printed `last4` under an earlier number. */
export function accountsFormerlyNumbered(db: AppDatabase, candidateIds: readonly string[], last4: string): string[] {
  if (candidateIds.length === 0) return [];
  return db
    .select({ accountId: accountNumbers.accountId })
    .from(accountNumbers)
    .where(and(inArray(accountNumbers.accountId, [...candidateIds]), eq(accountNumbers.last4, last4)))
    .all()
    .map((r) => r.accountId);
}

/** Every earlier number, with the account it belongs to. */
export function formerNumbers(db: AppDatabase): { accountId: string; last4: string }[] {
  return db
    .select({ accountId: accountNumbers.accountId, last4: accountNumbers.last4 })
    .from(accountNumbers)
    .innerJoin(accounts, eq(accounts.id, accountNumbers.accountId))
    .all();
}

/** Records that `accountId`'s statements printed `last4`. Idempotent; the account's current number is never recorded. */
export function recordFormerNumber(tx: AppDatabase, accountId: string, last4: string): boolean {
  const account = tx.select({ last4: accounts.last4 }).from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || account.last4 === last4) return false;
  return tx.insert(accountNumbers).values({ accountId, last4 }).onConflictDoNothing().run().changes > 0;
}
