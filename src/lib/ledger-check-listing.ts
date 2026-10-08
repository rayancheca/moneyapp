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
