/**
 * The owner's answer (2) of 2026-09-15, as plan, write and guards: Chase
 * Checking's 2026-03-02 −$115.00 and +$115.00 "Cancelled" are ONE cancelled
 * transfer that nets to zero, so the transfers card stops calling the +$115.00
 * an arrival from an unknown account. No balance moves. The CLI is
 * `scripts/pair-checking-115-reversal-2026-09-15.ts`; everything here is
 * importable so the classification and the guard comparison are unit-tested.
 *
 * ## Measured, read-only, on the live ledger (2026-09-15)
 *
 * Chase3522_Activity_20260710.CSV prints three card-9805 rows on 03/02/2026
 * (lines 293, 294, 300), all three active on Chase Checking, category Credit
 * Card Payment, categorized by `claude`, no split, no series:
 *
 *  | row      | occ | amount   | raw description                                 | group                         |
 *  |----------|-----|----------|-------------------------------------------------|-------------------------------|
 *  | …7081    | 0   | −$115.00 | Payment to Chase card ending in 9805 03/02      | none, and nothing names it    |
 *  | …7d70    | 1   | −$115.00 | Payment to Chase card ending in 9805 03/02      | none — Sapphire +$115.00 …eff6 names it |
 *  | …7694    | 0   | +$115.00 | Payment to Chase card ending in 9805 Cancelled  | none                          |
 *
 * Sapphire's 20260302 statement prints ONE `03/02 … -115.00` payment. So one
 * debit paid the card — answer (1), …7d70 ↔ Sapphire …eff6, written by
 * `link-sapphire-one-leg-groups-2026-09-15.ts` — and the other came straight
 * back: answer (2), …7081 + …7694. The two debits print identically; the group
 * id Sapphire's leg already carries names …7d70, so …7081 is the one that was
 * cancelled, and the two answers never claim the same row.
 *
 * What the Sapphire attach did here (restore point
 * `pre-2026-09-15T100706-attach-sapphire-payment-rows.db`, read-only): …7694 was
 * grouped with the hand-built Sapphire −$115.00 "…Cancelled" (…7008), and the
 * hand-built Sapphire +$115.00 occurrence 1 (…7006) named …7081. The attach
 * superseded …7008 and …7006 and unlinked …7694 — the +$115.00 leg, which the
 * 2026-09-15 handoff calls "the Checking −$115 Cancelled leg".
 *
 * ## How it is recorded — the app's own record, not a new one
 *
 * A transfer group is the one thing the app has that says two rows are ONE
 * movement. The group is keyed by the outflow leg (…7081), the detector's
 * convention. Both legs keep Credit Card Payment and `claude`: not
 * `linkTransferPair`, which refuses one account and stamps `user` — a false
 * claim of the owner's hand, which the un-import confirmation counts. The
 * transfers card and /flow read the shape through transfer-links'
 * `isCancelledTransfer` (fix(transfers), the commit before this one); without
 * it the link made the −$115.00 a LINKED departure and the stranded clause say
 * its partner was "not inside these months".
 *
 * Refused: `excluded` on both rows — two unrelated flags rather than one
 * transfer, set through the owner's own "Exclude from analytics" switch; and
 * `superseded` — the bank printed both, and superseded means never moved money.
 *
 * ## Guards — refuse on anything but the measured before-state or this write's after-state
 *
 * each leg: account, day, amount, active, category, source, raw text, no split ·
 * answer (1) applied (…7d70 grouped with exactly Sapphire …eff6) · no row names
 * the Cancelled leg as its group · then, before vs after: every `daily_balances`
 * row · net worth on every day · active count and sum per account · statuses ·
 * every statement period · every transaction column but `transfer_group_id`
 * (and `updated_at`) · the group moved on exactly the two legs · one-leg groups
 * unchanged, one-account groups +1 · the transfers card (read on the day the
 * owner answered) moves by exactly: moved −$115.00, departures −1, unpaired −1
 * and −$115.00, arrivals −1 and −$115.00, cancelled +1 and +$115.00, nothing
 * else · /flow over its window: groups +1, `cancelled` +1, nothing else.
 */
import os from "node:os";
import path from "node:path";
import { and, inArray, isNull } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { periodBounds } from "@/lib/dates";
import { netWorthSeries } from "@/services/derivation";
import { transferFlow } from "@/services/transfer-flow";
import { transfersCard } from "@/services/transfers-card";
import { dbTargetFrom, strayFlags, type DbTargetOptions } from "./db-target";
import { balancesHash, changedKeys, sha256Json, statusCounts } from "./guarded-write-harness";

/** Which rows the write is about — pinned to the live ledger in `REAL_IDS`, seeded ids in the tests. */
export interface ReversalIds {
  readonly checkingAccountId: string;
  readonly creditCardPaymentId: string;
  readonly day: string;
  readonly cents: number;
  /** the cancelled −$115.00 — it keys the group */
  readonly sentId: string;
  /** the +$115.00 "…Cancelled" */
  readonly cancelledId: string;
  /** the −$115.00 that paid the card — answer (1)'s leg */
  readonly paidId: string;
  /** Sapphire's +$115.00, answer (1)'s partner */
  readonly paidSapphireId: string;
  readonly sentDescription: string;
  readonly cancelledDescription: string;
  /**
   * The day the transfers card is READ on for the guard — the day the owner
   * answered, whose window (Mar–Aug 2026) holds `day`. Read-only; nothing is
   * dated by it. Read on a later day, 2026-03-02 would leave the window and the
   * guard would refuse a correct write.
   */
  readonly cardDay: string;
}

export const REAL_IDS: ReversalIds = {
  checkingAccountId: "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722",
  creditCardPaymentId: "019f4c7d-cc8c-774c-b128-98b85c21162e",
  day: "2026-03-02",
  cents: 11_500,
  sentId: "019f4ca7-a6cc-7081-bee2-87b82db8b194",
  cancelledId: "019f4ca7-a6cd-7694-9efd-664fae9f334e",
  paidId: "019f4ca7-a6cc-7d70-93d1-0295d19aa1ed",
  paidSapphireId: "019f4ea0-240c-7003-bc3d-8f309bfdeff6",
  sentDescription: "Payment to Chase card ending in 9805 03/02",
  cancelledDescription: "Payment to Chase card ending in 9805 Cancelled",
  cardDay: "2026-09-15",
};

export const SNAPSHOT_LABEL = "pair-checking-115-reversal";

/** Nothing was written: the command line or the ledger is not what this write expects. */
export class ReversalRefusal extends Error {}

export interface LegRow {
  id: string;
  account_id: string;
  posted_on: string;
  amount_cents: number;
  status: string;
  transfer_group_id: string | null;
  category_id: string | null;
  categorization_source: string | null;
  raw_description: string;
  splits: number;
}

export interface ReversalFacts {
  sent: LegRow | undefined;
  cancelled: LegRow | undefined;
  paid: LegRow | undefined;
  /** every row, any status, whose group is the sent leg's id — sorted */
  namingSent: readonly string[];
  /** every row, any status, whose group is the Cancelled leg's id — must stay empty */
  namingCancelled: readonly string[];
  /** live members of the paid leg's group — sorted */
  paidGroup: readonly string[];
}

export type ReversalVerdict = { kind: "plan" } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const sameIds = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** The measured before-state, this write's after-state, or a refusal that says what is off. */
export function classifyReversal(facts: ReversalFacts, ids: ReversalIds = REAL_IDS): ReversalVerdict {
  const reasons: string[] = [];
  const expectLeg = (row: LegRow | undefined, name: string, cents: number, description: string): void => {
    const ok =
      row !== undefined &&
      row.account_id === ids.checkingAccountId &&
      row.posted_on === ids.day &&
      row.amount_cents === cents &&
      row.status === "active" &&
      row.category_id === ids.creditCardPaymentId &&
      row.categorization_source === "claude" &&
      row.raw_description === description &&
      row.splits === 0;
    if (!ok) reasons.push(`${name} is not as measured: ${JSON.stringify(row ?? null)}`);
  };
  expectLeg(facts.sent, "the sent −$115.00", -ids.cents, ids.sentDescription);
  expectLeg(facts.cancelled, "the +$115.00 Cancelled", ids.cents, ids.cancelledDescription);

  const paid = facts.paid;
  const answerOneApplied =
    paid !== undefined &&
    paid.account_id === ids.checkingAccountId &&
    paid.posted_on === ids.day &&
    paid.amount_cents === -ids.cents &&
    paid.status === "active" &&
    paid.transfer_group_id === ids.paidId &&
    sameIds(facts.paidGroup, [ids.paidId, ids.paidSapphireId]);
  if (!answerOneApplied) {
    reasons.push(
      `answer (1) is not applied — run scripts/link-sapphire-one-leg-groups-2026-09-15.ts first: ${JSON.stringify({ paid: paid ?? null, group: facts.paidGroup })}`,
    );
  }
  if (facts.namingCancelled.length > 0) reasons.push(`rows hold the Cancelled leg's id as their group: ${facts.namingCancelled.join(", ")}`);
  if (reasons.length > 0) return { kind: "refuse", reasons };

  const sentGroup = facts.sent!.transfer_group_id;
  const cancelledGroup = facts.cancelled!.transfer_group_id;
  if (sentGroup === null && cancelledGroup === null && facts.namingSent.length === 0) return { kind: "plan" };
  if (sentGroup === ids.sentId && cancelledGroup === ids.sentId && sameIds(facts.namingSent, [ids.sentId, ids.cancelledId])) {
    return { kind: "applied" };
  }
  return {
    kind: "refuse",
    reasons: [
      `neither the measured state nor the applied one: sent leg group ${String(sentGroup)}, Cancelled leg group ${String(cancelledGroup)}, group ${ids.sentId} held by ${JSON.stringify(facts.namingSent)}`,
    ],
  };
}

export function loadFacts({ sqlite }: DbBundle, ids: ReversalIds = REAL_IDS): ReversalFacts {
  const leg = (id: string): LegRow | undefined =>
    sqlite
      .prepare(
        `SELECT t.id, t.account_id, t.posted_on, t.amount_cents, t.status, t.transfer_group_id, t.category_id,
                t.categorization_source, t.raw_description,
                (SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = t.id) AS splits
           FROM transactions t WHERE t.id = ?`,
      )
      .get(id) as LegRow | undefined;
  const naming = (groupId: string, liveOnly: boolean): string[] =>
    (
      sqlite
        .prepare(`SELECT id FROM transactions WHERE transfer_group_id = ? ${liveOnly ? "AND status != 'superseded'" : ""} ORDER BY id`)
        .all(groupId) as { id: string }[]
    ).map((r) => r.id);
  return {
    sent: leg(ids.sentId),
    cancelled: leg(ids.cancelledId),
    paid: leg(ids.paidId),
    namingSent: naming(ids.sentId, false),
    namingCancelled: naming(ids.cancelledId, false),
    paidGroup: naming(ids.paidId, true),
  };
}

/** The write: the group id on exactly the two legs, in ONE transaction; any other row count rolls back. */
export function applyReversal({ db }: DbBundle, ids: ReversalIds = REAL_IDS): void {
  db.transaction((tx) => {
    const changes = tx
      .update(transactions)
      .set({ transferGroupId: ids.sentId })
      .where(and(inArray(transactions.id, [ids.sentId, ids.cancelledId]), isNull(transactions.transferGroupId)))
      .run().changes;
    if (changes !== 2) throw new Error(`expected to link the 2 Chase Checking legs, linked ${changes}`);
  });
}

/** What the transfers card and /flow say — the figures this write is FOR. */
export interface TransferFigures {
  movedCents: number;
  departureCount: number;
  linkedCount: number;
  linkedCents: number;
  unpairedCount: number;
  unpairedCents: number;
  mirrorCount: number;
  mirrorCents: number;
  strandedCents: number;
  routedCents: number;
  arrivalCount: number;
  arrivalCents: number;
  cancelledCount: number;
  cancelledCents: number;
  flowGroups: number;
  flowPaired: number;
  flowGrossCents: number;
  flowReasons: Readonly<Record<string, number>>;
}

export function transferFigures({ db }: DbBundle, cardDay: string): TransferFigures {
  const card = transfersCard(db, cardDay);
  if (card === null) throw new ReversalRefusal(`the transfers card read on ${cardDay} is empty`);
  const flow = transferFlow(db, { from: `${card.fromMonth}-01`, to: periodBounds(`${card.toMonth}-01`, "monthly").end });
  return {
    movedCents: card.movedCents,
    departureCount: card.departureCount,
    linkedCount: card.proof.linkedCount,
    linkedCents: card.proof.linkedCents,
    unpairedCount: card.proof.unpairedCount,
    unpairedCents: card.proof.unpairedCents,
    mirrorCount: card.proof.mirrorCount,
    mirrorCents: card.proof.mirrorCents,
    strandedCents: card.proof.strandedCents,
    routedCents: card.routedCents,
    arrivalCount: card.arrivalCount,
    arrivalCents: card.arrivalCents,
    cancelledCount: card.cancelledCount,
    cancelledCents: card.cancelledCents,
    flowGroups: flow.totals.groupCount,
    flowPaired: flow.totals.pairedGroupCount,
    flowGrossCents: flow.totals.grossCents,
    flowReasons: { ...flow.totals.unattributedByReason },
  };
}

/** Exactly what the write is meant to do to the figures: one cancelled transfer out of the departures and the arrivals. */
export function expectedFigures(before: TransferFigures, cents: number): TransferFigures {
  return {
    ...before,
    movedCents: before.movedCents - cents,
    departureCount: before.departureCount - 1,
    unpairedCount: before.unpairedCount - 1,
    unpairedCents: before.unpairedCents - cents,
    arrivalCount: before.arrivalCount - 1,
    arrivalCents: before.arrivalCents - cents,
    cancelledCount: before.cancelledCount + 1,
    cancelledCents: before.cancelledCents + cents,
    flowGroups: before.flowGroups + 1,
    flowReasons: { ...before.flowReasons, cancelled: (before.flowReasons.cancelled ?? 0) + 1 },
  };
}

export interface ReversalState {
  balances: string;
  netWorth: string;
  lastNetWorth: { day: string; cents: number } | null;
  active: { count: number; cents: number };
  activeByAccount: string;
  statusCounts: string;
  statementPeriods: string;
  /** every transaction column but the group and updated_at, per row */
  besideGroup: ReadonlyMap<string, string>;
  groups: ReadonlyMap<string, string>;
  oneLegGroups: number;
  oneAccountGroups: number;
  figures: TransferFigures;
}

export function captureReversalState(bundle: DbBundle, ids: ReversalIds = REAL_IDS): ReversalState {
  const { sqlite, db } = bundle;
  const rows = sqlite.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[];
  const besideGroup = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const row of rows) {
    const { transfer_group_id: group, updated_at: _updatedAt, ...rest } = row;
    besideGroup.set(String(row.id), JSON.stringify(rest));
    groups.set(String(row.id), String(group ?? "-"));
  }
  const count = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;
  const worth = netWorthSeries(db);
  const last = worth.at(-1);
  const active = sqlite.prepare("SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS s FROM transactions WHERE status = 'active'").get() as {
    n: number;
    s: number;
  };
  return {
    balances: balancesHash(bundle),
    netWorth: sha256Json(worth.map((p) => [p.day, p.totalCents])),
    lastNetWorth: last === undefined ? null : { day: last.day, cents: last.totalCents },
    active: { count: active.n, cents: active.s },
    activeByAccount: sha256Json(
      sqlite
        .prepare("SELECT account_id, count(*) AS n, sum(amount_cents) AS s FROM transactions WHERE status = 'active' GROUP BY account_id ORDER BY account_id")
        .all(),
    ),
    statusCounts: statusCounts(bundle),
    statementPeriods: sha256Json(sqlite.prepare("SELECT * FROM statement_periods ORDER BY id").all()),
    besideGroup,
    groups,
    oneLegGroups: count(
      `SELECT count(*) AS n FROM (SELECT transfer_group_id FROM transactions
        WHERE transfer_group_id IS NOT NULL AND status != 'superseded' GROUP BY transfer_group_id HAVING count(*) = 1)`,
    ),
    oneAccountGroups: count(
      `SELECT count(*) AS n FROM (SELECT transfer_group_id FROM transactions
        WHERE transfer_group_id IS NOT NULL AND status != 'superseded'
        GROUP BY transfer_group_id HAVING count(*) >= 2 AND count(DISTINCT account_id) = 1)`,
    ),
    figures: transferFigures(bundle, ids.cardDay),
  };
}

/** Every guard, before vs after. Empty means the write did exactly what it says and nothing else. */
export function compareReversal(before: ReversalState, after: ReversalState, ids: ReversalIds = REAL_IDS): string[] {
  const failures: string[] = [];
  const same = (name: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) failures.push(`${name} moved: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  };
  same("daily_balances", before.balances, after.balances);
  same("net worth on every day", before.netWorth, after.netWorth);
  same("active rows (count and sum)", before.active, after.active);
  same("active rows per account", before.activeByAccount, after.activeByAccount);
  same("status counts", before.statusCounts, after.statusCounts);
  same("statement periods", before.statementPeriods, after.statementPeriods);
  same("one-leg groups", before.oneLegGroups, after.oneLegGroups);

  const beside = changedKeys(before.besideGroup, after.besideGroup);
  if (beside.length > 0) failures.push(`a column other than the group changed on ${beside.length} rows: ${beside.slice(0, 5).join(", ")}`);
  const moved = changedKeys(before.groups, after.groups);
  const legs = sorted([ids.sentId, ids.cancelledId]);
  if (JSON.stringify(moved) !== JSON.stringify(legs)) failures.push(`the group moved on ${JSON.stringify(moved)}, expected ${JSON.stringify(legs)}`);
  if (!legs.every((id) => after.groups.get(id) === ids.sentId)) failures.push(`the two legs do not both hold group ${ids.sentId}`);
  if (after.oneAccountGroups !== before.oneAccountGroups + 1) {
    failures.push(`one-account groups ${before.oneAccountGroups} → ${after.oneAccountGroups}, expected +1`);
  }
  const expected = expectedFigures(before.figures, ids.cents);
  for (const key of Object.keys(expected) as (keyof TransferFigures)[]) {
    if (JSON.stringify(after.figures[key]) !== JSON.stringify(expected[key])) {
      failures.push(`transfers ${key}: ${JSON.stringify(before.figures[key])} → ${JSON.stringify(after.figures[key])}, expected ${JSON.stringify(expected[key])}`);
    }
  }
  return failures;
}

export interface Rehearsal {
  failures: string[];
  before: ReversalState;
  after: ReversalState;
}

/** Plan, write, guard and re-plan on `copy` — a throwaway `.backup` in the CLI, a seeded ledger in the tests. */
export function rehearseReversal(copy: DbBundle, ids: ReversalIds = REAL_IDS): Rehearsal {
  const verdict = classifyReversal(loadFacts(copy, ids), ids);
  if (verdict.kind !== "plan") throw new ReversalRefusal(`the rehearsal copy planned ${verdict.kind}, not a write`);
  const before = captureReversalState(copy, ids);
  applyReversal(copy, ids);
  const after = captureReversalState(copy, ids);
  const failures = compareReversal(before, after, ids);
  const again = classifyReversal(loadFacts(copy, ids), ids);
  if (again.kind !== "applied") failures.push(`a second run on the copy plans ${again.kind.toUpperCase()}, not ALREADY APPLIED`);
  return { failures, before, after };
}

export interface ReversalCli {
  dbPath: string;
  confirm: boolean;
  scratch: string;
}

/** `--db=<path>` (required, never guessed), `--confirm`, `--scratch=<dir>` — anything else is refused. */
export function parseReversalCli(argv: readonly string[], env: Pick<DbTargetOptions, "cwd" | "exists">): ReversalCli {
  const stray = [...strayFlags(argv, ["--db", "--confirm", "--scratch"]), ...argv.filter((a) => !a.startsWith("--"))];
  if (stray.length > 0) throw new ReversalRefusal(`unknown argument "${stray[0]}" — this write takes --db=<path>, --confirm and --scratch=<dir>`);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, ...env });
  const scratchArg = argv.find((a) => a.startsWith("--scratch="))?.slice("--scratch=".length);
  const scratch = scratchArg === undefined || scratchArg === "" ? os.tmpdir() : path.resolve(env.cwd, scratchArg);
  if (!env.exists(scratch)) throw new ReversalRefusal(`no scratch directory at ${scratch}`);
  return { dbPath: target.path, confirm: argv.includes("--confirm"), scratch };
}
