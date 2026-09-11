/**
 * Honest, concise phrasing for a partial-coverage day on the net-worth chart.
 *
 * A partial day (not every active account has data) was previously always
 * annotated with the *missing* accounts — but early in the history only one or
 * two accounts existed, so a 2022 point listed seven missing accounts as noise.
 * When far fewer accounts are covered than missing, naming the covered ones
 * ("only Chase ····3522") is clearer and shorter; otherwise name the missing
 * ones ("no Robinhood Crypto, Venture X"). Pure presentation logic, shared by
 * the tooltip, the chart header, the hero, and the aria description.
 *
 * TWO CAUSES, NOT ONE. "Partial" fired on 1,440 of the ledger's 1,443 days, and
 * a warning that fires on 99.79% of a chart is decoration. The data already
 * distinguishes the causes and they are not the same fact:
 *  - PRE-START — the account had not opened yet. Nine accounts, ~1,440 days.
 *    Nothing is lost, so the words are "open"/"opens" (never "missing") and the
 *    tone is neutral.
 *  - INTERIOR GAP — a day inside the account's life that no statement covers.
 *    Exactly Discover, 89 days. That IS a hole, and it keeps the warning.
 * `splitMissing` is the one rule that classifies them, `kind` is the one word
 * every surface renders, and `sharedCoverageChange` is the one rule for which
 * accounts a percentage may compare — so the chip, the header, the hero and the
 * aria description cannot drift apart.
 */

import { compareDates } from "./dates";
import { formatDayFull } from "./format-date";

/** "SoFi Savings, Discover" or "SoFi Savings, Discover +2 more" — a compact, capped list. */
export function formatNameList(names: readonly string[], max = 2): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

/** An account that had not opened yet, and the day its own history starts. */
export interface AccountOpening {
  name: string;
  /** 'YYYY-MM-DD' — the first day this account's balances cover */
  opensOn: string;
}

/** One uncovered account, with the day its history starts (null = never covered). */
export interface MissingAccount {
  name: string;
  opensOn: string | null;
  /**
   * Has this account EVER held a row or a balance, anywhere in its history?
   *
   * ⛔ Optional so existing callers keep the old behaviour, but supplying it is
   * what separates an empty shelf from a hole. An account with `opensOn: null`
   * was previously always a gap — "claiming it opens would need a date nobody
   * has" — and that is right for an account holding rows the ledger cannot
   * place, and wrong for one holding nothing at all. Nothing is missing from an
   * account that has never had anything.
   */
  hasHistory?: boolean;
}

export interface CoverageLabel {
  /** the display verb — canonical across EVERY surface (chip, header, hero, aria)
   *  so the wording can't drift: "only" names the few covered accounts,
   *  "missing" names the (fewer) uncovered ones, "opened" names the accounts
   *  whose own history has not started yet. It decides TONE as much as words:
   *  "opened"/"only" are not defects and must render neutral. Print with
   *  `coveragePhrase`, never by hand. */
  kind: "only" | "missing" | "opened";
  /** the capped, formatted name list ("opened" carries the dates too) */
  text: string;
}

/**
 * Choose the most concise honest phrasing for a partial day. Returns null when
 * there is nothing to say (the day is fully covered). Ties and "few missing"
 * both keep the default direction (name the missing). The returned `kind` is the
 * literal word to render, so all surfaces stay word-for-word consistent.
 */
export function coverageLabel(
  covered: readonly string[],
  missing: readonly string[],
  max = 2,
): CoverageLabel | null {
  if (missing.length === 0) return null;
  if (covered.length > 0 && covered.length < missing.length) {
    return { kind: "only", text: formatNameList(covered, max) };
  }
  return { kind: "missing", text: formatNameList(missing, max) };
}

/**
 * The exact words a surface prints for a label. Two kinds read as `{kind} {text}`
 * ("only Chase ····3522"); "opened" already carries its own verb, because a date
 * cannot follow a bare one. ONE function so no surface phrases it by hand.
 */
export function coveragePhrase(label: CoverageLabel): string {
  return label.kind === "opened" ? label.text : `${label.kind} ${label.text}`;
}

/**
 * "Aug 3, 2026" — the sentence spelling. An opening date is read against
 * a day that can be years away ("opens Aug 3" on a 2022 point is ambiguous), and
 * `formatDayFull` owns the spelling and the validation both.
 */
function formatOpenDay(day: string): string {
  return formatDayFull(day);
}

/** "Cash on Hand opens Aug 3, 2026" — soonest first, capped like formatNameList. */
function formatOpenings(pending: readonly AccountOpening[], max: number): string {
  const soonest = [...pending].sort((a, b) => compareDates(a.opensOn, b.opensOn));
  const shown = soonest.slice(0, max).map((p) => `${p.name} opens ${formatOpenDay(p.opensOn)}`);
  const rest = soonest.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/**
 * The PRE-START phrasing: on this day these accounts simply had not opened yet.
 * Same "name the shorter side" rule as coverageLabel — early in the history nine
 * opening dates are noise next to "only Chase ····3522" — but when few accounts
 * are still to come, each is named with the day its own history starts, which is
 * the fact that answers "why isn't everything here?".
 */
export function openingLabel(
  open: readonly string[],
  notYetOpen: readonly AccountOpening[],
  max = 2,
): CoverageLabel | null {
  const shorter = coverageLabel(open, notYetOpen.map((p) => p.name), max);
  if (!shorter || shorter.kind === "only") return shorter;
  return { kind: "opened", text: formatOpenings(notYetOpen, max) };
}

/**
 * Split a day's uncovered accounts by CAUSE, because the three read differently:
 * an account that had not opened yet is calendar fact, one that is empty is an
 * absence of anything at all, and only the third — open, with history, and no
 * balance today — is a hole worth a warning.
 *
 * 🔴 The empty bucket is not a refinement; it was a false alarm firing on EVERY
 * day. `Capital One 360 Checking` holds zero rows and zero balances, so it has
 * no `opensOn`, so it fell through to `gapAccounts` on all 1,464 days of the
 * live series: the dashboard published "no statement for Capital One 360
 * Checking on this date" in the warning tone every single day, and not one day
 * of the chart could be `complete`. That is exactly the failure this function
 * was written to prevent, reintroduced by an account with nothing in it.
 *
 * ⚠️ `opensOn: null` ALONE still means a hole. An account with rows the ledger
 * cannot place is money a total cannot see, and claiming it "opens" would need
 * a date nobody has. Only `hasHistory === false` moves it — the same
 * empty-versus-hole line `provenance` draws.
 */
export function splitMissing(
  day: string,
  missing: readonly MissingAccount[],
): { notYetOpen: AccountOpening[]; gapAccounts: string[]; emptyAccounts: string[] } {
  const notYetOpen: AccountOpening[] = [];
  const gapAccounts: string[] = [];
  const emptyAccounts: string[] = [];
  for (const m of missing) {
    if (m.opensOn !== null && compareDates(day, m.opensOn) < 0) {
      notYetOpen.push({ name: m.name, opensOn: m.opensOn });
    } else if (m.opensOn === null && m.hasHistory === false) {
      emptyAccounts.push(m.name);
    } else {
      gapAccounts.push(m.name);
    }
  }
  return { notYetOpen, gapAccounts, emptyAccounts };
}

/**
 * "3 of 11 accounts were open" — how many of the accounts the ledger can speak
 * for had opened by this day.
 *
 * 🔴 IT COUNTED AN ACCOUNT WITH NO HISTORY AS OPEN. Both surfaces that print
 * this built it as `totalAccounts - notYetOpen.length`, and `splitMissing`
 * routes an account holding no rows and no balances to a THIRD bucket —
 * neither open nor missing, because there is nothing to cover. So the empty one
 * fell through into the open count. Measured on the owner's ledger 2026-09-09,
 * on every one of the **1,440 days that render this clause**:
 *
 *     2023-10-15   "3 of 12 accounts were open"   covered 2, and no gaps
 *     2024-03-01   "6 of 12 accounts were open"   covered 5, and no gaps
 *     2025-06-01   "8 of 12 accounts were open"   covered 7, and no gaps
 *
 * One more open than the total is built from, every day, with the gap clause —
 * the half that exists to explain a shortfall — correctly silent, because there
 * is no hole. `Capital One 360 Checking` is the account: active, zero rows,
 * zero balances.
 *
 * ⛔ THE DENOMINATOR IS THE COMPLETENESS RULE'S OWN. `netWorthSeries` calls a
 * day complete when `covered.size === activeIds.length - emptyAccounts.length`,
 * so subtracting the empties from both sides is not a new opinion — it is the
 * arithmetic the same module already grades the day by. The numerator then
 * equals `coveredAccounts` on every day with no interior gap.
 *
 * ⚠️ …and the missing account is NAMED rather than quietly dropped, or a reader
 * who counts twelve on `/accounts` is handed an eleven with no explanation.
 * `emptyAccounts`' own docstring asks for exactly this: "Named so a surface CAN
 * mention them."
 */
export function openAccountsPhrase(
  input: { totalAccounts: number; notYetOpenCount: number; emptyCount: number },
  /** the chart speaks about a scrubbed day in the past; the hero about the day it shows */
  verb: "open" | "were open" = "open",
): string | null {
  if (input.notYetOpenCount <= 0) return null;
  const knowable = input.totalAccounts - input.emptyCount;
  const open = knowable - input.notYetOpenCount;
  // present tense on purpose: an account that holds nothing holds nothing on
  // every day of the series, whichever day the sentence is about
  const empty =
    input.emptyCount === 0
      ? ""
      : `, and ${input.emptyCount} ${input.emptyCount === 1 ? "holds" : "hold"} nothing at all`;
  return `${open} of ${knowable} account${knowable === 1 ? "" : "s"} ${verb}${empty}`;
}

/**
 * One day's coverage, as the chart carries it. Every field is optional because
 * the portfolio/holding charts carry none of it — and a series with no detail
 * keeps the old, blunt suppression rather than guessing.
 */
export interface DayCoverage {
  complete?: boolean;
  /** covered account names, parallel to `coveredCents` */
  coveredAccountNames?: readonly string[];
  /** each covered account's own balance, parallel to `coveredAccountNames` */
  coveredCents?: readonly number[];
  /** accounts already open on this day that no statement covers — a real hole */
  gapAccounts?: readonly string[];
  /** accounts whose history starts later — not a hole */
  notYetOpen?: readonly AccountOpening[];
  totalAccounts?: number;
}

/** A window endpoint: its (bridged) total and the coverage behind it. */
export interface CoverageEndpoint {
  cents: number;
  coverage: DayCoverage;
}

export interface SharedChange {
  /** the honest percentage, or null when no honest one exists */
  pct: number | null;
  /** what the percentage was measured over, when that is NOT every account —
   *  "excl. Cash on Hand, opened Aug 3, 2026". Never null while an endpoint is
   *  partial, so the number can never be read as total net worth having moved. */
  scope: string | null;
  /**
   * The dollar change over the SAME accounts as `pct`.
   *
   * A caller that prints a percentage must print this beside it, not the raw
   * all-account delta: those two describe different sets, so a reader who
   * divides one by the other gets a third number that is true of nothing. That
   * is the same class of fabricated figure the old suppress-entirely rule
   * existed to prevent — moved from the percentage into the pairing.
   *
   * Null exactly when `pct` is null.
   */
  deltaCents: number | null;
}

/** No honest comparison exists — every field null together. */
const NO_CHANGE: SharedChange = { pct: null, scope: null, deltaCents: null };

function pctChange(startCents: number, endCents: number): number | null {
  if (startCents === 0) return null;
  return ((endCents - startCents) / Math.abs(startCents)) * 100;
}

/** name → that account's own balance; null when the series carries no detail. */
function centsByName(coverage: DayCoverage): Map<string, number> | null {
  const { coveredAccountNames: names, coveredCents: cents } = coverage;
  if (!names || !cents || names.length !== cents.length) return null;
  // two accounts sharing a display name collapse here; they already share every
  // other readout in this file, so the label was ambiguous long before the math
  return new Map(names.map((name, i) => [name, cents[i]!] as const));
}

function hasGap(coverage: DayCoverage): boolean {
  return (coverage.gapAccounts?.length ?? 0) > 0;
}

function openingDay(name: string, ...ends: readonly DayCoverage[]): string | null {
  for (const c of ends) {
    const found = c.notYetOpen?.find((p) => p.name === name);
    if (found) return found.opensOn;
  }
  return null;
}

/**
 * The percentage between two window endpoints, measured over the accounts BOTH
 * ends actually cover.
 *
 * The rule this replaces suppressed the % unless both endpoints were complete.
 * That was right about the danger and wrong about the cost: since a $1,800 cash
 * wallet was added on 2026-08-03, every range pill has a partial start endpoint,
 * so the headline % rendered on no standard range at all. The danger it guarded
 * — comparing a total over ten accounts against a total over one, and calling
 * the difference growth — is answered here by comparing like with like instead
 * of by saying nothing: each endpoint drops the accounts the other cannot see,
 * and `scope` names what was dropped.
 *
 * A genuine interior GAP still suppresses. It is not a comparison problem: that
 * endpoint's own total is short by an unknown amount, so no percentage against
 * it is honest, whichever accounts it is measured over.
 */
export function sharedCoverageChange(
  start: CoverageEndpoint,
  end: CoverageEndpoint,
  max = 2,
): SharedChange {
  if (start.coverage.complete !== false && end.coverage.complete !== false) {
    const pct = pctChange(start.cents, end.cents);
    return { pct, scope: null, deltaCents: pct === null ? null : end.cents - start.cents };
  }
  if (hasGap(start.coverage) || hasGap(end.coverage)) return NO_CHANGE;

  const startCents = centsByName(start.coverage);
  const endCents = centsByName(end.coverage);
  if (!startCents || !endCents) return NO_CHANGE;

  const shared = [...startCents.keys()].filter((name) => endCents.has(name));
  if (shared.length === 0) return NO_CHANGE;
  const excluded = [
    ...[...startCents.keys()].filter((name) => !endCents.has(name)),
    ...[...endCents.keys()].filter((name) => !startCents.has(name)),
  ];

  // subtract from each end's OWN total, so the in-flight bridge (which belongs
  // to the accounts that stay) rides along instead of being recomputed
  const startShared = excluded.reduce((sum, name) => sum - (startCents.get(name) ?? 0), start.cents);
  const endShared = excluded.reduce((sum, name) => sum - (endCents.get(name) ?? 0), end.cents);
  const pct = pctChange(startShared, endShared);
  if (pct === null) return NO_CHANGE;
  return {
    pct,
    scope: scopeText(excluded, shared.length, start.coverage, end.coverage, max),
    deltaCents: endShared - startShared,
  };
}

/** Names what the percentage left out — never null while an endpoint is partial. */
function scopeText(
  excluded: readonly string[],
  sharedCount: number,
  startCoverage: DayCoverage,
  endCoverage: DayCoverage,
  max: number,
): string {
  if (excluded.length > 0) {
    // the date is joined with a comma, not parentheses: the header already wraps
    // the whole scope in them, and "(+12.5% excl. Cash on Hand (opened …))" reads
    // like a typo
    const opensOn = excluded.length === 1 ? openingDay(excluded[0]!, startCoverage, endCoverage) : null;
    const when = opensOn ? `, opened ${formatOpenDay(opensOn)}` : "";
    return `excl. ${formatNameList(excluded, max)}${when}`;
  }
  // both ends cover the same accounts — a true like-for-like comparison, but of
  // fewer accounts than exist, which the reader is owed
  const total = startCoverage.totalAccounts ?? endCoverage.totalAccounts;
  return total === undefined
    ? `across ${sharedCount} accounts`
    : `across ${sharedCount} of ${total} accounts`;
}
