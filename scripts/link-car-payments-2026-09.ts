/**
 * REAL-DB WRITE — run once the Wells Fargo ····5481 statement covering early
 * September 2026 is imported. Links the two car payments the owner made early
 * from that account, which no import-time rule links.
 *
 * Owner, 2026-09-14 (memory `moneyapp-car-lease-and-insurance`): he paid the
 * first lease month ($695.04) "last week through my wells fargo checking …
 * wait till the statement", and $1,000.00 of the insurance early from the same
 * account; Progressive applied it to Sep 11, Oct 11 and $284.84 of Nov 11. The
 * decision: link the $1,000.00 row to `Car insurance`, the $695.04 row to
 * `Car lease`, and move the lease's next date to 2026-10-15 (its last payment
 * stays 2028-08-15). He does not do this by hand.
 *
 * ## Why no rule links them (audit, copies of the real ledger, 2026-09-15)
 *
 *  - Car lease (−$695.04, the 15th, tolerance 3, no account) has never posted,
 *    so only first-posting can link it, and only a row posted Sep 12–18. An
 *    early payment (about Sep 7–11) is outside. Once that row exists the
 *    identity fence counts it, so no LATER $695.04 is a first posting either.
 *  - Attaching the September row alone leaves September owed: it posted
 *    outside the tolerance of Sep 15. The next date has to move to Oct 15.
 *  - Linking at import claims only the rows an upload brings in. An October
 *    row imported BEFORE this script runs is never revisited, so this script
 *    attaches it too when it is there.
 *  - From October on, a lease payment links by absorption only when it prints
 *    the same normalized descriptor as the attached September row.
 *  - The $1,000.00: first-posting never claims it (Car insurance is $357.58
 *    and already posts). Absorption claims it only when it prints Progressive's
 *    card descriptor "PROGRESSIVE INS 800-776-4737"; an ACH descriptor links
 *    nothing. So it may arrive linked `detected` — this makes it his link.
 *
 * ## What is written, in ONE transaction, behind a restore point
 *
 *  1. `Car lease`: user_next_expected_on 2026-09-15 → 2026-10-15. Nothing else.
 *  2. `attachTransactions(Car lease, …)`: the September $695.04 row, and the
 *     October one when it has already been imported.
 *  3. `attachTransactions(Car insurance, …)`: the September −$1,000.00 row.
 *
 * The app's own functions, so both series settle through recomputeSeriesStats.
 *
 * ## Which rows — every rule required; anything else refuses
 *
 *  - Lease: on Wells Fargo ····5481, active, −$695.04, not in a transfer
 *    group. Exactly one posted 2026-09-01 … 09-18, and at most one posted
 *    2026-10-12 … 10-18. No $695.04 row anywhere else in the ledger, on any
 *    account, in any status but superseded.
 *  - Insurance: on Wells Fargo ····5481, active, −$1,000.00, posted in
 *    September 2026, not in a transfer group, and its description names
 *    Progressive — exactly one. When the statement prints it without that
 *    name, the refusal lists every candidate; pass `--insurance-row=<id>`
 *    once the main session has read the statement line.
 *  - Each target is unlinked, or already linked to ITS series (`detected` by
 *    an import rule, or `user` by this script). A row the owner detached, or
 *    one linked to another series, refuses.
 *  - The series are exactly as the owner's decisions left them: both
 *    confirmed; the lease at −$695.04, ending 2028-08-15, next 2026-09-15 (or
 *    2026-10-15 once applied); the insurance at −$357.58, next 2026-12-11,
 *    ending 2027-01-11.
 *
 * ## Guards — before vs after, on the rehearsal copy and again on the ledger
 *
 * every `daily_balances` row · transaction counts per status · every
 * transaction column but the two link columns (and `updated_at`) · the links
 * change on exactly the target rows, each to `user` on its series · no series
 * row changes but the two · the lease's next date moved and no other owner
 * column of either series · the lease owes $0.00 for each month it has a row
 * attached · what `Car insurance` and the Nov 11 one-off owe in each month
 * Sep 2026 … Jan 2027 is unchanged.
 *
 *   pnpm tsx scripts/link-car-payments-2026-09.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/link-car-payments-2026-09.ts --db=data/moneyapp.db --confirm
 *
 * The dry run rehearses the whole write and every guard on a throwaway copy.
 * `--confirm` rehearses again, takes a restore point, writes and re-checks.
 * A second run prints "ALREADY APPLIED".
 */
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { overdueForSeries } from "@/services/arrears";
import { setSeriesOverrides } from "@/services/recurring-detail";
import { attachTransactions } from "@/services/recurring-links";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, statusCounts } from "./guarded-write-harness";

export const WELLS_FARGO_ID = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
export const CAR_LEASE_ID = "019ff202-9d0b-7000-9d80-6c48210459b3";
export const CAR_INSURANCE_ID = "019ff202-9d0c-7000-96e8-d678b7d13783";
const NOV_BALANCE_ID = "01a0a16d-a995-7000-8066-28d95df0897a";

const LEASE_CENTS = -69_504;
const LEASE_ENDS = "2028-08-15";
const LEASE_NEXT_BEFORE = "2026-09-15";
const LEASE_NEXT_AFTER = "2026-10-15";
const INSURANCE_CENTS = -35_758;
const INSURANCE_NEXT = "2026-12-11";
const INSURANCE_ENDS = "2027-01-11";
const EARLY_INSURANCE_CENTS = -100_000;
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" } as const;

/** Where a lease payment may sit: the early September one, and October's on the 15th. */
const LEASE_WINDOWS = [
  { month: "September", from: "2026-09-01", to: "2026-09-18", required: true, owedFrom: "2026-09-01", owedTo: "2026-09-30" },
  { month: "October", from: "2026-10-12", to: "2026-10-18", required: false, owedFrom: "2026-10-01", owedTo: "2026-10-31" },
] as const;
type LeaseMonth = (typeof LEASE_WINDOWS)[number]["month"];

/** Sep 2026 … Jan 2027: what the two insurance series owe must not move. */
const INSURANCE_MONTHS = [
  ["2026-09-01", "2026-09-30"],
  ["2026-10-01", "2026-10-31"],
  ["2026-11-01", "2026-11-30"],
  ["2026-12-01", "2026-12-31"],
  ["2027-01-01", "2027-01-31"],
] as const;

interface LedgerRow {
  id: string;
  account_id: string;
  posted_on: string;
  amount_cents: number;
  status: string;
  recurring_series_id: string | null;
  series_link_source: string | null;
  transfer_group_id: string | null;
  raw_description: string;
}

interface SeriesRow {
  id: string;
  name: string;
  status: string;
  user_amount_cents: number | null;
  user_next_expected_on: string | null;
  user_ends_on: string | null;
  user_cadence: string | null;
}

interface Target {
  row: LedgerRow;
  seriesId: string;
  /** the lease month that must owe $0.00 once this row is attached */
  leaseMonth?: LeaseMonth;
}

type Verdict =
  | { kind: "plan"; targets: Target[] }
  | { kind: "applied"; targets: Target[] }
  | { kind: "refuse"; reasons: string[] };

const LEDGER_COLUMNS =
  "id, account_id, posted_on, amount_cents, status, recurring_series_id, series_link_source, transfer_group_id, raw_description";

function rowsAt(bundle: DbBundle, amountCents: number): LedgerRow[] {
  return bundle.sqlite
    .prepare(`SELECT ${LEDGER_COLUMNS} FROM transactions WHERE amount_cents = ? AND status != 'superseded' ORDER BY posted_on, id`)
    .all(amountCents) as LedgerRow[];
}

function seriesById(bundle: DbBundle, id: string): SeriesRow | undefined {
  return bundle.sqlite
    .prepare("SELECT id, name, status, user_amount_cents, user_next_expected_on, user_ends_on, user_cadence FROM recurring_series WHERE id = ?")
    .get(id) as SeriesRow | undefined;
}

function describeRow(row: LedgerRow): string {
  return `${row.id} ${row.posted_on} ${formatCents(row.amount_cents)} ${row.status} "${row.raw_description}" link=${row.recurring_series_id ?? "-"}/${row.series_link_source ?? "-"}`;
}

/** The series exactly as the owner's decisions left them — or as this script leaves the lease. */
function seriesProblems(bundle: DbBundle): string[] {
  const lease = seriesById(bundle, CAR_LEASE_ID);
  const insurance = seriesById(bundle, CAR_INSURANCE_ID);
  const problems: string[] = [];
  const leaseNextOk = lease?.user_next_expected_on === LEASE_NEXT_BEFORE || lease?.user_next_expected_on === LEASE_NEXT_AFTER;
  if (lease?.status !== "confirmed" || lease.user_amount_cents !== LEASE_CENTS || lease.user_ends_on !== LEASE_ENDS || !leaseNextOk) {
    problems.push(`Car lease is not as the owner left it: ${JSON.stringify(lease)}`);
  }
  if (
    insurance?.status !== "confirmed" ||
    insurance.user_amount_cents !== INSURANCE_CENTS ||
    insurance.user_next_expected_on !== INSURANCE_NEXT ||
    insurance.user_ends_on !== INSURANCE_ENDS
  ) {
    problems.push(`Car insurance is not as the owner left it: ${JSON.stringify(insurance)}`);
  }
  return problems;
}

/** A target may be unlinked or linked to its own series; nothing else. */
function linkProblem(row: LedgerRow, seriesId: string, label: string): string | null {
  if (row.status !== "active") return `${label} is ${row.status}, not active: ${describeRow(row)}`;
  if (row.transfer_group_id !== null) return `${label} sits in a transfer group: ${describeRow(row)}`;
  if (row.account_id !== WELLS_FARGO_ID) return `${label} is not on Wells Fargo ····5481: ${describeRow(row)}`;
  const unlinked = row.recurring_series_id === null && row.series_link_source === null;
  const ours = row.recurring_series_id === seriesId && (row.series_link_source === "detected" || row.series_link_source === "user");
  return unlinked || ours ? null : `${label} is linked elsewhere, or was detached by the owner: ${describeRow(row)}`;
}

function leaseTargets(bundle: DbBundle, reasons: string[]): Target[] {
  const rows = rowsAt(bundle, LEASE_CENTS);
  const inWindow = (r: LedgerRow, w: (typeof LEASE_WINDOWS)[number]) =>
    r.account_id === WELLS_FARGO_ID && r.posted_on >= w.from && r.posted_on <= w.to;
  for (const row of rows) {
    if (!LEASE_WINDOWS.some((w) => inWindow(row, w))) reasons.push(`a $695.04 row the plan does not expect: ${describeRow(row)}`);
  }
  const targets: Target[] = [];
  for (const window of LEASE_WINDOWS) {
    const hits = rows.filter((r) => inWindow(r, window));
    if (hits.length === 0 && window.required) {
      reasons.push(`no Wells Fargo $695.04 row posted ${window.from} … ${window.to} — is the statement imported?`);
    }
    if (hits.length > 1) reasons.push(`${hits.length} Wells Fargo $695.04 rows in ${window.month}: ${hits.map(describeRow).join(" | ")}`);
    if (hits.length !== 1) continue;
    const problem = linkProblem(hits[0]!, CAR_LEASE_ID, `the ${window.month} lease payment`);
    if (problem) reasons.push(problem);
    targets.push({ row: hits[0]!, seriesId: CAR_LEASE_ID, leaseMonth: window.month });
  }
  return targets;
}

function insuranceTarget(bundle: DbBundle, override: string | null, reasons: string[]): Target | null {
  const september = rowsAt(bundle, EARLY_INSURANCE_CENTS).filter(
    (r) => r.account_id === WELLS_FARGO_ID && r.posted_on >= SEPTEMBER.from && r.posted_on <= SEPTEMBER.to,
  );
  const picked = september.filter((r) => (override === null ? /progressive/i.test(r.raw_description) : r.id === override));
  if (picked.length !== 1) {
    const listing = september.length === 0 ? "none" : september.map(describeRow).join(" | ");
    reasons.push(
      override === null
        ? `expected ONE Wells Fargo −$1,000.00 September row naming Progressive, found ${picked.length}; September −$1,000.00 rows: ${listing}`
        : `--insurance-row=${override} is not a Wells Fargo −$1,000.00 September row; candidates: ${listing}`,
    );
    return null;
  }
  const problem = linkProblem(picked[0]!, CAR_INSURANCE_ID, "the $1,000.00 insurance payment");
  if (problem) reasons.push(problem);
  return { row: picked[0]!, seriesId: CAR_INSURANCE_ID };
}

function planFor(bundle: DbBundle, insuranceOverride: string | null): Verdict {
  const reasons = seriesProblems(bundle);
  const targets = leaseTargets(bundle, reasons);
  const insurance = insuranceTarget(bundle, insuranceOverride, reasons);
  if (insurance) targets.push(insurance);
  if (reasons.length > 0) return { kind: "refuse", reasons };
  const done =
    seriesById(bundle, CAR_LEASE_ID)?.user_next_expected_on === LEASE_NEXT_AFTER &&
    targets.every((t) => t.row.recurring_series_id === t.seriesId && t.row.series_link_source === "user");
  return { kind: done ? "applied" : "plan", targets };
}

function apply(bundle: DbBundle, targets: readonly Target[], today: string): void {
  bundle.db.transaction((tx) => {
    // the schedule first, so the attach settles the lease's stats against it
    setSeriesOverrides(tx, CAR_LEASE_ID, { userNextExpectedOn: LEASE_NEXT_AFTER });
    for (const seriesId of [CAR_LEASE_ID, CAR_INSURANCE_ID]) {
      const ids = targets.filter((t) => t.seriesId === seriesId).map((t) => t.row.id);
      if (ids.length > 0) attachTransactions(tx, seriesId, ids, today);
    }
  });
}

interface State {
  balances: string;
  statusCounts: string;
  besideLinks: Map<string, string>;
  links: Map<string, string>;
  series: Map<string, string>;
  leaseOwed: Map<LeaseMonth, number>;
  insuranceOwed: string;
}

function captureState(bundle: DbBundle): State {
  const txns = bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[];
  const besideLinks = new Map<string, string>();
  const links = new Map<string, string>();
  for (const t of txns) {
    const { recurring_series_id: seriesId, series_link_source: source, updated_at: _updatedAt, ...rest } = t;
    besideLinks.set(String(t.id), JSON.stringify(rest));
    links.set(String(t.id), `${String(seriesId ?? "-")}|${String(source ?? "-")}`);
  }
  const allSeries = bundle.sqlite.prepare("SELECT * FROM recurring_series ORDER BY id").all() as Record<string, unknown>[];
  const owed = (id: string, from: string, to: string) => overdueForSeries(bundle.db, new Set([id]), from, to, to).totalCents;
  return {
    balances: balancesHash(bundle),
    statusCounts: statusCounts(bundle),
    besideLinks,
    links,
    series: new Map(allSeries.map((s) => [String(s.id), JSON.stringify(s)])),
    leaseOwed: new Map(LEASE_WINDOWS.map((w) => [w.month, owed(CAR_LEASE_ID, w.owedFrom, w.owedTo)] as const)),
    insuranceOwed: JSON.stringify(INSURANCE_MONTHS.map(([from, to]) => [owed(CAR_INSURANCE_ID, from, to), owed(NOV_BALANCE_ID, from, to)])),
  };
}

/** The lease's next date moved to Oct 15; every other owner column of both series stayed. */
function scheduleFailures(before: State, after: State): string[] {
  const owner = (state: State, id: string) => {
    const s = JSON.parse(state.series.get(id) ?? "{}") as Record<string, unknown>;
    return { amount: s.user_amount_cents, next: s.user_next_expected_on, ends: s.user_ends_on, cadence: s.user_cadence, status: s.status };
  };
  const failures: string[] = [];
  const [leaseBefore, leaseAfter] = [owner(before, CAR_LEASE_ID), owner(after, CAR_LEASE_ID)];
  if (leaseAfter.next !== LEASE_NEXT_AFTER) failures.push(`Car lease next date is ${String(leaseAfter.next)}`);
  if (JSON.stringify({ ...leaseBefore, next: null }) !== JSON.stringify({ ...leaseAfter, next: null })) {
    failures.push(`Car lease owner columns moved: ${JSON.stringify(leaseBefore)} → ${JSON.stringify(leaseAfter)}`);
  }
  if (JSON.stringify(owner(before, CAR_INSURANCE_ID)) !== JSON.stringify(owner(after, CAR_INSURANCE_ID))) {
    failures.push("Car insurance owner columns moved");
  }
  return failures;
}

function compareStates(before: State, after: State, targets: readonly Target[]): string[] {
  const failures: string[] = [];
  if (before.balances !== after.balances) failures.push("a daily_balances row moved");
  if (before.statusCounts !== after.statusCounts) failures.push(`status counts moved: ${before.statusCounts} → ${after.statusCounts}`);
  const beside = changedKeys(before.besideLinks, after.besideLinks);
  if (beside.length > 0) failures.push(`a column other than the link changed on ${beside.length} rows: ${beside.slice(0, 5).join(", ")}`);
  const expected = targets.filter((t) => before.links.get(t.row.id) !== `${t.seriesId}|user`).map((t) => t.row.id).sort();
  const moved = changedKeys(before.links, after.links);
  if (JSON.stringify(moved) !== JSON.stringify(expected)) failures.push(`links moved on ${JSON.stringify(moved)}, expected ${JSON.stringify(expected)}`);
  for (const t of targets) {
    if (after.links.get(t.row.id) !== `${t.seriesId}|user`) failures.push(`${t.row.id} is not the owner's link on ${t.seriesId}`);
    if (t.leaseMonth !== undefined && after.leaseOwed.get(t.leaseMonth) !== 0) {
      failures.push(`Car lease still owes ${formatCents(after.leaseOwed.get(t.leaseMonth) ?? 0)} for ${t.leaseMonth}`);
    }
  }
  const seriesMoved = changedKeys(before.series, after.series).filter((id) => id !== CAR_LEASE_ID && id !== CAR_INSURANCE_ID);
  if (seriesMoved.length > 0) failures.push(`series other than the two moved: ${seriesMoved.join(", ")}`);
  failures.push(...scheduleFailures(before, after));
  if (before.insuranceOwed !== after.insuranceOwed) failures.push(`insurance owed moved: ${before.insuranceOwed} → ${after.insuranceOwed}`);
  return failures;
}

function printVerdict(label: string, verdict: Verdict, state?: State): void {
  console.log(`\n── ${label}: ${verdict.kind.toUpperCase()}`);
  if (verdict.kind === "refuse") for (const r of verdict.reasons) console.log(`  ✗ ${r}`);
  else for (const t of verdict.targets) console.log(`  ${t.seriesId === CAR_LEASE_ID ? "Car lease    " : "Car insurance"} ← ${describeRow(t.row)}`);
  if (state) console.log(`  Car lease owes: ${[...state.leaseOwed].map(([m, c]) => `${m} ${formatCents(c)}`).join(" · ")}`);
}

/** The write and every guard on a throwaway copy; returns the failures. */
function rehearse(copy: DbBundle, insuranceOverride: string | null, today: string): string[] {
  const verdict = planFor(copy, insuranceOverride);
  if (verdict.kind !== "plan") return [`the copy planned ${verdict.kind}, not a write`];
  const before = captureState(copy);
  apply(copy, verdict.targets, today);
  const failures = compareStates(before, captureState(copy), verdict.targets);
  const again = planFor(copy, insuranceOverride);
  if (again.kind !== "applied") failures.push(`a second run on the copy planned ${again.kind}, not ALREADY APPLIED`);
  return failures;
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const insuranceOverride = args.value("insurance-row");
  const today = todayIso();
  const real = createDatabase(args.db);
  try {
    const verdict = planFor(real, insuranceOverride);
    printVerdict(`plan on ${args.db} (today ${today})`, verdict, verdict.kind === "refuse" ? undefined : captureState(real));
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do");
    if (verdict.kind === "refuse") return void (process.exitCode = 1);

    const rehearsal = await onRehearsalCopy(real, args.scratch, "link-car-payments", (copy) => rehearse(copy, insuranceOverride, today));
    if (rehearsal.length > 0) {
      for (const f of rehearsal) console.log(`  ✗ rehearsal: ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ rehearsed on a copy: every guard holds, and a second run is ALREADY APPLIED");
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm.");

    const before = captureState(real);
    withPreMutationSnapshot(real.db, "link-car-payments-2026-09", () => apply(real, verdict.targets, today));
    const after = captureState(real);
    const failures = compareStates(before, after, verdict.targets);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-link-car-payments-2026-09.db restore point:\n${failures.join("\n")}`);
    }
    printVerdict("after", planFor(real, insuranceOverride), after);
    console.log("APPLIED — every guard holds");
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
