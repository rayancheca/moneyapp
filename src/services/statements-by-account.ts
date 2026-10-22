import { and, asc, eq, exists, lt, not, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db/client";
import { importFiles, statementPeriods, type ReconciliationState } from "@/db/schema/imports";
import type { StatementPeriodRef } from "@/lib/statement-holes";
import { ofxProfile } from "./import/profiles/ofx-profile";

/** What `countsAsStatement` reads of a period: its state, and the parser that read its file (null: none recorded). */
export interface PeriodKind {
  readonly reconciliation: ReconciliationState;
  readonly parserProfile: string | null;
}

/**
 * Which `statement_periods` rows are STATEMENTS — the one reading of them that /imports' statement schedule
 * (`statementPulls`) and its Missing statements panel (`statementGaps`) both take. Its "What the statements
 * proved" list asks a narrower question, which printed balances (`carriesBalances`, below).
 *
 * ⛔ `not_applicable` periods are not statements, and leaving them out is load-bearing. That state means "no
 * printed balances": what a Chase *Spending Report* parses into — the real ledger holds two on Chase Sapphire,
 * 2025-01-01 → 2025-12-31 and 2026-01-01 → 2026-07-10 — and what a balance-less export declares (a Rocket Money
 * CSV on Wells Fargo, 2026-07-27 → 2026-08-24). Neither is issued on the account's cycle:
 *
 *   - as a CLOSE, the Jul 10 report's end is the newest on Sapphire, so counting it would report the cycle as
 *     closing on the 10th (it closes on the 2nd) and the August statement, already imported, as outstanding;
 *   - as COVERAGE, a report spans many cycles, so a statement missing under it would read as present.
 *
 * Every other state IS a statement: `reconciled` and `accepted` are ones that balanced or were signed off, `gap`
 * is one that did not, and `value_anchor` is an investment statement priced rather than reconciled. All four
 * arrive on the account's cycle, which is the property both panels read.
 *
 * ⛔ …and so is one `not_applicable` kind: an account's OPENING statement from a parser in
 * `OPENING_STATEMENT_PROFILES`. Robinhood prints `N/A` for the opening balance on an account's first statement, so
 * it parses into a balance-less period exactly as a report does (Robinhood Cash, Dec 2023; Robinhood Agentic, Jun
 * 2026 on the real ledger) — yet Robinhood issued it on the account's month-end cycle, and its close is a close. The
 * state cannot tell the two apart; the file's kind (`import_files.parser_profile`) can.
 *
 * 🔴 The state alone left both opening statements out, and with them the frontier the hole walk starts from: a
 * month missing right after one sat before the first statement counted, where no hole is looked for. Measured
 * 2026-10-08: robinhood-parse-context.test.ts — Agentic's June opening statement, July never imported, August
 * imported without its section, September imported — lost July from Missing statements (bisected to 8512476, the
 * commit that gave this rule its one home); on a copy of his ledger, dropping Agentic's July or Robinhood Cash's
 * January 2024 listed nothing, and the schedule read Agentic "unknown", two closes under the bar of three.
 *
 * 🔴 Two callers, and only one of them applied it. Missing statements read every row, so its hole walk's frontier
 * jumped to a report's end: measured by the review on a copy of his ledger, 2026-10-08, drop any of Sapphire's
 * statements from Mar 2025 to Jun 2026 and the panel listed nothing — nor did the schedule, whose last close is a
 * later statement — and drop the one closing Aug 2, 2026 and it read Jul 11 – Aug 2, the report's last day
 * standing in for a close. Dropping each of the copy's 256 statements in turn, those 17 now read as the statement
 * missing; a one-day Wells Fargo window (Aug 25) the Rocket Money CSV's end opened no longer shows; the other 236
 * read as before. The two behind Robinhood's opening statements (above) stopped showing with it, and show again
 * now the file's kind is read: re-measured the same day, those two are the only drops that differ.
 */
export function countsAsStatement(period: PeriodKind): boolean {
  if (carriesBalances(period.reconciliation)) return true;
  return period.parserProfile !== null && OPENING_STATEMENT_PROFILES.has(period.parserProfile);
}

/**
 * The parsers whose balance-less period is an account's OPENING statement, issued on its cycle like every other.
 *
 * ⛔ An allowlist, not a list of reports, because the two mistakes cost differently: a report counted as a statement
 * hides every statement missing under it and moves the close day (above), while an opening statement left out only
 * stops the hole walk looking before it. A new parser's balance-less period is a report until someone shows
 * otherwise. `robinhood-brokerage-statement-pdf` writes one only when a section prints `N/A` for its opening — its
 * cash and its brokerage book alike (`declaredRange`, profiles/robinhood-brokerage-statement-profile.ts).
 */
export const OPENING_STATEMENT_PROFILES: ReadonlySet<string> = new Set(["robinhood-brokerage-statement-pdf"]);

/**
 * Whether a period printed balances — something to reconcile or to price. This is what /imports' "What the
 * statements proved" list and its three tiles count, and it is NOT `countsAsStatement`: an opening statement arrived
 * on the cycle (the panels' rule takes its close), but with no opening printed its period reconciles nothing. The
 * page reads both through `statementEvidence` (services/statement-evidence.ts), whose footer names what each left-out
 * is (`balanceLessKind`, below).
 */
export function carriesBalances(reconciliation: ReconciliationState): boolean {
  return reconciliation !== "not_applicable";
}

/**
 * A statement that printed no balances to check — an account's OPENING statement (`countsAsStatement`, above): every
 * reader that says what a balance-less period IS asks this (through `balanceLessKind`, below), never the state alone,
 * so a page cannot call one a file that "carries no balances" while the schedule's rule takes its close.
 *
 * 🔴 Two readers of one fact. /imports' footer named Robinhood Agentic's Jun 2026 opening statement "an account's
 * first" (`statementEvidence`), while the sheet of the one row on his ledger from its file still read "coverage
 * declared, but this file carries no balances to check against" — off `reconciliation` alone, under a headline
 * saying the file recorded Agentic's balance on Jun 30 (measured on a copy of his ledger 2026-10-12, provenance.ts
 * `periodDetail`).
 */
export function isOpeningStatement(period: PeriodKind): boolean {
  return !carriesBalances(period.reconciliation) && countsAsStatement(period);
}

/** What `balanceLessKind` reads of a period: its kind, and the newest balance its file recorded for the account. */
export interface BalanceLessFacts extends PeriodKind {
  /** `fileRecordedBalanceOn` (services/file-recorded-balance.ts) of the period's file and account */
  readonly recordedOn: string | null;
}

/**
 * What a period that printed no balances IS: an account's opening statement (`isOpeningStatement`), a file that
 * recorded the account's balance but no opening one — an OFX download's LEDGERBAL — an OFX download the ledger keeps
 * no balance of on the account (`isOfxDownload`), or a file that recorded none, a Spending Report or a balance-less
 * export. Null for a period that printed balances.
 *
 * ⛔ Every reader that names one asks this — the period line on a row's and a day's sheet, the period's own sheet
 * (provenance.ts) and /imports' footer (`statementEvidence`) — so no page calls a file that recorded a balance one that
 * "carries no balances", nor a statement by the schedule's rule (`countsAsStatement`) a report.
 *
 * 🔴 601f155 read the opening statement off the parser and left every other balance-less period to the state: the
 * review of it, on a copy of data/e2e.db (2026-10-12), found 18 of the fixture's 27 OFX downloads reading "this file
 * carries no balances to check against" under the balance that same file recorded. ⚠️ The opening statement is asked
 * first: Agentic's June PDF recorded its close too, and it is still the account's first statement.
 *
 * 🔴 …and 74f25fb told the other nine from a report in the footer alone, by reading the parser beside this rule: "9
 * imported downloads left the ledger no balance of their own" over sheets that read this kind and still said of the
 * same files "this file carries no balances" (a copy of data/e2e.db, 2026-10-14; each printed a LEDGERBAL its
 * quarter's CSV re-recorded). `download_no_balance` is that reading, here, for every reader.
 */
export type BalanceLessKind = "opening_statement" | "balance_recorded" | "download_no_balance" | "no_balance";

export function balanceLessKind(period: BalanceLessFacts): BalanceLessKind | null {
  if (carriesBalances(period.reconciliation)) return null;
  if (isOpeningStatement(period)) return "opening_statement";
  if (period.recordedOn !== null) return "balance_recorded";
  return isOfxDownload(period.parserProfile) ? "download_no_balance" : "no_balance";
}

/**
 * Whether an OFX parser read the file (`ofxProfile`) — a bank's download, which can print the account's balance
 * (LEDGERBAL). One that owns no balance on an account (`fileRecordedBalanceOn`) is named by what the ledger keeps of it
 * — "left the ledger no balance of its own" — never as a file that carries none, which it may well have printed: the
 * ledger keeps one `ofx_ledger` balance per account and day, the last writer's (⚖️ anchor ownership as shipped), and
 * cannot tell a re-recorded LEDGERBAL from none printed. A row's headline asks it too (provenance.ts `rowHeadline`).
 */
export function isOfxDownload(parserProfile: string | null): boolean {
  return parserProfile === ofxProfile.id;
}

/**
 * Whether no period of the account starts before this one — what lets a page call an opening statement "the
 * account's first". ONE rule for /imports' footer (`statementEvidence`), the period line on a row's and a day's sheet
 * and the period's own sheet (provenance.ts).
 *
 * 🔴 Every reader said it of every opening statement, and nothing checked it: the parser knows only that the section
 * printed `N/A` for its opening, which Robinhood prints on an account's first statement — measured twice (Robinhood
 * Cash, Dec 2023; Robinhood Agentic, Jun 2026: no period of either account starts before them, his ledger copy
 * 2026-10-13), never promised. A later `N/A` is a statement still (`countsAsStatement`), and is called one.
 *
 * ⚠️ ANY period, not only statements: an earlier report on the account makes this false of its first statement too.
 * The cost is a page saying "a statement" where "its first" was true — never "its first" where it is not.
 */
export function firstOnAccount(db: AppDatabase, period: { accountId: string; periodStart: string }): boolean {
  return earlierPeriod(db, period).limit(1).get() === undefined;
}

/** `firstOnAccount` as a column of a query over `statement_periods`, correlated on the row's own account and start. */
export function firstOnAccountSql(
  db: AppDatabase,
  row: { accountId: SQLWrapper; periodStart: SQLWrapper },
): SQL<boolean> {
  return sql<boolean>`${not(exists(earlierPeriod(db, row)))}`.mapWith(Boolean);
}

function earlierPeriod(db: AppDatabase, row: { accountId: SQLWrapper | string; periodStart: SQLWrapper | string }) {
  // aliased, so the row's own `statement_periods` is never the one this asks about by accident
  const earlier = alias(statementPeriods, "earlier_period");
  return db
    .select({ one: sql`1` })
    .from(earlier)
    .where(and(eq(earlier.accountId, row.accountId), lt(earlier.periodStart, row.periodStart)));
}

/** Every account's statements (`countsAsStatement`), oldest first — the rows both statement panels read. */
export function statementsByAccount(db: AppDatabase): Map<string, StatementPeriodRef[]> {
  const rows = db
    .select({
      accountId: statementPeriods.accountId,
      start: statementPeriods.periodStart,
      end: statementPeriods.periodEnd,
      reconciliation: statementPeriods.reconciliation,
      parserProfile: importFiles.parserProfile,
    })
    .from(statementPeriods)
    // a left join: a period is never dropped for want of its file row — it is then read by its state alone
    .leftJoin(importFiles, eq(importFiles.id, statementPeriods.importFileId))
    .orderBy(asc(statementPeriods.periodStart), asc(statementPeriods.periodEnd))
    .all();
  const out = new Map<string, StatementPeriodRef[]>();
  for (const row of rows) {
    if (!countsAsStatement(row)) continue;
    out.set(row.accountId, [...(out.get(row.accountId) ?? []), { start: row.start, end: row.end }]);
  }
  return out;
}
