import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { LIVE_FILE, importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { diffDays } from "@/lib/dates";
import { withheldSectionsOf } from "@/lib/import-file-label";
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
 *
 * 🔴 …and a window whose statement WAS imported is not one to fetch. A file that withheld an account's section
 * (`WithheldSectionFacts`) writes no period for it, so once a later statement arrived the window read as a hole —
 * measured by a second reader on copies of the real ledger: Robinhood Agentic, Aug 1 – 31, 2026, 31 days, under
 * "These are files to fetch". Fetching cannot fill it: a re-download is the same bytes, skipped as a duplicate with
 * nothing withheld to report, so the import scripts print no WITHHELD line either. Such a window counts as covered
 * when holes are found, and is reported beside them as what it is.
 */

/** A window an account's statement covers in a file already imported, but without that account's section. */
export interface WithheldWindow {
  /** first day of the withheld statement */
  from: string;
  /** last day of the withheld statement */
  to: string;
  /** whole days, both ends inclusive */
  days: number;
  /** the import row that left it out — where its notice is */
  fileName: string;
}

export interface AccountStatementGaps {
  accountId: string;
  accountName: string;
  holes: StatementHole[];
  /** the sum of `closes` across holes; null where no hole could be counted */
  missingCloses: number | null;
  /** days covered by no statement, summed across holes */
  missingDays: number;
  /** windows imported without this account's section — never counted in `holes`, `missingCloses` or `missingDays` */
  withheld: WithheldWindow[];
}

/** Every still-imported file's withheld sections, by the account they belong to. */
function withheldWindowsByAccount(db: AppDatabase): Map<string, WithheldWindow[]> {
  const files = db
    .select({ fileName: importFiles.fileName, status: importFiles.status, error: importFiles.error })
    .from(importFiles)
    .where(and(inArray(importFiles.status, [...LIVE_FILE]), isNotNull(importFiles.error)))
    .all();
  const out = new Map<string, WithheldWindow[]>();
  for (const file of files) {
    for (const section of withheldSectionsOf(file)) {
      if (section.accountId === null) continue;
      const window: WithheldWindow = {
        from: section.periodStart,
        to: section.periodEnd,
        days: diffDays(section.periodStart, section.periodEnd) + 1,
        fileName: file.fileName,
      };
      out.set(section.accountId, [...(out.get(section.accountId) ?? []), window]);
    }
  }
  return out;
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

  const withheldByAccount = withheldWindowsByAccount(db);
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
    // a window another file's statement DID prove is no longer withheld from the ledger
    const withheld = (withheldByAccount.get(account.id) ?? [])
      .filter((w) => !periods.some((p) => p.start <= w.from && p.end >= w.to))
      .sort((a, b) => a.from.localeCompare(b.from));
    // the bank issued the withheld statements and their files are imported: covered, for finding holes
    const issued = [...periods, ...withheld.map((w) => ({ start: w.from, end: w.to }))];
    const holes = issued.length < 2 ? [] : statementHoles(issued, statementCadence(issued.map((p) => p.end)));
    if (holes.length === 0 && withheld.length === 0) continue;

    const counted = holes.map((h) => h.closes).filter((c): c is number => c !== null);
    out.push({
      accountId: account.id,
      accountName: account.name,
      holes,
      // null rather than 0 when nothing could be counted: "0 statements
      // missing" beside a 60-day hole is a contradiction on its own line
      missingCloses: counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0),
      missingDays: holes.reduce((sum, h) => sum + h.days, 0),
      withheld,
    });
  }
  return out;
}
