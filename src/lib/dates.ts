/**
 * Financial dates are 'YYYY-MM-DD' strings, bank-local, no time component
 * (schema.md). All math is UTC-epoch-day based so the host timezone can
 * never shift a posting date. Weeks are ISO (Monday start); a transaction
 * belongs to the period containing posted_on, full stop.
 */

export type BudgetPeriod = "daily" | "weekly" | "monthly" | "annual";

export class DateParseError extends Error {
  constructor(input: string) {
    super(`Invalid ISO date: "${input}"`);
    this.name = "DateParseError";
  }
}

/**
 * PARSING IS THE HOT PATH. Every date comparison in the app funnels through
 * toEpochDay, and the in-flight layer alone runs ~900,000 of them per
 * forecast (one curve scan per transfer leg). The obvious implementation —
 * regex, then a `new Date(Date.UTC(...))` round-trip to reject 2026-02-30 —
 * cost 535ns a call and made date parsing 92.7% of the dashboard's CPU.
 * These read digits straight off the string and do the calendar arithmetic
 * by hand: no regex, no split, no Date allocation, no garbage.
 */

const ISO_LENGTH = 10;
const DASH = 45; // '-'
const ZERO = 48; // '0'
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `len` ASCII digits at `at` as a number; -1 when any char is not 0-9. */
function digitsAt(s: string, at: number, len: number): number {
  let n = 0;
  for (let i = at; i < at + len; i++) {
    const c = s.charCodeAt(i) - ZERO;
    if (c < 0) return -1;
    if (c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}

function isLeapYear(y: number): boolean {
  if (y % 4 !== 0) return false;
  if (y % 100 !== 0) return true;
  return y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1]!;
}

/** How many days the month containing `s` has. */
export function daysInMonthOf(s: string): number {
  const [y, m] = parts(s);
  return daysInMonth(y, m);
}

/** True when `s` is the final day of its own month. */
export function isMonthEnd(s: string): boolean {
  const [, , d] = parts(s);
  return d === daysInMonthOf(s);
}

/**
 * `s` moved onto `day` of its own month, clamped into short months.
 *
 * The clamp is what lets a single integer 1..31 express "the last day of the
 * month": day 31 lands on the 28th in February and the 30th in April, which is
 * exactly a month-end schedule. See `deriveAnchorDay`.
 */
export function withDayOfMonth(s: string, day: number): string {
  const [y, m] = parts(s);
  const d = Math.min(Math.max(1, Math.trunc(day)), daysInMonth(y, m));
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/**
 * Howard Hinnant's days_from_civil. Shifting the year to begin in March moves
 * the leap day to the very end, which turns day-of-year into a closed form
 * and makes the whole conversion branch-free integer arithmetic.
 */
function daysFromCivil(y: number, m: number, d: number): number {
  const shifted = m <= 2 ? y - 1 : y;
  const era = Math.floor(shifted / 400);
  const yoe = shifted - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * ⚡ MEMOISED, and safely, because this is a PURE FUNCTION OF A STRING — there
 * is no invalidation question to get wrong, only a bound to choose.
 *
 * Measured on the owner's ledger with `--cpu-prof` over nine dashboard renders:
 * `dates.ts` was **14% of all active CPU** (`digitsAt` 458ms, `daysFromCivil`
 * 127ms, `parseEpochDay` 138ms), because every `compareDates`, `diffDays` and
 * `addDays` re-reads its arguments character by character and a sort re-reads
 * them O(n log n) times. A ledger of 10,111 rows spans a few thousand distinct
 * dates and asks about them over and over.
 *
 * The cap exists so a long-lived process cannot grow this without bound —
 * generated dates (a projection walking forward, a chart axis) are unbounded in
 * principle. Clearing wholesale rather than evicting one entry keeps it O(1)
 * and needs no ordering structure; at this size it happens rarely enough that
 * the amortised cost is nil.
 */
const EPOCH_DAY_CACHE = new Map<string, number | null>();
const EPOCH_DAY_CACHE_MAX = 8192;

function parseEpochDay(s: string): number | null {
  // ⛔ `undefined` means MISS and nothing else: the stored value is
  // `number | null`, so a cached "not a date" (null) is a hit like any other.
  const hit = EPOCH_DAY_CACHE.get(s);
  if (hit !== undefined) return hit;
  const parsed = parseEpochDayUncached(s);
  if (EPOCH_DAY_CACHE.size >= EPOCH_DAY_CACHE_MAX) EPOCH_DAY_CACHE.clear();
  EPOCH_DAY_CACHE.set(s, parsed);
  return parsed;
}

/**
 * The single place a date string is read. Returns the epoch day, or null when
 * `s` is not a real 'YYYY-MM-DD' calendar date — allocating nothing either way.
 */
function parseEpochDayUncached(s: string): number | null {
  if (s.length !== ISO_LENGTH) return null;
  if (s.charCodeAt(4) !== DASH) return null;
  if (s.charCodeAt(7) !== DASH) return null;
  const y = digitsAt(s, 0, 4);
  // 0000-0099 have never been valid here: the old round-trip built them with
  // Date.UTC, which maps years 0-99 into 1900-1999, so its own equality check
  // rejected them. isValidIsoDate guards user input in five server actions,
  // so that boundary is load-bearing — it stays exactly where it was.
  if (y < 100) return null;
  const m = digitsAt(s, 5, 2);
  if (m < 1 || m > 12) return null;
  const d = digitsAt(s, 8, 2);
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

export function isValidIsoDate(s: string): boolean {
  return parseEpochDay(s) !== null;
}

function parts(s: string): [number, number, number] {
  if (parseEpochDay(s) === null) throw new DateParseError(s);
  return [digitsAt(s, 0, 4), digitsAt(s, 5, 2), digitsAt(s, 8, 2)];
}

const MS_PER_DAY = 86_400_000;

export function toEpochDay(s: string): number {
  const day = parseEpochDay(s);
  if (day === null) throw new DateParseError(s);
  return day;
}

export function fromEpochDay(day: number): string {
  const date = new Date(day * MS_PER_DAY);
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(s: string, n: number): string {
  return fromEpochDay(toEpochDay(s) + n);
}

/** b − a in days. */
export function diffDays(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: string, b: string): number {
  return toEpochDay(a) - toEpochDay(b);
}

/**
 * `s` advanced by `months` calendar months, keeping the day-of-month and
 * CLAMPING it into the target month: 2026-01-31 +1 → 2026-02-28.
 *
 * ⚠️ Clamping is lossy, so this is only drift-free when called with the
 * ORIGINAL anchor and a total delta. Iterating it walks
 * 2026-01-31 → 02-28 → 03-28 and loses the 31st permanently, while
 * addCalendarMonths("2026-01-31", 2) is 2026-03-31. Every caller that walks a
 * schedule must therefore index off the anchor, never off the last result.
 *
 * Distinct from calendar-math.ts::addMonths, which takes a 'YYYY-MM' month key
 * and has no day to clamp.
 */
export function addCalendarMonths(s: string, months: number): string {
  const [y, m, d] = parts(s);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/**
 * The smallest n ≥ 0 for which `addCalendarMonths(anchor, n)` lands on or after
 * `boundary` — one arithmetic hop, not a walk, because a stale anchor can be
 * years behind.
 *
 * Exact without a correction loop: n₀ months puts the anchor inside boundary's
 * own month, and n₀−1 puts it in the month BEFORE boundary's, which is strictly
 * earlier than boundary whatever the clamping did. So only n₀ and n₀+1 can ever
 * be the answer.
 */
/**
 * Whole calendar months from `anchor`'s month to `boundary`'s, floored at 0.
 * Months only — the day within them is the caller's problem, because a caller
 * that clamps and a caller that re-days to a fixed anchor disagree about it.
 */
export function calendarMonthsBetween(anchor: string, boundary: string): number {
  const [ay, am] = parts(anchor);
  const [by, bm] = parts(boundary);
  return Math.max(0, (by - ay) * 12 + (bm - am));
}

export function calendarMonthsToReach(anchor: string, boundary: string): number {
  const n = calendarMonthsBetween(anchor, boundary);
  return compareDates(addCalendarMonths(anchor, n), boundary) >= 0 ? n : n + 1;
}

/** 0 = Monday … 6 = Sunday (ISO). */
export function isoWeekday(s: string): number {
  // epoch day 0 = 1970-01-01, a Thursday (ISO index 3)
  return (((toEpochDay(s) + 3) % 7) + 7) % 7;
}

export interface PeriodBounds {
  /** inclusive */
  start: string;
  /** inclusive */
  end: string;
}

export function periodBounds(date: string, period: BudgetPeriod): PeriodBounds {
  const [y, m] = parts(date);
  switch (period) {
    case "daily":
      return { start: date, end: date };
    case "weekly": {
      const start = addDays(date, -isoWeekday(date));
      return { start, end: addDays(start, 6) };
    }
    case "monthly": {
      const start = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
      const nextMonth = m === 12 ? `${(y + 1).toString().padStart(4, "0")}-01-01` : `${y.toString().padStart(4, "0")}-${(m + 1).toString().padStart(2, "0")}-01`;
      return { start, end: addDays(nextMonth, -1) };
    }
    case "annual":
      return { start: `${y.toString().padStart(4, "0")}-01-01`, end: `${y.toString().padStart(4, "0")}-12-31` };
  }
}

/** 'YYYY-MM' bucket key. */
export function monthKey(date: string): string {
  const [y, m] = parts(date);
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`;
}

/**
 * Today's date in the machine's local timezone (banks post in local days).
 * MONEYAPP_FAKE_TODAY (validated 'YYYY-MM-DD', ignored otherwise — never a
 * runtime throw) pins ONLY the zero-argument path, mirroring the
 * MONEYAPP_FAKE_PRICES idiom; an explicitly passed `now` always wins.
 *
 * SERVER-ONLY CONTRACT: never call todayIso() (or `new Date()` for a
 * rendering date) inside a 'use client' component. Next.js inlines only
 * NEXT_PUBLIC_* env vars into client bundles, so in the browser the
 * MONEYAPP_FAKE_TODAY branch is dead code and the real wall clock leaks
 * through — SSR (pinned) and hydration (real) disagree, e2e baselines drift
 * with the machine date. Clients receive dates as PROPS from a server
 * component (RSC serializes the pinned value as data across the boundary),
 * e.g. `<CalendarGrid today={todayIso()} …>` from the RSC parent.
 */
export function todayIso(now?: Date): string {
  if (now === undefined) {
    const fake = process.env.MONEYAPP_FAKE_TODAY;
    if (fake !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(fake)) return fake;
  }
  const clock = now ?? new Date();
  const y = clock.getFullYear().toString().padStart(4, "0");
  const m = (clock.getMonth() + 1).toString().padStart(2, "0");
  const d = clock.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}
