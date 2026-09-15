import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { statementCadence } from "@/lib/statement-cadence";
import { statementHoles, type StatementHole } from "@/lib/statement-holes";
import { ACCOUNT_ORDER } from "./account-order";

/**
 * Which statements are NOT in the ledger, per account.
 *
 * ⛔ Pass 68 asked `/imports` for "not what was imported but what is missing",
 * and the first place to look for that was `accountCoverage` — which reports
 * every account on this ledger as sound. Zero gap days. Discover reads
 * **VERIFIED**. Discover is also missing five statements.
 *
 * Both are true. Coverage asks whether the MONEY closes, and a balance anchor
 * on the far side of a hole closes it without the documents in between ever
 * arriving. So the question "which statements do I not have" has its own
 * answer, and nothing else in the app was asking it.
 *
 * ⚠️ Neutral, and deliberately so. Statement staleness here is the normal
 * rhythm — accounts go quiet for a month at a time by construction — and a
 * panel that graded old holes as failures would be wrong about how he works.
 * This names the window to fetch and stops.
 */

export interface AccountStatementGaps {
  accountId: string;
  accountName: string;
  holes: StatementHole[];
  /** the sum of `closes` across holes; null where no hole could be counted */
  missingCloses: number | null;
  /** days covered by no statement, summed across holes */
  missingDays: number;
}

export function statementGaps(db: AppDatabase): AccountStatementGaps[] {
  const rows = db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    // THE order: StatementGapsPanel prints these as they come
    .orderBy(...ACCOUNT_ORDER)
    .all();

  const out: AccountStatementGaps[] = [];
  for (const account of rows) {
    const periods = db
      .select({ start: statementPeriods.periodStart, end: statementPeriods.periodEnd })
      .from(statementPeriods)
      .where(eq(statementPeriods.accountId, account.id))
      .orderBy(asc(statementPeriods.periodStart))
      .all();
    /*
     * An account with no statements at all has no HOLES — it has no coverage to
     * be missing from. Reporting "everything since 2022 is missing" for Cash on
     * Hand, which issues no statements and never will, would be the fourth time
     * this codebase confused empty with broken.
     */
    if (periods.length < 2) continue;

    const cadence = statementCadence(periods.map((p) => p.end));
    const holes = statementHoles(periods, cadence);
    if (holes.length === 0) continue;

    const counted = holes.map((h) => h.closes).filter((c): c is number => c !== null);
    out.push({
      accountId: account.id,
      accountName: account.name,
      holes,
      // null rather than 0 when nothing could be counted: "0 statements
      // missing" beside a 60-day hole is a contradiction on its own line
      missingCloses: counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0),
      missingDays: holes.reduce((sum, h) => sum + h.days, 0),
    });
  }
  return out;
}
