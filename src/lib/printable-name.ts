/**
 * Whether a name out of the ledger can be printed inside a sentence.
 *
 * ⛔ This exists because of a live crash, not a hypothetical. `claude-categorize`
 * wrote a merchant whose canonical name is literally `<UNKNOWN>`, four
 * transactions hang off it, and `/merchants/019f4ccc…` rendered the error
 * boundary instead of a page: `insight-facts` refuses `< > { } \` in a label and
 * throws, and nothing between the fact constructor and the route caught it.
 *
 * ## Why those characters, and why a refusal rather than an escape
 *
 * `{` and `}` are the real hazard. A sentence is re-parsed by the READ gate
 * against the template it claims to come from, and a subject containing
 * `{{a.value}}` would be re-read as a SLOT rather than as text — a name that
 * could rewrite the sentence it appears in. `<` and `>` are belt-and-braces
 * (React escapes text nodes, so they are not an injection today) and `\` is
 * there because it is the escape character of every layer this text passes
 * through. Anything else — commas, quotes, ampersands, digits — is a real part
 * of real merchant names and is allowed.
 *
 * ## Two boundaries, and they are not the same boundary
 *
 * - A name a PERSON or a MODEL chose is rejected at the write, the way
 *   `category-edit` rejects `,` and `>`: one guard at the boundary makes the
 *   property true everywhere instead of at each place that happens to print it.
 * - A name a BANK printed cannot be rejected — the ledger does not get to
 *   refuse a statement — so the surfaces that would speak about it decline
 *   instead. `isPrintableName` is what they ask.
 *
 * The predicate lives here rather than in `insight-facts` so that the write
 * boundaries (`renameMerchant`, `accountInputSchema`, `claude-categorize`) can
 * enforce it without importing the insight vocabulary to do it.
 */

/**
 * The characters that stop a name being printable.
 *
 * ⚠️ Deliberately NOT a `/g` regex: a global regex carries `lastIndex` between
 * calls, so `test()` on the same instance alternates true and false for the
 * same input. That is a bug this file would hand to every caller.
 */
export const UNPRINTABLE_NAME_CHARS = /[<>{}\\]/u;

/** Can this name appear, verbatim, inside a sentence the app writes? */
export function isPrintableName(value: string): boolean {
  return value.trim() !== "" && !UNPRINTABLE_NAME_CHARS.test(value);
}

/**
 * The same question as a throw, for the write boundaries.
 *
 * `what` names the field so the message tells whoever hits it which input to
 * change — "Merchant name", "Account name" — rather than restating the rule.
 */
export function assertPrintableName(what: string, value: string): void {
  if (value.trim() === "") throw new Error(`${what} cannot be empty`);
  if (UNPRINTABLE_NAME_CHARS.test(value)) {
    throw new Error(`${what} cannot contain < > { } or a backslash: ${JSON.stringify(value)}`);
  }
}
