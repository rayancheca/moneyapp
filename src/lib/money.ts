/**
 * Ledger money is INTEGER cents everywhere (schema.md global conventions).
 * Parsing is string math end to end — bank amounts never pass through floats.
 */

const AMOUNT_RE = /^([+-]?)\$?(\d{1,3}(?:,\d{3})*|\d*)(?:\.(\d+))?$/;

export class MoneyParseError extends Error {
  constructor(input: string) {
    super(`Cannot parse amount: "${input}"`);
    this.name = "MoneyParseError";
  }
}

/**
 * Parses bank-file amount strings to integer cents.
 * Accepts: "1234.56", "$1,234.56", "-43.64", "(43.64)", "($43.64)", "+12", ".5"
 * Parentheses mean negative (Robinhood/statement convention).
 * Fractions beyond 2 digits round half-away-from-zero.
 */
export function parseAmountToCents(input: string): number {
  let s = input.trim();
  if (s === "") throw new MoneyParseError(input);

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  const m = AMOUNT_RE.exec(s);
  if (!m) throw new MoneyParseError(input);
  // groups 1 and 2 always participate in a match (only group 3 is optional)
  const sign = m[1] as string;
  const intRaw = m[2] as string;
  const fracRaw = m[3];
  if (intRaw === "" && !fracRaw) throw new MoneyParseError(input);
  if (sign === "-") negative = !negative;

  const intPart = intRaw.replaceAll(",", "") || "0";
  const frac = fracRaw ?? "";
  const centsPart = (frac + "00").slice(0, 2);
  let cents = Number(intPart) * 100 + Number(centsPart);
  // round half away from zero on the third fractional digit
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;

  if (!Number.isSafeInteger(cents)) throw new MoneyParseError(input);
  // never return -0: "(0.00)" must equal 0 in every comparison and display
  return negative && cents !== 0 ? -cents : cents;
}

export function assertValidCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Invalid cents value: ${cents}`);
  }
}

export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertValidCents(v);
    total += v;
  }
  assertValidCents(total);
  return total;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** "$1,234.56" / "-$43.64". Display only — never parsed back. */
export function formatCents(cents: number): string {
  assertValidCents(cents);
  /*
   * 🔴 `-0` IS A NUMBER JAVASCRIPT KEEPS AND `Intl` PRINTS: `USD.format(-0)` is
   * "-$0.00". Measured on the owner's /accounts page 2026-09-02 — Chase
   * Sapphire, whose balance is exactly zero, rendered **"-$0.00"** because the
   * liability rows negate what they display and `-0 !== 0` only under
   * `Object.is`. There is no such amount as negative zero dollars, and the row
   * beside it printed a plain "$367.99", so one card said it owed nothing in a
   * different notation from every other figure on the page.
   *
   * ⛔ `+ 0` rather than `Math.abs`: this must normalise NEGATIVE ZERO and
   * nothing else. `Math.abs` would silently print a real debt as a credit.
   * `formatCentsSigned` already guards its own zero for the same reason.
   */
  return USD.format(cents / 100 + 0);
}

/** "+$120.00" for positive, "-$43.64" for negative, "$0.00" for zero — flow displays. */
export function formatCentsSigned(cents: number): string {
  const base = formatCents(Math.abs(cents));
  // Zero is not a gain. Every flow site already tones an exact zero neutral, so
  // a leading "+" on $0.00 is the only thing left claiming an increase happened.
  // (-0 takes this branch too, so it can never render as "-$0.00".)
  if (cents === 0) return base;
  return cents < 0 ? `-${base}` : `+${base}`;
}
