/**
 * REAL-DB WRITE — WAITS FOR THE OWNER'S YES. Nothing here runs until he
 * approves pairing these two card payments with the checking debits their own
 * group ids already name (audit of the Sapphire attach, 2026-09-15, "open
 * question 3").
 *
 * ## Measured, read-only, on the live ledger (2026-09-15)
 *
 * Two Chase Sapphire payment rows sit ALONE in a transfer group, and each
 * group's id is the id of one specific Chase Checking debit — which holds no
 * group itself. The 2026-07-11 reconstruction created the groups and never
 * stamped the checking side; neither debit held a group in any of the 80
 * backups that contain it.
 *
 *  | day        | Sapphire leg (group = the checking id)   | Chase Checking leg (group NULL)                                 |
 *  |------------|------------------------------------------|-----------------------------------------------------------------|
 *  | 2025-06-10 | +$20.00  019f4ea0-240b-7007-…-f4756be4d45f | −$20.00  019f4ca7-a6e0-7c01-…-8d4d2a0c4122 "Payment to Chase card ending in 9805 06/10" |
 *  | 2026-03-02 | +$115.00 019f4ea0-240c-7003-…-8f309bfdeff6 | −$115.00 019f4ca7-a6cc-7d70-…-0295d19aa1ed "Payment to Chase card ending in 9805 03/02" |
 *
 * The statements print exactly one `06/10 Payment Thank You-Mobile -20.00`
 * (20250702) and one `03/02 … -115.00` (20260302). The same-day +$20.00 on
 * checking is a Zelle in Reimbursements, not a card payment. On 2026-03-02
 * checking also holds a second −$115.00 (…7081) and the "Cancelled" +$115.00
 * reversal (…7694); the group id names …7d70, so those two are NOT touched —
 * how to represent that same-day reversal is a separate owner question.
 *
 * ## What is written — the link only, in ONE transaction, behind a restore point
 *
 * Each checking leg's `transfer_group_id` := its own id, which is the id its
 * Sapphire partner already carries — the detector's convention, the outflow
 * leg keys the group. Nothing else, on any row.
 *
 * ⛔ Not `linkTransferPair`: it refuses a leg already in a group (the Sapphire
 * leg is), and it stamps `categorization_source = 'user'` on both legs. These
 * four rows were categorized by `claude` and `transfer_detect`, never by hand,
 * and the un-import confirmation counts `user` rows as the owner's own work —
 * that stamp would be a false claim. The category (Credit Card Payment) is
 * already right on all four.
 *
 * ## Effect (audit, transfersCard over Mar–Aug 2026)
 *
 * linked departures 89 → 90, unpaired 22 → 21 ($2,683.34 → $2,568.34), a
 * Checking → Sapphire route +$115. The 2025 pair is outside that window.
 * Ledger-wide one-leg groups −2. No balance moves.
 *
 * ## Guards — refuse on anything but the measured before-state or this script's after-state
 *
 * each leg: account, day, amount, active, category, no split · each Sapphire
 * leg's group names its checking leg and holds only it (before) or both
 * (after) · the two untouched 2026-03-02 checking rows hold no group · then,
 * before vs after: every `daily_balances` row · status counts · every
 * transaction column but `transfer_group_id` (and `updated_at`) · the group
 * id changed on exactly the two checking legs · one-leg groups ledger-wide −2.
 *
 *   pnpm tsx scripts/link-sapphire-one-leg-groups-2026-09-15.ts --db=data/moneyapp.db
 *   pnpm tsx scripts/link-sapphire-one-leg-groups-2026-09-15.ts --db=data/moneyapp.db --confirm
 */
import { and, eq, isNull } from "drizzle-orm";
import { createDatabase, type DbBundle } from "@/db/client";
import { withPreMutationSnapshot } from "@/db/backup";
import { transactions } from "@/db/schema/transactions";
import { formatCents } from "@/lib/money";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, statusCounts } from "./guarded-write-harness";

const CHASE_CHECKING_ID = "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722";
export const SAPPHIRE_ID = "019f4ca7-a750-7f21-8ffa-2546cac01f3a";
const CREDIT_CARD_PAYMENT_ID = "019f4c7d-cc8c-774c-b128-98b85c21162e";

const PAIRS = [
  { day: "2025-06-10", cents: 2_000, sapphireId: "019f4ea0-240b-7007-9973-f4756be4d45f", checkingId: "019f4ca7-a6e0-7c01-8346-8d4d2a0c4122" },
  { day: "2026-03-02", cents: 11_500, sapphireId: "019f4ea0-240c-7003-bc3d-8f309bfdeff6", checkingId: "019f4ca7-a6cc-7d70-93d1-0295d19aa1ed" },
] as const;
type Pair = (typeof PAIRS)[number];

/** Chase Checking's other 2026-03-02 rows — the second −$115.00 and the "Cancelled" +$115.00 */
const UNTOUCHED_IDS = ["019f4ca7-a6cc-7081-bee2-87b82db8b194", "019f4ca7-a6cd-7694-9efd-664fae9f334e"] as const;

interface Leg {
  id: string;
  account_id: string;
  posted_on: string;
  amount_cents: number;
  status: string;
  transfer_group_id: string | null;
  category_id: string | null;
  splits: number;
}

type Verdict = { kind: "plan"; pairs: Pair[] } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

function leg(bundle: DbBundle, id: string): Leg | undefined {
  return bundle.sqlite
    .prepare(
      `SELECT id, account_id, posted_on, amount_cents, status, transfer_group_id, category_id,
              (SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = t.id) AS splits
       FROM transactions t WHERE id = ?`,
    )
    .get(id) as Leg | undefined;
}

function groupMembers(bundle: DbBundle, groupId: string): string[] {
  return (
    bundle.sqlite
      .prepare("SELECT id FROM transactions WHERE transfer_group_id = ? AND status != 'superseded' ORDER BY id")
      .all(groupId) as { id: string }[]
  ).map((r) => r.id);
}

/** "before" · "after" · or what is wrong with the pair */
function pairState(bundle: DbBundle, pair: Pair): "before" | "after" | string {
  const sapphire = leg(bundle, pair.sapphireId);
  const checking = leg(bundle, pair.checkingId);
  const shaped = (l: Leg | undefined, accountId: string, cents: number) =>
    l !== undefined && l.account_id === accountId && l.posted_on === pair.day && l.amount_cents === cents &&
    l.status === "active" && l.category_id === CREDIT_CARD_PAYMENT_ID && l.splits === 0;
  if (!shaped(sapphire, SAPPHIRE_ID, pair.cents) || sapphire!.transfer_group_id !== pair.checkingId) {
    return `${pair.day} Sapphire leg is not as measured: ${JSON.stringify(sapphire)}`;
  }
  if (!shaped(checking, CHASE_CHECKING_ID, -pair.cents)) return `${pair.day} checking leg is not as measured: ${JSON.stringify(checking)}`;
  const members = JSON.stringify(groupMembers(bundle, pair.checkingId));
  if (checking!.transfer_group_id === null && members === JSON.stringify([pair.sapphireId])) return "before";
  if (checking!.transfer_group_id === pair.checkingId && members === JSON.stringify([pair.checkingId, pair.sapphireId].sort())) return "after";
  return `${pair.day} group ${pair.checkingId} holds ${members}, checking leg group ${String(checking!.transfer_group_id)}`;
}

function planFor(bundle: DbBundle): Verdict {
  const reasons: string[] = [];
  for (const id of UNTOUCHED_IDS) {
    const row = leg(bundle, id);
    if (row?.status !== "active" || row.transfer_group_id !== null) reasons.push(`2026-03-02 checking row ${id} is not as measured: ${JSON.stringify(row)}`);
  }
  const states = PAIRS.map((p) => [p, pairState(bundle, p)] as const);
  for (const [, state] of states) if (state !== "before" && state !== "after") reasons.push(state);
  if (reasons.length > 0) return { kind: "refuse", reasons };
  const pending = states.filter(([, s]) => s === "before").map(([p]) => p);
  return pending.length === 0 ? { kind: "applied" } : { kind: "plan", pairs: pending };
}

function apply(bundle: DbBundle, pairs: readonly Pair[]): void {
  bundle.db.transaction((tx) => {
    for (const pair of pairs) {
      const changes = tx
        .update(transactions)
        .set({ transferGroupId: pair.checkingId })
        .where(and(eq(transactions.id, pair.checkingId), isNull(transactions.transferGroupId)))
        .run().changes;
      if (changes !== 1) throw new Error(`${pair.day}: expected to link 1 checking leg, linked ${changes}`);
    }
  });
}

interface State {
  balances: string;
  statusCounts: string;
  besideGroups: Map<string, string>;
  groups: Map<string, string>;
  oneLegGroups: number;
}

function captureState(bundle: DbBundle): State {
  const txns = bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[];
  const besideGroups = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const t of txns) {
    const { transfer_group_id: group, updated_at: _updatedAt, ...rest } = t;
    besideGroups.set(String(t.id), JSON.stringify(rest));
    groups.set(String(t.id), String(group ?? "-"));
  }
  const oneLeg = bundle.sqlite
    .prepare(
      `SELECT count(*) AS n FROM (SELECT transfer_group_id FROM transactions
       WHERE transfer_group_id IS NOT NULL AND status != 'superseded'
       GROUP BY transfer_group_id HAVING count(*) = 1)`,
    )
    .get() as { n: number };
  return { balances: balancesHash(bundle), statusCounts: statusCounts(bundle), besideGroups, groups, oneLegGroups: oneLeg.n };
}

function compareStates(before: State, after: State, pairs: readonly Pair[]): string[] {
  const failures: string[] = [];
  if (before.balances !== after.balances) failures.push("a daily_balances row moved");
  if (before.statusCounts !== after.statusCounts) failures.push(`status counts moved: ${before.statusCounts} → ${after.statusCounts}`);
  const beside = changedKeys(before.besideGroups, after.besideGroups);
  if (beside.length > 0) failures.push(`a column other than the group changed on ${beside.length} rows: ${beside.slice(0, 5).join(", ")}`);
  const moved = changedKeys(before.groups, after.groups);
  const expected = pairs.map((p) => p.checkingId).sort();
  if (JSON.stringify(moved) !== JSON.stringify(expected)) failures.push(`groups moved on ${JSON.stringify(moved)}, expected ${JSON.stringify(expected)}`);
  if (after.oneLegGroups !== before.oneLegGroups - pairs.length) {
    failures.push(`one-leg groups ${before.oneLegGroups} → ${after.oneLegGroups}, expected −${pairs.length}`);
  }
  return failures;
}

function rehearse(copy: DbBundle): string[] {
  const verdict = planFor(copy);
  if (verdict.kind !== "plan") return [`the copy planned ${verdict.kind}, not a write`];
  const before = captureState(copy);
  apply(copy, verdict.pairs);
  const failures = compareStates(before, captureState(copy), verdict.pairs);
  if (planFor(copy).kind !== "applied") failures.push("a second run on the copy is not ALREADY APPLIED");
  return failures;
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const verdict = planFor(real);
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    if (verdict.kind === "refuse") {
      for (const r of verdict.reasons) console.log(`  ✗ ${r}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log("ALREADY APPLIED — nothing to do");
    for (const p of verdict.pairs) console.log(`  ${p.day} ${formatCents(p.cents)}: Chase Checking ${p.checkingId} joins Sapphire ${p.sapphireId}`);

    const rehearsal = await onRehearsalCopy(real, args.scratch, "link-sapphire-one-leg-groups", rehearse);
    if (rehearsal.length > 0) {
      for (const f of rehearsal) console.log(`  ✗ rehearsal: ${f}`);
      process.exitCode = 1;
      return;
    }
    const before = captureState(real);
    console.log(`  ✓ rehearsed on a copy: every guard holds (one-leg groups ${before.oneLegGroups} → ${before.oneLegGroups - verdict.pairs.length}), and a second run is ALREADY APPLIED`);
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm once the owner has said yes.");

    withPreMutationSnapshot(real.db, "link-sapphire-one-leg-groups", () => apply(real, verdict.pairs));
    const failures = compareStates(before, captureState(real), verdict.pairs);
    if (failures.length > 0) {
      throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-link-sapphire-one-leg-groups.db restore point:\n${failures.join("\n")}`);
    }
    console.log(`APPLIED — every guard holds; ${planFor(real).kind === "applied" ? "a second run is ALREADY APPLIED" : "⚠ re-plan is not APPLIED"}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
