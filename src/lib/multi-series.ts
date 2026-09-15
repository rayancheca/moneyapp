/**
 * Multi-series builders for the dashboard net-worth chart's view modes
 * (pass-17 ask C): combined / assets-only / liabilities-only / split /
 * per-account layered lines. Pure and DB-free — callers feed each account's
 * gap-free daily balances (services/derivation.ts `accountSeries` shape) and
 * get chart-ready aligned series back.
 *
 * Alignment semantics MIRROR derivation.ts `netWorthSeries` exactly:
 *   - the day axis is the union of the shown accounts' actual balance days;
 *   - an account is honestly ABSENT before its first known day (null — never a
 *     fabricated zero), so early history stays "partial";
 *   - after a known day the balance CARRIES FORWARD (an account whose latest
 *     statement predates a fresher one has not vanished).
 *
 * Honesty flags:
 *   - a rollup day is `complete` only when EVERY member account is covered
 *     (natively or carried) AND every covering value is exact — an estimated
 *     member day (`balanceDayIsExact` false: a replay nobody checks, or an
 *     investment's carried price) marks the whole rollup point estimated, so
 *     the chart draws it dashed;
 *   - a per-account day is `complete` only when it is a native, exact day
 *     (carry-forward filler always draws dashed — same convention as the
 *     account-detail chart).
 *
 * Sign conventions: balances arrive net-worth-signed (liabilities negative).
 * Liability lines flip to the positive "amount owed" frame (`owedFrame`) —
 * the same frame the account-detail page uses for cards.
 */

import { compareDates } from "./dates";
import { splitMissing } from "./coverage-label";

/** One account's daily balance point. */
export interface DailyBalancePoint {
  day: string;
  /** net-worth-signed integer cents (liabilities negative) */
  balanceCents: number;
  /** `balanceDayIsExact` (services/coverage): false for a replay nobody checks
   *  and for an investment's carried price — never for a cash account's
   *  `carried` day, which is as proven as the balance it rests on */
  exact: boolean;
}

export interface AccountSeriesInput {
  id: string;
  label: string;
  isLiability: boolean;
  /** oldest-first, gap-free, day-unique */
  points: readonly DailyBalancePoint[];
  /**
   * The ledger holds rows for this account at all — `splitMissing`'s third
   * question, and the one that separates an EMPTY account from a hole.
   *
   * ⛔ REQUIRED. Optional would leave exactly the hole it closes: a caller that
   * forgets gets `undefined`, `hasHistory === false` never matches, and the
   * account falls back into `gapAccounts` — which is the defect below.
   */
  hasHistory: boolean;
}

/** An aligned per-day value: null before the account's first known day. */
export interface AlignedValue {
  valueCents: number;
  /** the SOURCE day's exactness (a carried value keeps its source's flag) */
  exact: boolean;
  /** true when this day is filled from an earlier day, not a native point */
  carried: boolean;
}

export type DashboardMode = "combined" | "assets" | "liabilities" | "split" | "accounts";

export interface DashboardSeriesPoint {
  day: string;
  /** null = no shown account covers this day (a hard line break) */
  valueCents: number | null;
  /**
   * false = estimated/partial — the chart draws it dashed.
   *
   * ⚠️ For a rollup this conflates TWO things: not every member is covered, AND
   * at least one covered member is an estimate. That is right for a dashed
   * line and wrong for a percentage, which only cares about the first. The
   * coverage fields below separate them; do not repurpose `complete`.
   */
  complete: boolean;
  /** covered member names, parallel to `coveredCents` (rollups only) */
  coveredAccountNames?: string[];
  /** each covered member's own signed value, parallel to the names */
  coveredCents?: number[];
  /** members whose own history has not started on this day — not a hole */
  notYetOpen?: { name: string; opensOn: string }[];
  /** members already open on this day that nothing covers — a real hole */
  gapAccounts?: string[];
  /** members the ledger holds nothing for at all — not a hole, see `splitMissing` */
  emptyAccounts?: string[];
  /** how many members this rollup sums when every one is covered */
  totalAccounts?: number;
}

export interface DashboardSeries {
  key: string;
  label: string;
  /** true when values are in the positive "amount owed" frame */
  owedFrame: boolean;
  points: DashboardSeriesPoint[];
}

export interface BuildOptions {
  mode: DashboardMode;
  /** mode "accounts": which accounts draw their own line (input order wins) */
  accountIds?: readonly string[];
}

/** Sorted unique union of every input account's balance days. */
export function unionDays(inputs: readonly AccountSeriesInput[]): string[] {
  const set = new Set<string>();
  for (const input of inputs) for (const p of input.points) set.add(p.day);
  return [...set].sort((a, b) => compareDates(a, b));
}

/**
 * Align one account's points over a day axis: null before its first known day,
 * native values on their own days, trailing carry-forward everywhere after.
 */
export function alignOverDays(
  points: readonly DailyBalancePoint[],
  days: readonly string[],
): (AlignedValue | null)[] {
  const byDay = new Map(points.map((p) => [p.day, p] as const));
  const firstDay = points[0]?.day ?? null;
  let last: DailyBalancePoint | null = null;
  return days.map((day) => {
    const native = byDay.get(day);
    if (native) {
      last = native;
      return { valueCents: native.balanceCents, exact: native.exact, carried: false };
    }
    if (firstDay === null || compareDates(day, firstDay) < 0 || last === null) return null;
    return { valueCents: last.balanceCents, exact: last.exact, carried: true };
  });
}

/** Sum a group of aligned accounts into one rollup line over a shared axis. */
function rollupLine(
  key: string,
  label: string,
  members: readonly AccountSeriesInput[],
  days: readonly string[],
  sign: 1 | -1,
): DashboardSeries {
  const aligned = members.map((m) => alignOverDays(m.points, days));
  // each member's own first day, so an uncovered day can say WHY it is uncovered
  const opensOn = members.map((m) => m.points[0]?.day ?? null);
  const points = days.map((day, i) => {
    let sum = 0;
    let allExact = true;
    const coveredAccountNames: string[] = [];
    const coveredCents: number[] = [];
    const missing: { name: string; opensOn: string | null; hasHistory: boolean }[] = [];
    for (let m = 0; m < aligned.length; m++) {
      const member = members[m]!;
      const v = aligned[m]![i] ?? null;
      if (v === null) {
        missing.push({ name: member.label, opensOn: opensOn[m] ?? null, hasHistory: member.hasHistory });
        continue;
      }
      sum += v.valueCents;
      coveredAccountNames.push(member.label);
      coveredCents.push(sign * v.valueCents);
      if (!v.exact) allExact = false;
    }
    /*
     * 🔴 THREE BUCKETS, and this had two. `splitMissing` is the app's rule for
     * why an account is missing from a day, and its docstring names the very
     * account this re-derivation broke on: "`Capital One 360 Checking` holds
     * zero rows and zero balances, so it has no `opensOn`, so it fell through
     * to `gapAccounts` on all 1,464 days of the live series." That was fixed in
     * `derivation`, which passes `hasHistory` and gets an EMPTY bucket back —
     * and this second implementation of the same question kept the old answer.
     *
     * Measured on the owner's dashboard 2026-09-10. The permanent gap made
     * `sharedCoverageChange` bail before it could compare like with like, so
     * `?chart=assets` fell back to the raw endpoint difference over two
     * different account populations and printed, with no percentage and no
     * scope note:
     *
     *     ▲ +$47,478.87 · Assets · 1Y
     *
     * The 1Y start (2025-09-10) covers five asset accounts totalling
     * $67,020.10; today's $114,498.97 covers eight. $39,002.67 of that
     * "growth" is Robinhood Crypto, Wells Fargo and Cash on Hand OPENING.
     * Like-for-like the answer is +$8,476.20 — which is what makes the same
     * switcher close: Net worth reads "+$8,434.38 (+12.7% excl. Robinhood
     * Crypto, Venture X +2 more)" and Owed "+$41.82", and
     * 8,476.20 − 41.82 = 8,434.38 to the cent. Against the old figure,
     * 47,478.87 − 41.82 ≠ 8,434.38: assets − owed did not equal net worth on
     * one screen.
     *
     * ⛔ Net worth escaped because it never took this path — `derivation`
     * builds it and passes `hasHistory`. Owed escaped because no liability
     * account is empty. This is one rule with one caller, and the second
     * caller was the one on screen.
     */
    const { notYetOpen, gapAccounts, emptyAccounts } = splitMissing(day, missing);
    const covered = coveredAccountNames.length;
    return {
      day,
      valueCents: covered === 0 ? null : sign * sum,
      /*
       * ⛔ An EMPTY account does not make a day incomplete — there is nothing
       * for it to cover. `derivation` says the same thing about the same
       * account: counting them left ZERO of 1,464 days `complete`.
       */
      complete: covered === members.length - emptyAccounts.length && allExact,
      coveredAccountNames,
      coveredCents,
      notYetOpen,
      gapAccounts,
      emptyAccounts,
      totalAccounts: members.length,
    };
  });
  return { key, label, owedFrame: sign === -1, points };
}

/** One account's own line (its native + carried days only — no pre-history). */
function accountLine(input: AccountSeriesInput, days: readonly string[]): DashboardSeries {
  const sign = input.isLiability ? -1 : 1;
  const aligned = alignOverDays(input.points, days);
  const points: DashboardSeriesPoint[] = [];
  for (let i = 0; i < days.length; i++) {
    const v = aligned[i]!;
    if (v === null) continue; // the line simply starts at the account's first day
    points.push({ day: days[i]!, valueCents: sign * v.valueCents, complete: v.exact && !v.carried });
  }
  return { key: input.id, label: input.label, owedFrame: input.isLiability, points };
}

/**
 * The mode → series composer. Returns chart-ready series over a SHARED axis
 * (the union of all inputs' days), so toggling modes never shifts the x-domain.
 */
export function buildDashboardSeries(
  inputs: readonly AccountSeriesInput[],
  options: BuildOptions,
): DashboardSeries[] {
  const days = unionDays(inputs);
  if (days.length === 0) return [];
  const assets = inputs.filter((a) => !a.isLiability);
  const liabilities = inputs.filter((a) => a.isLiability);

  switch (options.mode) {
    case "combined":
      return [rollupLine("net", "Net worth", inputs, days, 1)];
    case "assets":
      return assets.length === 0 ? [] : [rollupLine("assets", "Assets", assets, days, 1)];
    case "liabilities":
      return liabilities.length === 0
        ? []
        : [rollupLine("liabilities", "Amount owed", liabilities, days, -1)];
    case "split": {
      const out: DashboardSeries[] = [];
      if (assets.length > 0) out.push(rollupLine("assets", "Assets", assets, days, 1));
      if (liabilities.length > 0) out.push(rollupLine("liabilities", "Amount owed", liabilities, days, -1));
      return out;
    }
    case "accounts": {
      const wanted = new Set(options.accountIds ?? []);
      return inputs.filter((a) => wanted.has(a.id)).map((a) => accountLine(a, days));
    }
  }
}
