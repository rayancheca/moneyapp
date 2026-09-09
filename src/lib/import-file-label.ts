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
 * un-verifies an account. The page's own comment beside that trigger cites
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
