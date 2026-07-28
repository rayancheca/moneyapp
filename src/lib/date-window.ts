import { compareDates, isValidIsoDate } from "./dates";

/**
 * The window every stored financial date must fall inside.
 *
 * A plain ISO check cannot tell a fat-fingered year from a real one: "1026" and
 * "9999" are both well-formed dates. Derivation turns the span between its
 * endpoints into ONE ROW PER DAY and rebuildAccount inserts those rows one at a
 * time, so a single typo'd year becomes hundreds of thousands of synchronous
 * writes against the owner's real database.
 *
 * The floor is the Unix epoch — the zero of this app's epoch-day math, and
 * older than any record a personal-finance app holds (the real ledger starts in
 * 2024). The ceiling is the end of this century: far enough that no legitimate
 * entry is ever rejected, near enough that a typo cannot escape. The widest
 * span the window allows is ~47,500 days, which SQLite absorbs in well under a
 * second.
 */
export const MIN_FINANCIAL_DATE = "1970-01-01";
export const MAX_FINANCIAL_DATE = "2099-12-31";

/** Typed so a caller can tell a bounds rejection from a parse failure. */
export class DateOutOfRangeError extends Error {
  constructor(field: string, value: string) {
    super(`${field} must be between ${MIN_FINANCIAL_DATE} and ${MAX_FINANCIAL_DATE} — got "${value}"`);
    this.name = "DateOutOfRangeError";
  }
}

/**
 * A real ISO date inside the window. Never throws on garbage, so it can chain
 * after an isValidIsoDate refinement — zod runs every refinement in a chain
 * even after an earlier one has failed.
 */
export function isWithinFinancialWindow(day: string): boolean {
  return (
    isValidIsoDate(day) &&
    compareDates(day, MIN_FINANCIAL_DATE) >= 0 &&
    compareDates(day, MAX_FINANCIAL_DATE) <= 0
  );
}

/**
 * Rejects loudly, naming the field. Never clamps an out-of-range date to a
 * valid one — that would invent a day the user never entered and derive a
 * curve the data never claimed.
 */
export function assertWithinFinancialWindow(field: string, day: string): void {
  if (!isWithinFinancialWindow(day)) throw new DateOutOfRangeError(field, day);
}

/** Message for a bounded date field in a zod schema. */
export function financialWindowMessage(field: string): string {
  return `${field} must be between ${MIN_FINANCIAL_DATE} and ${MAX_FINANCIAL_DATE}`;
}
