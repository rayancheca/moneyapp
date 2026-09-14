import type { DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { RECONCILE_STATUSES, isVerdictStale, periodVerdict } from "@/lib/reconciliation";
import { netWorthSeries } from "@/services/derivation";
import { diffKeyed } from "./sapphire-printed-lines";

const SAPPHIRE_ID = "019f4ca7-a750-7f21-8ffa-2546cac01f3a";
const CHECKING_NAME = "Chase Checking";

/** Everything the write must leave unchanged, or change by exactly the planned amount. */
export interface GuardSnapshot {
  sapphireDays: Map<string, string>;
  sapphirePeriods: Map<string, string>;
  staleSapphireVerdicts: number;
  netWorth: Map<string, number>;
  sapphireReplayByDay: Map<string, number>;
  sapphireActive: { count: number; cents: number };
  sapphireHand: { count: number; cents: number };
  statusCounts: Map<string, number>;
  groupSizes: Map<string, number>;
  supersededWithLink: number;
  sameAccountGroups: number;
  checkingDays: Map<string, string>;
  categories: Map<string, string>;
  shapes: Map<string, string>;
}

export interface GuardExpectation {
  attached: readonly string[];
  retired: readonly string[];
  unlinked: readonly string[];
  expectedHandNetCents: number;
}

export interface GuardReport {
  lines: string[];
  failures: string[];
}

type Row = Record<string, string | number | null>;

/**
 * What a row is to its transfer group: `retired`, `unlinked`, `single` (the
 * only live member), `complete` (exactly two live legs, in two different
 * accounts, whose amounts cancel — the shape `linkTransferPair` enforces) or
 * `broken(…)` for anything else.
 *
 * ⛔ Symmetric on purpose. A first draft required the OTHER leg to be in Chase
 * Checking, which is true of every Sapphire row here and false of the Checking
 * row itself — so the rehearsal printed the valid +$115.00 / −$115.00 transfer
 * as `broken(2 legs)`.
 */
function shapeOf(sqlite: DbBundle["sqlite"], id: string): string {
  const row = sqlite
    .prepare("SELECT status, transfer_group_id g, amount_cents a, account_id acc FROM transactions WHERE id = ?")
    .get(id) as { status: string; g: string | null; a: number; acc: string } | undefined;
  if (!row) return "missing";
  if (row.status === "superseded") return "retired";
  if (row.g === null) return "unlinked";
  const members = sqlite
    .prepare("SELECT id, account_id acc, amount_cents a FROM transactions WHERE transfer_group_id = ? AND status != 'superseded'")
    .all(row.g) as { id: string; acc: string; a: number }[];
  if (members.length === 1) return "single";
  const other = members.filter((m) => m.id !== id);
  if (members.length === 2 && other.length === 1 && other[0]!.acc !== row.acc && other[0]!.a === -row.a) return "complete";
  return `broken(${members.length} legs)`;
}

function keyed<V>(rows: Row[]): Map<string, V> {
  return new Map(rows.map((r) => [String(r.k), r.v as V]));
}

export function captureGuards({ db, sqlite }: DbBundle, touchedIds: readonly string[]): GuardSnapshot {
  const all = (q: string, ...params: unknown[]): Row[] => sqlite.prepare(q).all(...params) as Row[];
  const one = (q: string, ...params: unknown[]): Row => sqlite.prepare(q).get(...params) as Row;
  const checkingId = String(one("SELECT id FROM accounts WHERE name = ?", CHECKING_NAME).id);
  const placeholders = touchedIds.map(() => "?").join(",");

  const periods = all(
    `SELECT id, period_start ps, period_end pe, beginning_balance_cents b, ending_balance_cents e, reconciliation r, gap_cents g
       FROM statement_periods WHERE account_id = ?`,
    SAPPHIRE_ID,
  );
  let stale = 0;
  for (const p of periods) {
    const movement = Number(
      one(
        `SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE account_id = ?
           AND status IN (${RECONCILE_STATUSES.map(() => "?").join(",")}) AND posted_on >= ? AND posted_on <= ?`,
        SAPPHIRE_ID,
        ...RECONCILE_STATUSES,
        p.ps,
        p.pe,
      ).s,
    );
    const stored = { beginningBalanceCents: p.b as number | null, endingBalanceCents: p.e as number | null };
    const fresh = periodVerdict(stored, movement, { isInvestment: false });
    if (isVerdictStale({ reconciliation: p.r as never, gapCents: p.g as number | null }, fresh)) stale += 1;
  }

  return {
    sapphireDays: keyed(all("SELECT day k, balance_cents || '|' || basis v FROM daily_balances WHERE account_id = ?", SAPPHIRE_ID)),
    sapphirePeriods: new Map(periods.map((p) => [String(p.id), `${p.r}|${p.g ?? "null"}`])),
    staleSapphireVerdicts: stale,
    netWorth: new Map(netWorthSeries(db).map((p) => [p.day, p.totalCents])),
    sapphireReplayByDay: keyed(
      all(
        `SELECT posted_on k, SUM(amount_cents) v FROM transactions
          WHERE account_id = ? AND status IN ('active','excluded') GROUP BY posted_on`,
        SAPPHIRE_ID,
      ),
    ),
    sapphireActive: countSum(one("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM transactions WHERE account_id = ? AND status = 'active'", SAPPHIRE_ID)),
    sapphireHand: countSum(
      one(
        `SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) c FROM transactions
          WHERE account_id = ? AND import_file_id IS NULL AND status IN ('active','excluded')`,
        SAPPHIRE_ID,
      ),
    ),
    statusCounts: keyed(all("SELECT status k, COUNT(*) v FROM transactions GROUP BY status")),
    groupSizes: keyed(
      all(
        `SELECT n k, COUNT(*) v FROM (SELECT COUNT(*) n FROM transactions
          WHERE transfer_group_id IS NOT NULL AND status != 'superseded' GROUP BY transfer_group_id) GROUP BY n`,
      ),
    ),
    supersededWithLink: Number(one("SELECT COUNT(*) n FROM transactions WHERE status = 'superseded' AND transfer_group_id IS NOT NULL").n),
    sameAccountGroups: Number(
      one(
        `SELECT COUNT(*) n FROM (SELECT transfer_group_id FROM transactions
          WHERE transfer_group_id IS NOT NULL AND status != 'superseded'
          GROUP BY transfer_group_id HAVING COUNT(*) >= 2 AND COUNT(DISTINCT account_id) = 1)`,
      ).n,
    ),
    checkingDays: keyed(all("SELECT day k, balance_cents || '|' || basis v FROM daily_balances WHERE account_id = ?", checkingId)),
    categories: keyed(all(`SELECT id k, COALESCE(category_id, '') v FROM transactions WHERE id IN (${placeholders})`, ...touchedIds)),
    shapes: new Map(touchedIds.map((id) => [id, shapeOf(sqlite, id)])),
  };
}

function countSum(r: Row): { count: number; cents: number } {
  return { count: Number(r.n), cents: Number(r.c) };
}

/** A day-keyed series may only grow past its old last day (a rebuild reaches today); nothing earlier may move. */
function sameThroughLastDay<V>(before: Map<string, V>, after: Map<string, V>): { ok: boolean; detail: string } {
  const d = diffKeyed(before, after);
  const last = [...before.keys()].sort().at(-1) ?? "";
  const early = d.added.filter((k) => k <= last);
  const ok = d.changed.length === 0 && d.removed.length === 0 && early.length === 0;
  return {
    ok,
    detail: `${before.size} days · changed ${d.changed.length} · removed ${d.removed.length} · added ${d.added.length} (all after ${last}: ${early.length === 0})`,
  };
}

export function compareGuards(before: GuardSnapshot, after: GuardSnapshot, expect: GuardExpectation): GuardReport {
  const lines: string[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    lines.push(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
    if (!ok) failures.push(name);
  };

  const days = sameThroughLastDay(before.sapphireDays, after.sapphireDays);
  check("Sapphire daily_balances (balance and basis)", days.ok, days.detail);
  const periods = diffKeyed(before.sapphirePeriods, after.sapphirePeriods);
  check(
    "Sapphire statement periods (verdict and gap)",
    periods.changed.length + periods.removed.length + periods.added.length === 0,
    `${before.sapphirePeriods.size} periods · ${[...after.sapphirePeriods.values()].filter((v) => v.startsWith("reconciled|")).length} reconciled`,
  );
  check("no stale Sapphire verdict", after.staleSapphireVerdicts === 0, `${before.staleSapphireVerdicts} → ${after.staleSapphireVerdicts}`);
  const worth = sameThroughLastDay(before.netWorth, after.netWorth);
  check("net worth on every day", worth.ok, `${worth.detail} · last ${formatCents([...after.netWorth.values()].at(-1) ?? 0)}`);
  const replay = diffKeyed(before.sapphireReplayByDay, after.sapphireReplayByDay);
  check("Sapphire replayed movement per day", replay.changed.length + replay.removed.length + replay.added.length === 0, `${before.sapphireReplayByDay.size} days`);
  check(
    "Sapphire active sum moves by the pair ($0.00), count by −2",
    after.sapphireActive.cents === before.sapphireActive.cents && after.sapphireActive.count === before.sapphireActive.count - 2,
    `${before.sapphireActive.count} rows ${formatCents(before.sapphireActive.cents)} → ${after.sapphireActive.count} rows ${formatCents(after.sapphireActive.cents)}`,
  );
  check(
    "hand-entered Sapphire money leaves the balance chain",
    before.sapphireHand.cents === expect.expectedHandNetCents && after.sapphireHand.count === 0 && after.sapphireHand.cents === 0,
    `${before.sapphireHand.count} rows ${formatCents(before.sapphireHand.cents)} → ${after.sapphireHand.count} rows ${formatCents(after.sapphireHand.cents)}`,
  );
  check("statuses ledger-wide: active −2, superseded +2, nothing else", statusDeltaOk(before.statusCounts, after.statusCounts), describeCounts(before.statusCounts, after.statusCounts));
  const checking = diffKeyed(before.checkingDays, after.checkingDays);
  check("Chase Checking daily_balances untouched", checking.changed.length + checking.removed.length + checking.added.length === 0, `${before.checkingDays.size} days`);
  const categories = diffKeyed(before.categories, after.categories);
  check("no touched row's category moved", categories.changed.length + categories.removed.length === 0, `${before.categories.size} rows`);
  checkShapes(before, after, expect, check);
  check("group sizes: one single and one two-leg group gone", groupDeltaOk(before.groupSizes, after.groupSizes), describeCounts(before.groupSizes, after.groupSizes));
  check("no superseded row holds a transfer link", after.supersededWithLink === 0, `${before.supersededWithLink} → ${after.supersededWithLink}`);
  check("no transfer group inside one account", after.sameAccountGroups === 0, `${before.sameAccountGroups} → ${after.sameAccountGroups}`);
  return { lines, failures };
}

function checkShapes(
  before: GuardSnapshot,
  after: GuardSnapshot,
  expect: GuardExpectation,
  check: (name: string, ok: boolean, detail: string) => void,
): void {
  const moved = expect.attached.filter((id) => before.shapes.get(id) !== after.shapes.get(id));
  const tally = (ids: readonly string[], s: GuardSnapshot) =>
    ids.reduce<Record<string, number>>((acc, id) => ({ ...acc, [s.shapes.get(id)!]: (acc[s.shapes.get(id)!] ?? 0) + 1 }), {});
  check("attached rows keep their transfer shape", moved.length === 0, JSON.stringify(tally(expect.attached, after)));
  check("the unprinted pair is retired", expect.retired.every((id) => after.shapes.get(id) === "retired"), expect.retired.map((id) => `${before.shapes.get(id)}→${after.shapes.get(id)}`).join(", "));
  check("the cancelled checking leg is unlinked", expect.unlinked.every((id) => after.shapes.get(id) === "unlinked"), expect.unlinked.map((id) => `${before.shapes.get(id)}→${after.shapes.get(id)}`).join(", "));
}

function statusDeltaOk(before: Map<string, number>, after: Map<string, number>): boolean {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].every((k) => {
    const delta = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    return delta === (k === "active" ? -2 : k === "superseded" ? 2 : 0);
  });
}

function groupDeltaOk(before: Map<string, number>, after: Map<string, number>): boolean {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].every((k) => {
    const delta = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    return delta === (k === "1" || k === "2" ? -1 : 0);
  });
}

function describeCounts(before: Map<string, number>, after: Map<string, number>): string {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((k) => `${k}: ${before.get(k) ?? 0}→${after.get(k) ?? 0}`).join(" · ");
}
