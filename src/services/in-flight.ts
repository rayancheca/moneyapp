import { asc, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates } from "@/lib/dates";
import { applyInFlight } from "@/lib/in-flight";
import { netWorthSeries, type NetWorthPoint } from "./derivation";

/**
 * 🕊️ Evidence layer for the in-flight rule (docs/inflight-dips.md): a
 * transfer-pair whose legs restate on different days makes the net-worth total
 * count the money zero times (dip) or twice (spike) while it is in the air.
 * Each float here is EVIDENCED twice over — by the paired legs (the money
 * moved between the user's own accounts) and by the two accounts' derived
 * curves (when each side actually restated it). Unpaired outflows (the family
 * wires) and market moves have no pair, so they can never be bridged.
 *
 * Per-day law: the pair's money must be counted EXACTLY ONCE among what the
 * total can see. On day D it is counted by the sender while the sender's curve
 * is visible and not yet restated, and by the receiver once its curve restates
 * the arrival — `counted(D)` is 0, 1, or 2 and the correction is
 * `amount × (1 − counted)`. Restatement = the first replay-grade curve day
 * (anchored / derived / derived_unverified) at/after the leg's posting; a
 * trailing `carried` span still SHOWS the old balance (visible, stale — the
 * doc's sparse-coverage case bridges through it), while a `gap` span or a day
 * before the account's first covered day is INVISIBLE — netWorthSeries skips
 * those rows entirely, the day is already flagged partial, and this layer must
 * not double-correct what coverage honesty already reports (2026-07-18
 * adversarial review: a gap day inside a doubled window would otherwise be
 * over-subtracted, and an anchor-less sender would suppress real money
 * forever). Because visibility only changes at run boundaries, each pair
 * still reduces to a handful of constant-delta half-open windows.
 */

/** bases whose values include transaction replay / a statement's claim */
const REPLAY_GRADE: ReadonlySet<BalanceBasis> = new Set(["anchored", "derived", "derived_unverified"]);

export interface TransferFloat {
  transferGroupId: string;
  outAccountId: string;
  inAccountId: string;
  outPostedOn: string;
  inPostedOn: string;
  /** positive; the smaller leg magnitude so a fee-bearing pair never over-bridges */
  amountCents: number;
  /** missing = counted in neither account; doubled = counted in both */
  kind: "missing" | "doubled";
  /** the InFlightAdjustment window (half-open [startDay, endDay)) */
  startDay: string;
  endDay: string | null;
  deltaCents: number;
}

interface Leg {
  accountId: string;
  postedOn: string;
  amountCents: number;
}

/**
 * One account's curve as this layer sees it: when it restates a posting, and
 * on which days its balance is visible to netWorthSeries at all (first covered
 * day, minus interior gap runs, plus the trailing carry to infinity).
 */
interface CurveView {
  rows: { day: string; basis: BalanceBasis }[];
  /** first non-gap day; null = the account has no visible curve */
  firstVisible: string | null;
  /** contiguous runs of gap-basis days (invisible to the total) */
  gapRuns: { start: string; end: string }[];
}

function buildCurveView(rows: { day: string; basis: BalanceBasis }[]): CurveView {
  const firstVisible = rows.find((r) => r.basis !== "gap")?.day ?? null;
  const gapRuns: { start: string; end: string }[] = [];
  for (const r of rows) {
    if (r.basis !== "gap") continue;
    const last = gapRuns.at(-1);
    if (last && addDays(last.end, 1) === r.day) last.end = r.day;
    else gapRuns.push({ start: r.day, end: r.day });
  }
  return { rows, firstVisible, gapRuns };
}

/** First replay-grade curve day at/after `fromDay`, or null if never restated. */
function reflectedFrom(view: CurveView, fromDay: string): string | null {
  for (const r of view.rows) {
    if (compareDates(r.day, fromDay) < 0) continue;
    if (REPLAY_GRADE.has(r.basis)) return r.day;
  }
  return null;
}

/** Whether netWorthSeries can see this account's balance on `day`. */
function visibleOn(view: CurveView, day: string): boolean {
  if (view.firstVisible === null || compareDates(day, view.firstVisible) < 0) return false;
  for (const run of view.gapRuns) {
    if (compareDates(day, run.start) >= 0 && compareDates(day, run.end) <= 0) return false;
  }
  return true;
}

/** Every evidenced float between the user's own active cash accounts. */
export function transferFloats(db: AppDatabase): TransferFloat[] {
  const legs = db
    .select({
      transferGroupId: transactions.transferGroupId,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      status: transactions.status,
    })
    .from(transactions)
    .where(isNotNull(transactions.transferGroupId))
    .all()
    // replay's own rule: excluded rows still moved money; quarantined/superseded never did
    .filter((l) => l.status === "active" || l.status === "excluded");

  const groups = new Map<string, Leg[]>();
  for (const l of legs) {
    const list = groups.get(l.transferGroupId!) ?? [];
    list.push({ accountId: l.accountId, postedOn: l.postedOn, amountCents: l.amountCents });
    groups.set(l.transferGroupId!, list);
  }

  const accountRows = db
    .select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive })
    .from(accounts)
    .all();
  const accountById = new Map(accountRows.map((a) => [a.id, a] as const));

  // one pass over each involved account's curve, shared across its pairs
  const involved = new Set<string>();
  for (const g of groups.values()) for (const l of g) involved.add(l.accountId);
  const curveByAccount = new Map<string, { day: string; basis: BalanceBasis }[]>();
  if (involved.size > 0) {
    const rows = db
      .select({ accountId: dailyBalances.accountId, day: dailyBalances.day, basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(inArray(dailyBalances.accountId, [...involved]))
      .orderBy(asc(dailyBalances.day))
      .all();
    for (const r of rows) {
      const list = curveByAccount.get(r.accountId) ?? [];
      list.push({ day: r.day, basis: r.basis });
      curveByAccount.set(r.accountId, list);
    }
  }

  const viewByAccount = new Map<string, CurveView>();
  const viewOf = (accountId: string): CurveView => {
    let v = viewByAccount.get(accountId);
    if (!v) {
      v = buildCurveView(curveByAccount.get(accountId) ?? []);
      viewByAccount.set(accountId, v);
    }
    return v;
  };

  const floats: TransferFloat[] = [];
  for (const [gid, g] of groups) {
    if (g.length !== 2) continue; // only clean two-leg pairs carry evidence
    const out = g.find((l) => l.amountCents < 0);
    const inn = g.find((l) => l.amountCents > 0);
    if (!out || !inn) continue; // same-sign group — not a transfer pair
    if (out.accountId === inn.accountId) continue; // a pass-through, not money in the air
    const outAccount = accountById.get(out.accountId);
    const inAccount = accountById.get(inn.accountId);
    if (!outAccount || !inAccount) continue;
    // an inactive account is outside the visible net-worth universe — money
    // crossing that boundary is an honest change in the visible total
    if (!outAccount.isActive || !inAccount.isActive) continue;
    // investment curves are qty × close: cash legs never replay there, so no
    // restatement day exists to evidence a window (P0.1 moves such legs to the
    // Robinhood Cash account precisely so they land on a replaying ledger)
    if (outAccount.type === "investment" || inAccount.type === "investment") continue;

    const vOut = viewOf(out.accountId);
    const vIn = viewOf(inn.accountId);
    const effOut = reflectedFrom(vOut, out.postedOn);
    const effIn = reflectedFrom(vIn, inn.postedOn);
    if (effOut === null && effIn === null) continue; // neither side ever visible
    const amountCents = Math.min(-out.amountCents, inn.amountCents);
    if (amountCents <= 0) continue;

    // How many times the pair's money SHOULD appear in the visible total on D:
    // exactly once while ANY ledger claiming it is visible (during a doubled
    // overlap both books genuinely claim it — one visible claim should stand);
    // once while in the air (nobody's ledger — always the user's money); zero
    // while every claiming holder is invisible (those balances are already
    // reported as partial coverage — this layer must not double-correct).
    const target = (day: string): number => {
      const afterOut = compareDates(day, out.postedOn) >= 0;
      const afterIn = compareDates(day, inn.postedOn) >= 0;
      if (afterOut && !afterIn) return 1; // in the air
      const holders = [...(!afterOut ? [vOut] : []), ...(afterIn ? [vIn] : [])];
      return holders.some((v) => visibleOn(v, day)) ? 1 : 0;
    };
    // How many times the RAW total actually counts it on D.
    const counted = (day: string): number =>
      (visibleOn(vOut, day) && (effOut === null || compareDates(day, effOut) < 0) ? 1 : 0) +
      (visibleOn(vIn, day) && effIn !== null && compareDates(day, effIn) >= 0 ? 1 : 0);

    // delta is piecewise-constant: it can only change where a posting, a
    // restatement, or a visibility run boundary sits. Evaluate per interval.
    const cuts = new Set<string>([out.postedOn, inn.postedOn]);
    if (effOut) cuts.add(effOut);
    if (effIn) cuts.add(effIn);
    for (const v of [vOut, vIn]) {
      if (v.firstVisible) cuts.add(v.firstVisible);
      for (const run of v.gapRuns) {
        cuts.add(run.start);
        cuts.add(addDays(run.end, 1));
      }
    }
    const sorted = [...cuts].sort((a, b) => compareDates(a, b));
    const base = {
      transferGroupId: gid,
      outAccountId: out.accountId,
      inAccountId: inn.accountId,
      outPostedOn: out.postedOn,
      inPostedOn: inn.postedOn,
      amountCents,
    };
    for (let i = 0; i < sorted.length; i++) {
      const startDay = sorted[i]!;
      const endDay = sorted[i + 1] ?? null; // last interval runs open-ended
      const factor = target(startDay) - counted(startDay);
      if (factor === 0) continue;
      floats.push({
        ...base,
        kind: factor > 0 ? "missing" : "doubled",
        startDay,
        endDay,
        deltaCents: factor * amountCents,
      });
    }
  }

  // merge adjacent same-delta windows of one pair so a float reads as ONE
  // correction, not a run of fragments (cuts that didn't change the factor)
  const merged: TransferFloat[] = [];
  for (const f of floats) {
    const prev = merged.at(-1);
    if (
      prev &&
      prev.transferGroupId === f.transferGroupId &&
      prev.deltaCents === f.deltaCents &&
      prev.endDay === f.startDay
    ) {
      prev.endDay = f.endDay;
      continue;
    }
    merged.push({ ...f });
  }

  merged.sort((a, b) => compareDates(a.startDay, b.startDay) || a.transferGroupId.localeCompare(b.transferGroupId));
  return merged;
}

export type BridgedNetWorthPoint = NetWorthPoint & { inTransitCents: number };

/**
 * The net-worth series with every evidenced float corrected: the line no
 * longer dips (or spikes) while the user's money moves between their own
 * accounts. `inTransitCents` marks bridged days so the chart can say
 * "includes $X in transit" instead of silently smoothing.
 */
export function bridgedNetWorthSeries(db: AppDatabase): BridgedNetWorthPoint[] {
  return applyInFlight(netWorthSeries(db), transferFloats(db));
}
