/**
 * A line `pnpm ledger-check` NAMES and fails nothing on — a read at two banks, a line left out that a session read on
 * its statement and acknowledged, an acknowledgement no line matches, the files read at a version their profile has
 * moved past, an account standing only on the opening of a statement he un-imported. Each is printed under its count
 * line in this one shape: two spaces, ⚠️ where it warns, its tag in brackets, its sentence (indented lines it carries
 * on to, a command to run, follow it).
 *
 * ⛔ One shape, two readers: ledger-check prints every such line through `listed`, and the pre-commit hook
 * (.githooks/pre-commit) prints the lines of this shape — each under its count line — when the check passes, and
 * nothing else of a passing run. 🔴 The hook threw a passing run's output away whole, so a listing showed only on a
 * manual run (the handoff of 2026-10-07, §6C): a read at two banks arriving between sessions was named to nobody.
 */
export function listed(tag: string, sentence: string, { warns = false }: { readonly warns?: boolean } = {}): string {
  return `  ${warns ? "⚠️ " : ""}[${tag}] ${sentence}`;
}

/*
 * The two sentences only ledger-check says — every other kind's is built beside its rule (`readAcrossBanksNotice`,
 * `lineLeftOutNotice`, `unmatchedAcknowledgementNotice`). Here, the one place the script prints them from and the
 * hook's test builds its lines with (scripts/pre-commit-hook.test.ts). 🔴 The script built them inline, so that test
 * stood for them with copies that drifted: no colon after the account, half the files' sentence (the handoff of
 * 2026-10-09, §6C).
 */

/** An account standing only on the opening of a statement he un-imported (`keptOpeningOf`), and the day it opened. */
export function keptOpeningNotice(accountName: string, day: string): string {
  return `${accountName}: stands only on the opening of a statement you un-imported (${day}) — unchecked, and no witness`;
}

/** A set of files by the first three names, and "…" past them. */
export function namedFiles(files: readonly { readonly fileName: string }[]): string {
  return `${files.slice(0, 3).map((f) => f.fileName).join(", ")}${files.length > 3 ? ", …" : ""}`;
}

/** The files read at a version their profile has moved past, and the guarded re-read that records what they print. */
export function beyondBackfillsNotice(files: readonly { readonly fileName: string }[]): string {
  return (
    `${files.length} of them were read at a version their profile has moved past (${namedFiles(files)}) — ` +
    "the backfills read a file only at the version that imported it, so they cannot cover these. " +
    "Un-importing any file whose rows one of them also prints loses those rows. " +
    "Re-read them at their profile's version (it refuses unless only the records change):\n" +
    "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger>             # rehearse on a copy, write nothing\n" +
    "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger> --confirm   # restore point, write, re-check"
  );
}
