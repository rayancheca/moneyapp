/**
 * WHICH file an import row is, when its name is not enough to say.
 *
 * 🔴 A DESTRUCTIVE BUTTON THAT CANNOT BE AIMED. `/imports` lists one row per
 * `import_files` record and identifies it by `file_name` alone — in the cell,
 * in the un-import trigger's accessible name, and in the confirmation's
 * headline. Names repeat: Chase regenerates statement bytes, so a
 * re-downloaded month imports as a SECOND row with a different sha, and a
 * re-parse at a new `parser_version` makes a third. Measured on the owner's
 * ledger 2026-09-09 — **112 of 330 rows share a name with another row, and 34
 * groups are identical in every visible column.**
 *
 * `20230810-statements-3522-.pdf` is three rows, and two of them render
 * character for character the same:
 *
 *     20230810-statements-3522-.pdf  chase-checking-statement-pdf  0  Parsed  un-import
 *     20230810-statements-3522-.pdf  chase-checking-statement-pdf  0  Parsed  un-import
 *
 * Their confirmations do not agree: one says "Recorded balances removed: 1
 * balance" — a statement balance that anchors the Chase Checking chain — and
 * the other "no balances". Two buttons, one accessible name, one of them
 * un-verifies an account. (Since 2026-09-16 a balance another statement still
 * prints is handed to it and not counted as removed, so on a copy of the ledger
 * that day all three read "no balances" — and the first still differs by the
 * one statement period it removes, until `statement_copies` records that the
 * other two print it and the first hands it and its 85 rows over.) The page's own comment beside that trigger cites
 * WCAG 2.5.3 and says the name "adds only which row it acts on"; with a
 * repeated name it does not say which row at all.
 *
 * ⛔ QUALIFY ONLY WHERE THE NAME REPEATS. 218 of the 330 rows are unique and
 * gain nothing from a date; the same rule the terrain's caption follows for its
 * blank accounts, and `asOfSpanTerm` for a group that really does share one
 * day. A qualifier on every row would be noise in the column that has to stay
 * scannable.
 *
 * ⚠️ The DAY, then the timestamp. Every collision on this ledger separates on
 * the import date alone (measured: 0 groups still collide), but two imports of
 * one name on one day is an ordinary thing to do and the fallback is what stops
 * this rule from having the defect it exists to fix.
 */

import type { ImportStatus } from "@/db/schema/imports";
import { dayWindowLabel } from "./period";

export interface ImportFileIdentity {
  id: string;
  fileName: string;
  /** ISO timestamp, e.g. "2026-08-05T20:28:48.430Z" */
  importedAt: string;
}

/** "2026-08-05" — the date half of an ISO timestamp, echoed if it is not one. */
function dayOf(importedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(importedAt) ? importedAt.slice(0, 10) : importedAt;
}

/** "2026-08-05 20:28" — the fallback when one day holds two of the same name. */
function minuteOf(importedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(importedAt)
    ? `${importedAt.slice(0, 10)} ${importedAt.slice(11, 16)}`
    : importedAt;
}

/**
 * How to tell each row apart, by id — null for every row whose name is already
 * unique in the list.
 *
 * The value is a bare stamp ("imported 2026-08-05"); the caller decides where
 * it goes and how it reads beside the name.
 */
export function importRowQualifiers(files: readonly ImportFileIdentity[]): Map<string, string | null> {
  const byName = new Map<string, ImportFileIdentity[]>();
  for (const f of files) {
    const group = byName.get(f.fileName);
    if (group === undefined) byName.set(f.fileName, [f]);
    else group.push(f);
  }

  const out = new Map<string, string | null>();
  for (const group of byName.values()) {
    if (group.length === 1) {
      out.set(group[0]!.id, null);
      continue;
    }
    // the day is enough unless this name was imported twice in one day
    const days = new Map<string, number>();
    for (const f of group) days.set(dayOf(f.importedAt), (days.get(dayOf(f.importedAt)) ?? 0) + 1);
    for (const f of group) {
      const day = dayOf(f.importedAt);
      out.set(f.id, `imported ${days.get(day)! > 1 ? minuteOf(f.importedAt) : day}`);
    }
  }
  return out;
}

/**
 * The name a control acts on — the file, plus its qualifier when the name alone
 * points at more than one row.
 *
 * ⛔ One phrasing for the trigger's accessible name and the confirmation's
 * headline. They are the same claim about the same row, read a second apart.
 */
export function importRowSubject(fileName: string, qualifier: string | null): string {
  return qualifier === null ? fileName : `${fileName} (${qualifier})`;
}

/**
 * A section of a parsed file that was NOT imported — what the import records, and what every reader reads back.
 *
 * ⛔ STORED AS FACTS, NOT AS A SENTENCE. A parsed file's `import_files.error` holds `recordWithheldSections` of these,
 * and nothing else (`settleMember`, services/import/service.ts); the sentence is built from them when it is read (`withheldNoticeOf`). Three
 * readers need the account and the window, not the words:
 *
 *  - `/imports` says which account's statement a file left out;
 *  - `statementGaps` must not call that window a file to fetch — a re-download is the same bytes, skipped as a
 *    duplicate, and fills nothing;
 *  - `scripts/robinhood-agentic-account.ts` must not read a WITHHELD section as one the import SKIPPED because the
 *    account did not exist yet — measured by a second reader on a copy of the real ledger, it refused an account that
 *    existed before the import and advised restoring the ledger, which re-imports the same refusal.
 *
 * A sentence in the column would have made each of those a parse of English.
 */
export interface WithheldSectionFacts {
  /** the tracked account the section belongs to; null only when no account at the institution carries its last4 */
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly last4: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** why, in plain words */
  readonly reason: string;
}

function accountPhrase(accountName: string | null, last4: string | null): string {
  const number = last4 === null ? null : `····${last4}`;
  if (accountName === null) return number === null ? "an account" : `the account ${number}`;
  return number === null ? accountName : `${accountName} ${number}`;
}

/**
 * The sentence a file carries for a section it did NOT import: which account, which statement, why — and what that
 * means for the account.
 *
 * ⛔ The consequence must stay true AFTER the account's next statement arrives, not only on the day of the import.
 * An unconditional "the account is not checked for those days" did not: measured by a second reader on a copy of the
 * real ledger, a withheld August whose balance did not move, then a September opening at that same balance, gave
 * Robinhood Agentic an opening anchor on Aug 31, 30 carried days, `verifiedThrough` 2026-09-30 and a green
 * ledger-check — the documented rule that an anchor on the far side of a hole closes it. The notice beside that
 * still said "not checked". What stays false either way is the activity: none of the section's rows are in.
 *
 * ⛔ It still names the consequence, in so many words. The file beside it reads parsed, the other accounts' months
 * are in, and statement lag is normal in this app — a notice that named the section but not the consequence would
 * leave the account reading as if its month had simply not arrived yet.
 */
/** What reads a withheld section later — the last sentence of every notice. */
export const WITHHELD_SECTION_PATH =
  "Importing the same file again changes nothing: the next statement parser version reads the section again, " +
  "and positions it proves go into the account's brokerage book, which the import creates.";

export function withheldSectionNotice(facts: WithheldSectionFacts): string {
  return (
    `Not imported: ${accountPhrase(facts.accountName, facts.last4)}'s statement for ` +
    `${dayWindowLabel(facts.periodStart, facts.periodEnd)} — ${facts.reason}. ` +
    "Nothing from that section is in the ledger: the activity it lists is missing, and the account is not checked " +
    "for those days unless a later statement's opening balance closes to the cent across them. " +
    // ⛔ the PATH, because the obvious one does not work: the same bytes at the same parser version are skipped as a
    // duplicate. A version bump re-reads the file, and a section that then proves positions is written to the cash
    // account's brokerage book, which the import creates itself (services/import/brokerage-book.ts)
    WITHHELD_SECTION_PATH
  );
}

/** The `import_files.error` a parsed file carries for what it withheld — facts only, see `WithheldSectionFacts`. */
export function recordWithheldSections(sections: readonly WithheldSectionFacts[]): string {
  return JSON.stringify({
    withheld: sections.map(({ accountId, accountName, last4, periodStart, periodEnd, reason }) => ({
      accountId,
      accountName,
      last4,
      periodStart,
      periodEnd,
      reason,
    })),
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

function isWithheldSectionFacts(v: unknown): v is WithheldSectionFacts {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isNullableString(r.accountId) &&
    isNullableString(r.accountName) &&
    isNullableString(r.last4) &&
    typeof r.periodStart === "string" &&
    ISO_DAY.test(r.periodStart) &&
    typeof r.periodEnd === "string" &&
    ISO_DAY.test(r.periodEnd) &&
    typeof r.reason === "string"
  );
}

/**
 * The sections an import row withheld — empty for every row that withheld nothing.
 *
 * Only a `parsed` file's: the import writes `error` on a parsed file for nothing else, a failed file's error is why
 * it failed, and a superseded file's contribution has left the ledger. ⛔ A value that is not a whole record reads as
 * NO sections, never as some of them: a reader that acts on a window must not act on half of one.
 */
export function withheldSectionsOf(file: { readonly status: ImportStatus; readonly error: string | null }): WithheldSectionFacts[] {
  if (file.status !== "parsed" || file.error === null || !file.error.startsWith('{"withheld":')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.error);
  } catch {
    return [];
  }
  const sections = (parsed as { withheld?: unknown }).withheld;
  return Array.isArray(sections) && sections.every(isWithheldSectionFacts) ? sections : [];
}

/**
 * The withheld-section notice an import row carries, or null.
 *
 * ⚠️ A parsed file whose `error` is not a record is shown as it is rather than hidden: whatever wrote it, a parsed
 * row with something to say must not read as plain "Parsed".
 */
export function withheldNoticeOf(file: { readonly status: ImportStatus; readonly error: string | null }): string | null {
  if (file.status !== "parsed" || file.error === null) return null;
  const sections = withheldSectionsOf(file);
  return sections.length === 0 ? file.error : sections.map(withheldSectionNotice).join(" ");
}
