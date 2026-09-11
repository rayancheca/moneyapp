/**
 * A stored INSTANT as a sentence, on the reader's own clock.
 *
 * ⛔ Deliberately NOT in `format-date`, whose docstring forbids exactly this:
 * "never Date/locale, which varies by host and can shift a day across
 * timezones". That rule is right for a DAY — a day is a calendar fact and must
 * render identically everywhere. An instant is the opposite: it is a point on
 * the world's timeline, and the only honest way to show one is in the zone of
 * whoever is reading it. The two must not share a module, or the next author
 * takes the wrong half of the rule.
 *
 * 🔴 TWO DEFECTS IN ONE SPAN. `/transactions`' header printed
 * `lastRun.at.slice(0, 16).replace("T", " ")`:
 *
 *     was   Last Claude run: 92 transactions classified, 50 flagged for
 *           review · $0.03 · 2026-08-18 16:06
 *     now   … · Tue, Aug 18, 2026 at 12:06
 *
 *   1. FORMAT — a machine timestamp mid-sentence, where /settings' backups list
 *      already says "Tue, Aug 18, 2026 at 12:06" for the same kind of fact.
 *   2. VALUE — the stored `at` is `new Date().toISOString()`, always UTC with a
 *      Z (claude-categorize.ts:323). Slicing it prints UTC and drops the Z, so
 *      the page claimed 16:06 for a run that happened at 12:06 on the owner's
 *      clock. Wrong by the host's offset on every render, and unfalsifiable
 *      from the page because nothing said which zone it meant.
 *
 * The repo already documents this trap and neither header read it —
 * `intraday-axis.ts`'s `sessionDayOf`: "Not the same as `at.slice(0, 10)`:
 * 2026-07-31T00:00:00Z is July 30th in New York", and `SESSION_TZ_LABEL`:
 * "a time with no zone is a half-truth".
 */

import { formatDayLong } from "./format-date";
import { todayIso } from "./dates";

/**
 * Epoch milliseconds → "Tue, Aug 18, 2026 at 12:06", in the host's zone.
 * `null` (or an unparseable instant) → `unknownLabel`, never "Invalid Date".
 */
export function formatInstantLong(atMs: number | null, unknownLabel = "time unknown"): string {
  if (atMs === null || !Number.isFinite(atMs)) return unknownLabel;
  const at = new Date(atMs);
  const hh = at.getHours().toString().padStart(2, "0");
  const mm = at.getMinutes().toString().padStart(2, "0");
  return `${formatDayLong(todayIso(at))} at ${hh}:${mm}`;
}

/** The same, from a stored ISO instant string. A malformed one is not a time. */
export function formatIsoInstantLong(at: string | null | undefined, unknownLabel = "time unknown"): string {
  if (at === null || at === undefined) return unknownLabel;
  return formatInstantLong(Date.parse(at), unknownLabel);
}
