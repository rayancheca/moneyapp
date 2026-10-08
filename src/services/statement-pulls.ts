import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { todayIso } from "@/lib/dates";
import { statementPull, type StatementPull } from "@/lib/statement-cadence";
import { ACCOUNT_ORDER } from "./account-order";
import { statementsByAccount } from "./statements-by-account";

/**
 * Which accounts have a statement waiting to be downloaded (ux: the Imports
 * page's "Statement schedule" panel).
 *
 * The cadence is measured per account from its own close dates — see
 * lib/statement-cadence.ts. WHICH period rows count as closes is
 * `statementsByAccount`'s rule, the one Missing statements reads by too.
 */

export interface AccountStatementPull extends StatementPull {
  accountId: string;
  accountName: string;
}

/**
 * ⛔ A Chase *Spending Report* is not a close: `statementsByAccount` leaves out every period that printed no
 * balances, and says why that is load-bearing — the rule Missing statements reads by, too. Its one exception is an
 * account's opening statement (Robinhood's first prints `N/A` for the opening), which closed on the cycle.
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

  const statements = statementsByAccount(db);

  return rows.flatMap((a) => {
    const periods = statements.get(a.id);
    // An account that has never had a statement is not overdue for one — Cash on
    // Hand is a physical wallet and issues none. Silence is the honest output.
    if (!periods) return [];
    return [{ accountId: a.id, accountName: a.name, ...statementPull(periods.map((p) => p.end), today) }];
  });
}
