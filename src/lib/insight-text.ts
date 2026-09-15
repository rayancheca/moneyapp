/**
 * Fold away the Unicode a checker can be walked around.
 *
 * ⛔ Two of pass 46's 17 attack strings survived on character tricks alone. Its
 * digit scan was `/\d/` with no `u` flag, so `"used about ½ of its plan"`
 * contained no "digit" and passed; fullwidth forms and superscripts have the
 * same effect. NFKC folds `½` to `1⁄2`, `１０` to `10` and `²` to `2`, so a
 * spoofed figure becomes an ordinary one and then has to survive the same
 * equality check as any other.
 *
 * Whitespace is collapsed in the same pass because a template and a candidate
 * that differ only by a double space are the same sentence, and treating them
 * as different would reject honest text.
 *
 * 🔴 Its own module so BOTH checks can read it. It lived in
 * `insight-validator`, which imports `insight-grammar`, so the grammar's
 * import-time scan for "a template that states a figure of its own" could not
 * reach it without a cycle — and ran a bare `/\d/u` instead, which accepted
 * `½`, `１０` and `²` in a template (measured 2026-09-15).
 */
export function normalizeForCheck(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Does this text state a figure at all, in any script?
 *
 * Used for two things and never as an anti-fabrication guard: the grammar's
 * import-time refusal of a template that states a figure of its own, and the
 * validator's SHARPER REASON when wording is unknown. A digit scan is the
 * mistake that made pass 46 look guarded.
 *
 * 🔴 Folded first, then scanned for every decimal digit and numeric character
 * rather than `\d`. NFKC turns `½`, `１０` and `²` into ASCII but leaves "٣",
 * "३" and "৩" (three, in Arabic-Indic, Devanagari and Bengali) as they are, and
 * `/\d/u` matches only [0-9] — so a template stating its own figure in one of
 * those scripts still passed the import-time check (measured 2026-09-15). One
 * scan, so the two callers cannot disagree about what a figure is.
 */
export function containsFigure(text: string): boolean {
  return /[\p{Nd}\p{No}]/u.test(normalizeForCheck(text));
}
