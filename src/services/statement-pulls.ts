import { eq, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { todayIso } from "@/lib/dates";
import { statementPull, type StatementPull } from "@/lib/statement-cadence";
import { ACCOUNT_ORDER } from "./account-order";

/**
 * Which accounts have a statement waiting to be downloaded (ux: the Imports
 * page's "Statement schedule" panel).
 *
 * The cadence is measured per account from its own close dates — see
 * lib/statement-cadence.ts. This service's only real job is deciding WHICH
 * period rows count as closes.
 */

export interface AccountStatementPull extends StatementPull {
  accountId: string;
  accountName: string;
}

/**
 * ⛔ `not_applicable` periods are excluded, and the exclusion is load-bearing.
 *
 * That state means "no printed balances", which is what a Chase *Spending
 * Report* parses into — the real ledger holds two, one covering 2026-01-01 →
 * 2026-07-10 on Chase Sapphire. It is not a statement and it does not recur, but
 * its period end is the newest one on the account, so counting it would report
 * the Sapphire cycle as closing on the 10th (it closes on the 2nd) AND treat the
 * August statement, already imported, as still outstanding.
 *
 * Every other reconciliation state IS a statement: `reconciled` and `accepted`
 * are ones that balanced or were signed off, `gap` is one that did not, and
 * `value_anchor` is an investment statement priced rather than reconciled. All
 * four arrive on the account's cycle, which is the only property this reads.
 */
export function statementPulls(
  db: AppDatabase,
  today: string = todayIso(),
): AccountStatementPull[] {
  const rows = db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    // THE order: the dashboard Statements teaser prints these as they come
    .orderBy(...ACCOUNT_ORDER)
    .all();

  const closes = db
    .select({ accountId: statementPeriods.accountId, periodEnd: statementPeriods.periodEnd })
    .from(statementPeriods)
    .where(ne(statementPeriods.reconciliation, "not_applicable"))
    .all();

  const byAccount = new Map<string, string[]>();
  for (const c of closes) {
    const list = byAccount.get(c.accountId);
    if (list) list.push(c.periodEnd);
    else byAccount.set(c.accountId, [c.periodEnd]);
  }

  return rows.flatMap((a) => {
    const ends = byAccount.get(a.id);
    // An account that has never had a statement is not overdue for one — Cash on
    // Hand is a physical wallet and issues none. Silence is the honest output.
    if (!ends) return [];
    return [{ accountId: a.id, accountName: a.name, ...statementPull(ends, today) }];
  });
}
