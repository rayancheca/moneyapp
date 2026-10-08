/**
 * The guarded write of the owner's decision 55 (2026-10-08, §6A 55): his pay's dated rate. "It America LLC (weekly
 * pay)" keeps $1,141.92 as its rate NOW, and gains ONE past period — the cash weeks through Wed Aug 26 at $1,047.00:
 *
 *   recurring_series.user_amount_history = '[{"throughOn":"2026-08-26","amountCents":104700}]'
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-08: with one amount for all time, the $1,141.92 he set on Sep 22
 * re-priced twelve cash weeks he was paid $1,047.00 for — Earned vs banked implied $20,554.56 and said $12,256.04 never
 * reached a bank, $1,139.04 of it pay he was never owed. The code that reads a dated rate (`rateOn`, the eras the
 * settlement keeps money in, one payday universe) is on main; this is the ledger's half.
 *
 * The runner is `scripts/set-pay-rate-history-2026-10-08.ts`; this module is what it decides and checks, so the test
 * can hold every guard to his ledger's shape.
 *
 * ⛔ Refused unless his series is exactly as measured — id and name, income, weekly, confirmed, his $1,141.92, NO
 * history — with exactly his four deposits linked (ids, days, amounts), and the schedule's paydays either side of the
 * boundary are Thu Aug 20 and Thu Aug 27. A stored history equal to this one is ALREADY APPLIED, read before the row
 * guards: a deposit linked later does not make a re-run refuse. Any other history is never overwritten.
 *
 * ⛔ After the write — on the rehearsal copy and on the ledger — exactly one series row differs, in exactly two columns
 * (`user_amount_history`, `updated_at`); every transaction, every daily balance and the status counts are identical;
 * the app reads every stored history; the income card's implied pay and its checked gap ("never reached a bank") each
 * fall by exactly $1,139.04; and the monthly basis the runway and /budgets read stays $4,948.32.
 */
import { eq } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { recurringSeries, type RatePeriod } from "@/db/schema/recurring";
import { periodBounds } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { AmountHistoryError, parseAmountHistoryText, seriesAmountCents } from "@/lib/series-kind";
import { incomeExpectation } from "@/services/budgets";
import { incomeCard } from "@/services/income-card";
import { rateHistoryRefusals } from "@/services/rate-history-check";
import { projectOccurrences, toProjectable } from "@/services/recurring";
import { balancesHash, changedKeys, sha256Json, statusCounts } from "./guarded-write-harness";

export const SNAPSHOT_LABEL = "set-pay-rate-history";

/** His series, as his ledger stores it on 2026-10-08. */
export const PAY = {
  id: "019f72da-1fbc-7000-a434-6840bae2d231",
  name: "It America LLC (weekly pay)",
  /** the rate now — the payroll's $1,141.92, which he set on Sep 22 */
  amountCents: 114_192,
} as const;

/** ⚖️ The one past period (decision 55): the cash weeks — every payday through Wed Aug 26 — at $1,047.00. */
export const HISTORY: readonly RatePeriod[] = [{ throughOn: "2026-08-26", amountCents: 104_700 }];
/** …exactly as the column stores it: the text the app's reader (`parseAmountHistoryText`) reads back as HISTORY */
export const HISTORY_TEXT = JSON.stringify(HISTORY);

/** The schedule's paydays either side of the boundary: the last cash week and the first payroll week. */
const BOUNDARY_PAYDAYS = ["2026-08-20", "2026-08-27"] as const;

/** The four deposits he linked to it: two ATM cash deposits in Chase Checking, the payroll lump and week in Wells Fargo. */
export const ROWS = [
  { id: "019f4ca7-a6c4-7a76-9755-8f73b271a7b4", postedOn: "2026-06-04", amountCents: 104_700 },
  { id: "019f4ca7-a6c4-779c-83e4-ab69ac748ca0", postedOn: "2026-06-05", amountCents: 40_000 },
  { id: "01a0e898-c5ca-7004-864c-da99c173b10d", postedOn: "2026-09-23", amountCents: 456_768 },
  { id: "01a0e898-c5ca-7005-aece-a262e0465a27", postedOn: "2026-09-24", amountCents: 114_192 },
] as const;

/**
 * How far implied pay and the checked gap each fall: the twelve cash weeks Jun 4 – Aug 20, each $94.92 less
 * ($1,141.92 − $1,047.00). Every later payday is priced at $1,141.92 before and after, so the fall does not depend on
 * the day the write runs. Measured on a copy, 2026-10-08: $20,554.56 → $19,415.52 and $12,256.04 → $11,117.00.
 */
export const FALL_CENTS = 113_904;

/** The monthly basis the runway and /budgets grade against: $1,141.92 × 52 ÷ 12. A past rate never moves it. */
export const BASIS_CENTS = 494_832;

interface SeriesFact {
  name: string;
  kind: string;
  cadence: string;
  userCadence: string | null;
  status: string;
  userAmountCents: number | null;
  nextExpectedAmountCents: number | null;
  /** the column's own text, read raw — never through its JSON mode, which would throw on text that is not JSON */
  historyText: string | null;
}

interface RowFact {
  id: string;
  postedOn: string;
  amountCents: number;
  status: string;
  seriesId: string | null;
  seriesName: string | null;
}

export interface Facts {
  /** whether migration 0025 has added `user_amount_history` (createDatabase applies it on open) */
  hasColumn: boolean;
  series: SeriesFact | undefined;
  /** the four, by id — those this ledger has */
  rows: ReadonlyMap<string, RowFact>;
  /** every OTHER active row linked to his series */
  others: readonly RowFact[];
  /** the schedule's paydays from Aug 20 through Aug 27 */
  boundary: readonly string[];
}

export type Verdict = { kind: "plan" } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

const ROW_SQL = `
  SELECT t.id, t.posted_on AS postedOn, t.amount_cents AS amountCents, t.status, t.recurring_series_id AS seriesId,
         s.name AS seriesName
    FROM transactions t LEFT JOIN recurring_series s ON s.id = t.recurring_series_id`;

export function loadFacts(bundle: DbBundle): Facts {
  const columns = bundle.sqlite.prepare("PRAGMA table_info(recurring_series)").all() as { name: string }[];
  const hasColumn = columns.some((c) => c.name === "user_amount_history");
  const rowStmt = bundle.sqlite.prepare(`${ROW_SQL} WHERE t.id = ?`);
  const rows = new Map<string, RowFact>();
  for (const want of ROWS) {
    const fact = rowStmt.get(want.id) as RowFact | undefined;
    if (fact !== undefined) rows.set(want.id, fact);
  }
  const four = ROWS.map(() => "?").join(", ");
  const others = bundle.sqlite
    .prepare(
      `${ROW_SQL} WHERE t.recurring_series_id = ? AND t.status = 'active' AND t.id NOT IN (${four})
        ORDER BY t.posted_on, t.id`,
    )
    .all(PAY.id, ...ROWS.map((r) => r.id)) as RowFact[];
  if (!hasColumn) return { hasColumn, series: undefined, rows, others, boundary: [] };

  // every column a projection reads but the history: a schedule's DAYS do not depend on what a payday was worth
  const s = bundle.db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      kind: recurringSeries.kind,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      status: recurringSeries.status,
      intervalDaysAvg: recurringSeries.intervalDaysAvg,
      nextExpectedOn: recurringSeries.nextExpectedOn,
      userNextExpectedOn: recurringSeries.userNextExpectedOn,
      nextExpectedAmountCents: recurringSeries.nextExpectedAmountCents,
      userAmountCents: recurringSeries.userAmountCents,
      userEndsOn: recurringSeries.userEndsOn,
      anchorDay: recurringSeries.anchorDay,
    })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, PAY.id))
    .get();
  if (s === undefined) return { hasColumn, series: undefined, rows, others, boundary: [] };
  const { h } = bundle.sqlite
    .prepare("SELECT user_amount_history AS h FROM recurring_series WHERE id = ?")
    .get(PAY.id) as { h: string | null };
  const schedule = toProjectable({ ...s, userAmountHistory: null });
  const boundary = projectOccurrences(schedule, BOUNDARY_PAYDAYS[0], BOUNDARY_PAYDAYS[1]).map((o) => o.date);
  return { hasColumn, series: { ...s, historyText: h }, rows, others, boundary };
}

const refuse = (reasons: string[]): Verdict => ({ kind: "refuse", reasons });

export function classify(facts: Facts): Verdict {
  if (!facts.hasColumn) {
    return refuse(["recurring_series.user_amount_history does not exist — migration 0025_series_amount_history not run"]);
  }
  const s = facts.series;
  if (s === undefined) return refuse([`${PAY.id} (${PAY.name}): not in this ledger`]);

  // ⛔ before the row guards: once written, a deposit linked later must not make a re-run refuse
  if (s.historyText !== null) {
    let stored: string;
    try {
      stored = JSON.stringify(parseAmountHistoryText(s.historyText, seriesAmountCents(s)));
    } catch (error: unknown) {
      if (!(error instanceof AmountHistoryError)) throw error;
      return refuse([`${PAY.name}: stores a history the app cannot read (${error.message}) — never overwritten`]);
    }
    if (stored === HISTORY_TEXT) return { kind: "applied" };
    return refuse([`${PAY.name}: stores another history, ${s.historyText} — never overwritten`]);
  }

  const reasons = [...seriesReasons(s), ...rowReasons(facts)];
  if (facts.boundary.join() !== BOUNDARY_PAYDAYS.join()) {
    reasons.push(
      `${PAY.name}: its paydays from Aug 20 through Aug 27 are ${facts.boundary.join(", ") || "none"}, not ` +
        `${BOUNDARY_PAYDAYS.join(" and ")} — the cash period must end the day before the first payroll payday`,
    );
  }
  return reasons.length > 0 ? refuse(reasons) : { kind: "plan" };
}

function seriesReasons(s: SeriesFact): string[] {
  const reasons: string[] = [];
  const cadence = s.userCadence ?? s.cadence;
  if (s.name !== PAY.name) reasons.push(`${PAY.id}: named "${s.name}", not "${PAY.name}"`);
  if (s.kind !== "income") reasons.push(`${PAY.name}: a ${s.kind} series, not income`);
  if (cadence !== "weekly") reasons.push(`${PAY.name}: ${cadence}, not weekly`);
  if (s.status !== "confirmed") reasons.push(`${PAY.name}: ${s.status}, not confirmed`);
  if (s.userAmountCents !== PAY.amountCents) {
    const now = s.userAmountCents === null ? "not set" : formatCents(s.userAmountCents);
    reasons.push(`${PAY.name}: his amount now is ${now}, not ${formatCents(PAY.amountCents)}`);
  }
  return reasons;
}

function rowReasons(facts: Facts): string[] {
  const reasons: string[] = [];
  for (const want of ROWS) {
    const f = facts.rows.get(want.id);
    if (f === undefined) {
      reasons.push(`${want.id}: not in this ledger`);
      continue;
    }
    if (f.status !== "active") reasons.push(`${want.id}: ${f.status}, not active`);
    if (f.postedOn !== want.postedOn || f.amountCents !== want.amountCents) {
      const wanted = `${want.postedOn} ${formatCents(want.amountCents)}`;
      reasons.push(`${want.id}: ${f.postedOn} ${formatCents(f.amountCents)}, not ${wanted}`);
    }
    if (f.seriesId !== PAY.id) reasons.push(`${want.id}: attached to ${f.seriesName ?? "no series"}, not ${PAY.name}`);
  }
  for (const o of facts.others) {
    const row = `${o.postedOn} ${formatCents(o.amountCents)}`;
    reasons.push(`${o.id}: ${row} is linked to ${PAY.name} too — it was measured with four deposits`);
  }
  return reasons;
}

/** The ONE statement this write runs — over NULL only, so a history stored meanwhile is never overwritten. */
export function applyHistory(bundle: DbBundle): void {
  const written = bundle.sqlite
    .prepare(
      "UPDATE recurring_series SET user_amount_history = ?, updated_at = ? WHERE id = ? AND user_amount_history IS NULL",
    )
    .run(HISTORY_TEXT, new Date().toISOString(), PAY.id).changes;
  if (written !== 1) throw new Error(`${PAY.id}: not written — the series is gone, or its history is no longer NULL`);
}

/** What the owner reads off the write: Earned vs banked's line and total, and the monthly basis. */
export interface Figures {
  /** his line's implied pay; null when the income card has no line for him */
  impliedCents: number | null;
  /** his line's "never reached a bank" — the difference less the part after the checked frontier */
  checkedGapCents: number | null;
  totalImpliedCents: number | null;
  totalCheckedGapCents: number | null;
  /** `incomeExpectation(…).basis.cents` for today's month — what the runway and /budgets read */
  basisCents: number;
}

function figuresOf(bundle: DbBundle, today: string): Figures {
  const card = incomeCard(bundle.db, today);
  const line = card?.pay.find((l) => l.seriesId === PAY.id);
  const month = periodBounds(today, "monthly");
  return {
    impliedCents: line?.impliedCents ?? null,
    checkedGapCents: line === undefined ? null : line.gapCents - line.unreadGapCents,
    totalImpliedCents: card?.totals.impliedCents ?? null,
    totalCheckedGapCents: card === null ? null : card.totals.gapCents - card.totals.unreadGapCents,
    basisCents: incomeExpectation(bundle.db, month.start, month.end, today).basis.cents,
  };
}

export interface WriteState {
  transactions: string;
  balances: string;
  statuses: string;
  /** every series row, by id, as JSON */
  series: ReadonlyMap<string, string>;
  /** his row, column by column */
  pay: Readonly<Record<string, unknown>> | undefined;
  /** what the app's reader refuses among every stored history — `pnpm ledger-check`'s own question */
  unreadable: readonly string[];
  figures: Figures;
}

export function captureState(bundle: DbBundle, today: string): WriteState {
  const seriesRows = bundle.sqlite
    .prepare("SELECT * FROM recurring_series ORDER BY id")
    .all() as Record<string, unknown>[];
  return {
    transactions: sha256Json(bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all()),
    balances: balancesHash(bundle),
    statuses: statusCounts(bundle),
    series: new Map(seriesRows.map((r) => [r.id as string, JSON.stringify(r)])),
    pay: seriesRows.find((r) => r.id === PAY.id),
    unreadable: rateHistoryRefusals(bundle.db).map((r) => r.sentence),
    figures: figuresOf(bundle, today),
  };
}

const money = (cents: number | null): string => (cents === null ? "nothing" : formatCents(cents));

/** A figure that must fall by exactly FALL_CENTS. */
function fall(label: string, before: number | null, after: number | null): string[] {
  if (before !== null && after !== null && before - after === FALL_CENTS) return [];
  return [`${label} read ${money(before)} → ${money(after)}, not a fall of exactly ${formatCents(FALL_CENTS)}`];
}

export function compareStates(before: WriteState, after: WriteState): string[] {
  const failures: string[] = [];
  if (before.transactions !== after.transactions) failures.push("transactions moved — this write touches none");
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");

  const moved = changedKeys(before.series, after.series);
  if (moved.join() !== PAY.id) {
    failures.push(`series rows moved: ${moved.join(", ") || "none"} — exactly one may, ${PAY.id}`);
  }
  const was = before.pay ?? {};
  const now = after.pay ?? {};
  const columns = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((k) => was[k] !== now[k]).sort();
  if (columns.join() !== "updated_at,user_amount_history") {
    const listed = columns.join(", ") || "none";
    failures.push(`${PAY.name}: columns moved: ${listed} — exactly two may, updated_at and user_amount_history`);
  }
  if (now.user_amount_history !== HISTORY_TEXT) {
    failures.push(`${PAY.name}: stores ${String(now.user_amount_history)}, not ${HISTORY_TEXT}`);
  }
  if (after.unreadable.length > 0) {
    failures.push(`the app cannot read ${after.unreadable.length} stored history(ies): ${after.unreadable.join(" | ")}`);
  }

  const b = before.figures;
  const a = after.figures;
  failures.push(...fall("his implied pay", b.impliedCents, a.impliedCents));
  failures.push(...fall("his checked gap (never reached a bank)", b.checkedGapCents, a.checkedGapCents));
  failures.push(...fall("the income card's total implied", b.totalImpliedCents, a.totalImpliedCents));
  failures.push(...fall("the income card's total checked gap", b.totalCheckedGapCents, a.totalCheckedGapCents));
  if (b.basisCents !== BASIS_CENTS || a.basisCents !== BASIS_CENTS) {
    const read = `${money(b.basisCents)} → ${money(a.basisCents)}`;
    failures.push(`the monthly income basis read ${read}, not ${formatCents(BASIS_CENTS)} both`);
  }
  return failures;
}

/** The write and every guard, on a copy — the dry run's rehearsal and `--confirm`'s first step. */
export function rehearse(copy: DbBundle, today: string): { before: WriteState; after: WriteState; failures: string[] } {
  const before = captureState(copy, today);
  applyHistory(copy);
  const after = captureState(copy, today);
  const failures = compareStates(before, after);
  if (classify(loadFacts(copy)).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
  return { before, after, failures };
}
