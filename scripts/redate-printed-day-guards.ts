/**
 * Before-vs-after guards for `redate-printed-day.ts`: a re-date may move ONE account's balance on the days
 * between the printed and the posted day, by the row's amount, retire one row and add its successor — and
 * nothing else anywhere. The successor's columns themselves are `classifyRedate`'s to check.
 */
import type { DbBundle } from "@/db/client";
import { diffDays } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { netWorthSeries } from "@/services/derivation";
import { transfersCard } from "@/services/transfers-card";
import type { RedateSpec } from "./redate-printed-day";
import type { GuardReport } from "./sapphire-attach-guards";
import { diffKeyed } from "./sapphire-printed-lines";

export interface LedgerSnapshot {
  /** `account|day` → `balance|basis`, every account */
  balances: Map<string, string>;
  lastDay: Map<string, string>;
  netWorth: Map<string, number>;
  /** id → every column but `updated_at` */
  periods: Map<string, string>;
  anchors: Map<string, string>;
  rows: Map<string, string>;
  statuses: Map<string, number>;
  active: { count: number; cents: number };
  groupSizes: Map<string, number>;
  supersededWithLink: number;
  sameAccountGroups: number;
  transfers: string;
}

type Row = Record<string, unknown>;

function byId(rows: Row[]): Map<string, string> {
  return new Map(rows.map(({ updated_at: _updatedAt, ...rest }) => [String(rest.id), JSON.stringify(rest)]));
}

export function captureLedger({ db, sqlite }: DbBundle, today: string): LedgerSnapshot {
  const all = (q: string): Row[] => sqlite.prepare(q).all() as Row[];
  const one = (q: string): Row => sqlite.prepare(q).get() as Row;
  const balances = all("SELECT account_id a, day d, balance_cents b, basis s FROM daily_balances");
  return {
    balances: new Map(balances.map((r) => [`${r.a}|${r.d}`, `${r.b}|${r.s}`])),
    lastDay: new Map(all("SELECT account_id a, MAX(day) d FROM daily_balances GROUP BY account_id").map((r) => [String(r.a), String(r.d)])),
    netWorth: new Map(netWorthSeries(db).map((p) => [p.day, p.totalCents])),
    periods: byId(all("SELECT * FROM statement_periods")),
    anchors: byId(all("SELECT * FROM balance_anchors")),
    rows: byId(all("SELECT * FROM transactions")),
    statuses: new Map(all("SELECT status k, COUNT(*) v FROM transactions GROUP BY status").map((r) => [String(r.k), Number(r.v)])),
    active: (() => {
      const r = one("SELECT COUNT(*) n, COALESCE(SUM(amount_cents), 0) c FROM transactions WHERE status = 'active'");
      return { count: Number(r.n), cents: Number(r.c) };
    })(),
    groupSizes: new Map(
      all(
        `SELECT n k, COUNT(*) v FROM (SELECT COUNT(*) n FROM transactions
          WHERE transfer_group_id IS NOT NULL AND status != 'superseded' GROUP BY transfer_group_id) GROUP BY n`,
      ).map((r) => [String(r.k), Number(r.v)]),
    ),
    supersededWithLink: Number(one("SELECT COUNT(*) n FROM transactions WHERE status = 'superseded' AND transfer_group_id IS NOT NULL").n),
    sameAccountGroups: Number(
      one(
        `SELECT COUNT(*) n FROM (SELECT transfer_group_id FROM transactions
          WHERE transfer_group_id IS NOT NULL AND status != 'superseded'
          GROUP BY transfer_group_id HAVING COUNT(*) >= 2 AND COUNT(DISTINCT account_id) = 1)`,
      ).n,
    ),
    transfers: JSON.stringify(transfersCard(db, today)),
  };
}

/** The days whose end-of-day balance holds the row on one side of the move and not the other, and by how much. */
export function movedDays(spec: Pick<RedateSpec, "postedOn" | "printedOn" | "amountCents">): { from: string; to: string; delta: number } {
  const earlier = spec.printedOn < spec.postedOn;
  return {
    from: earlier ? spec.printedOn : spec.postedOn,
    // half-open: the later day already held the row before, and still does
    to: earlier ? spec.postedOn : spec.printedOn,
    delta: earlier ? spec.amountCents : -spec.amountCents,
  };
}

/** A day-keyed series may move only on the moved days, by `delta`, and may only grow past its old last day. */
function seriesProblems(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  moved: { from: string; to: string; delta: number },
): string[] {
  const d = diffKeyed(before, after);
  const last = [...before.keys()].sort().at(-1) ?? "";
  const inside = (day: string) => moved.from <= day && day < moved.to;
  return [
    ...d.changed.filter((c) => !inside(c.key) || c.after - c.before !== moved.delta).map((c) => `${c.key}: ${c.before} → ${c.after}`),
    ...[...before.keys()].filter((day) => inside(day) && after.get(day) === before.get(day)).map((day) => `${day} did not move`),
    ...d.removed.map((day) => `${day} removed`),
    ...d.added.filter((day) => day <= last).map((day) => `${day} added inside the series`),
  ];
}

export function compareLedger(before: LedgerSnapshot, after: LedgerSnapshot, spec: RedateSpec, successorId: string): GuardReport {
  const lines: string[] = [];
  const failures: string[] = [];
  const check = (name: string, problems: readonly string[], detail: string): void => {
    lines.push(`${problems.length === 0 ? "PASS" : "FAIL"}  ${name} — ${problems.length === 0 ? detail : problems.slice(0, 6).join("; ")}`);
    if (problems.length > 0) failures.push(name);
  };
  const moved = movedDays(spec);
  const days = Math.max(0, diffDays(moved.from, moved.to));

  const accountDays = (s: LedgerSnapshot, account: string) =>
    new Map(
      [...s.balances]
        .filter(([key]) => key.startsWith(`${account}|`))
        .map(([key, value]) => [key.slice(account.length + 1), Number(value.split("|")[0])] as const),
    );
  const basisMoved = [...before.balances].filter(([key, v]) => after.balances.has(key) && after.balances.get(key)!.split("|")[1] !== v.split("|")[1]).map(([k]) => k);
  const accounts = new Set([...before.lastDay.keys(), ...after.lastDay.keys()]);
  const balanceProblems = [
    ...[...accounts].flatMap((account) =>
      seriesProblems(accountDays(before, account), accountDays(after, account), account === spec.accountId ? moved : { from: "", to: "", delta: 0 }).map(
        (p) => `${account} ${p}`,
      ),
    ),
    ...basisMoved.map((k) => `${k} changed basis`),
  ];
  check(
    "daily_balances: only the re-dated account, on the moved days, by the amount",
    balanceProblems,
    `${before.balances.size} rows · ${spec.accountId} ${moved.from}..${moved.to} (${days} day(s)) by ${formatCents(moved.delta)}`,
  );

  const today = [...after.netWorth.keys()].sort().at(-1) ?? "";
  check(
    "net worth: the moved days by the amount, every other day identical",
    seriesProblems(before.netWorth, after.netWorth, moved),
    `${before.netWorth.size} days · ${today} ${formatCents(before.netWorth.get(today) ?? 0)} → ${formatCents(after.netWorth.get(today) ?? 0)}`,
  );

  const periods = diffKeyed(before.periods, after.periods);
  check("statement periods (every column)", [...periods.changed.map((c) => c.key), ...periods.removed, ...periods.added], `${before.periods.size} periods`);
  const anchors = diffKeyed(before.anchors, after.anchors);
  check("balance anchors (every column)", [...anchors.changed.map((c) => c.key), ...anchors.removed, ...anchors.added], `${before.anchors.size} anchors`);

  const rows = diffKeyed(before.rows, after.rows);
  const rowProblems = [
    ...rows.changed.filter((c) => c.key !== spec.rowId).map((c) => `${c.key} changed`),
    ...(rows.changed.some((c) => c.key === spec.rowId) ? [] : [`${spec.rowId} did not change`]),
    ...rows.removed.map((id) => `${id} removed`),
    ...(rows.added.length === 1 && rows.added[0] === successorId ? [] : [`added ${JSON.stringify(rows.added)}, expected [${successorId}]`]),
  ];
  check("every other transaction row (every column)", rowProblems, `${before.rows.size} rows · ${spec.rowId} retired · ${successorId} added`);

  const statusKeys = new Set([...before.statuses.keys(), ...after.statuses.keys(), "superseded"]);
  const statusProblems = [...statusKeys].flatMap((k) => {
    const delta = (after.statuses.get(k) ?? 0) - (before.statuses.get(k) ?? 0);
    return delta === (k === "superseded" ? 1 : 0) ? [] : [`${k} ${delta >= 0 ? "+" : ""}${delta}`];
  });
  check("statuses: superseded +1, every other status identical", statusProblems, JSON.stringify(Object.fromEntries(after.statuses)));
  check(
    "active rows: count and sum identical",
    after.active.count === before.active.count && after.active.cents === before.active.cents ? [] : [`${before.active.count} ${before.active.cents} → ${after.active.count} ${after.active.cents}`],
    `${after.active.count} rows ${formatCents(after.active.cents)}`,
  );

  const groups = diffKeyed(before.groupSizes, after.groupSizes);
  check("transfer group sizes identical", [...groups.changed.map((c) => `${c.key}-leg ${c.before} → ${c.after}`), ...groups.removed, ...groups.added], JSON.stringify(Object.fromEntries(after.groupSizes)));
  check("no superseded row gains a link", after.supersededWithLink <= before.supersededWithLink ? [] : [`${before.supersededWithLink} → ${after.supersededWithLink}`], `${after.supersededWithLink}`);
  // not "none": Chase Checking's −$115.00 and its "Cancelled" +$115.00 of 2026-03-02 were grouped together on
  // purpose on 2026-09-15 (owner answer 2), before this write
  check(
    "transfer groups inside one account unchanged",
    after.sameAccountGroups === before.sameAccountGroups ? [] : [`${before.sameAccountGroups} → ${after.sameAccountGroups}`],
    `${after.sameAccountGroups}`,
  );
  check("the transfers card reads identically", jsonDifferences(JSON.parse(before.transfers), JSON.parse(after.transfers)), `${before.transfers.length} chars`);
  return { lines, failures };
}

/** The paths at which two JSON values differ, with both values — so a failing check says what moved. */
export function jsonDifferences(before: unknown, after: unknown, at = "card"): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (isObject(before) && isObject(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => jsonDifferences(before[k], after[k], `${at}.${k}`));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`${at}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
}
