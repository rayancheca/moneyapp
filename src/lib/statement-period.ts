/**
 * The day a statement's row POSTED, as far as the statement itself can prove it.
 *
 * A statement lists the rows that posted inside its period — its own
 * `previous + activity = new` arithmetic counts every one of them — so a row
 * the statement dates outside that period is dated by something other than its
 * posting day. Chase and Discover card statements print only the transaction
 * day, and a charge made on the last day of a cycle posts after it closes: the
 * NEXT statement prints it, dated before that statement opens. Reconciliation
 * counts a row in whichever period its posted_on falls, so recorded on the
 * printed day it breaks both periods.
 *
 * The nearest edge is the only day the document supports: the row cannot have
 * posted before the period opened (the previous statement's arithmetic closed
 * without it) or after it closed. The printed day is kept by the caller as the
 * transaction day, which is what it is.
 *
 * ONE rule, two callers: the Discover statement parser and `importOneFile`.
 */
export function postedInsidePeriod(day: string, period: { readonly start: string; readonly end: string }): string {
  if (day < period.start) return period.start;
  if (day > period.end) return period.end;
  return day;
}
