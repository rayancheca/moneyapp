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
 *     (derived_unverified/carried-basis) member day marks the whole rollup
 *     point estimated, so the chart draws it dashed;
 *   - a per-account day is `complete` only when it is a native, exact day
 *     (carry-forward filler always draws dashed — same convention as the
 *     account-detail chart).
 *
 * Sign conventions: balances arrive net-worth-signed (liabilities negative).
 * Liability lines flip to the positive "amount owed" frame (`owedFrame`) —
 * the same frame the account-detail page uses for cards.
 */

import { compareDates } from "./dates";

/** One account's daily balance point. `exact` = anchored/derived basis. */
export interface DailyBalancePoint {
  day: string;
  /** net-worth-signed integer cents (liabilities negative) */
  balanceCents: number;
  /** false for estimated bases (carried / derived_unverified) */
  exact: boolean;
}

export interface AccountSeriesInput {
  id: string;
  label: string;
  isLiability: boolean;
  /** oldest-first, gap-free, day-unique */
  points: readonly DailyBalancePoint[];
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
  /** false = estimated/partial — the chart draws it dashed */
  complete: boolean;
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
  const points = days.map((day, i) => {
    let sum = 0;
    let covered = 0;
    let allExact = true;
    for (const series of aligned) {
      const v = series[i] ?? null;
      if (v === null) continue;
      sum += v.valueCents;
      covered += 1;
      if (!v.exact) allExact = false;
    }
    return {
      day,
      valueCents: covered === 0 ? null : sign * sum,
      complete: covered === members.length && allExact,
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
