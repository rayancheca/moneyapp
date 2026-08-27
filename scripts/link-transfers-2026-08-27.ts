/**
 * REAL-DB WRITE. Pairs 21 transfers the owner already made with the arrival
 * that proves where the money landed.
 *
 * Owner-approved, 2026-08-27, from a measured list: **"link the 20 unambiguous
 * ones plus the wells fargo trio FOR THE NEXT PASS."** The transfers card had
 * been saying, correctly, that 25 unpaired departures were "already sitting
 * opposite an exact-amount row in another account — $5,301.64 that one link
 * would account for". This is that link, for the part of it that is unambiguous.
 *
 * ## ⚠️ The arithmetic is 21, not 23
 *
 * "The 20 plus the Wells Fargo trio" adds ONE leg, not three: the $1.00 and
 * $199.00 Zelles each already have exactly one own-transfer mirror and are
 * therefore inside the 20. Only the $25.00 opening deposit sits outside it —
 * its Wells Fargo side is uncategorized, so it has no *own-transfer* mirror at
 * all. Measured against the live ledger:
 *
 *     A. exactly one own-transfer mirror     20 legs   $3,814.64
 *     B. no own-transfer mirror (WF opening)  1 leg       $25.00
 *                                            21 legs   $3,839.64   ← this write
 *     C. two identical rival mirrors          4 legs    $1,462.00   ← left alone
 *
 * ## ⛔ Why every counterpart is NAMED and not taken from transferCandidates[0]
 *
 * `transferCandidates` sorts by amount distance, then day distance, then
 * `id.localeCompare` — and that last tiebreak is arbitrary. Four of the 25 have
 * more than one exact mirror, and THREE of those rivals are income:
 *
 *   | departure            | the right leg          | the rival [0] could pick   |
 *   |----------------------|------------------------|----------------------------|
 *   | 2026-02-12 −$201.00  | Chase Zelle arrival    | 3× SoFi `Tutoring` deposits|
 *   | 2026-03-04 −$695.03  | Chase Zelle arrival    | SoFi Fordham PAYROLL       |
 *   | 2026-05-13 −$615.13  | Chase Zelle arrival    | SoFi Fordham PAYROLL       |
 *
 * All three are in bucket A — their single OWN-ACCOUNT mirror is the right
 * answer and the payroll deposit is the wrong one, and only the own-account
 * filter separates them. Linking one wrong would silently convert $615.13 of
 * SALARY into a transfer, against an income figure that has been stable for
 * seven passes. So the pairs below are written out by id, and `assertPlan()`
 * re-derives the own-mirror rule and refuses to run unless it reproduces this
 * table exactly. Named AND checked — neither alone is enough.
 *
 * ## What the evidence is
 *
 * Three pairs are provable from the documents: the Zelle REF appears on both
 * legs (`Jpm99Cqxlsrm` for the $1.00, `Jpm99Cqxln8W` for the $199.00), and the
 * opening deposit names **card 7782** on the Chase side and
 * `Xxxxxxxxxxxx7782` on the Wells Fargo side. SoFi truncates its descriptor at
 * "to Rayan", so the ref test is unavailable for the other 18; those rest on
 * amount + date + direction + the counterpart being an own-account transfer,
 * which is the evidence `linkTransferPair` was built for.
 *
 * ## What moves, and what must not
 *
 * `linkTransferPair` stamps a category as well as a link. Twenty of the 21
 * pairs are already `Transfers > Internal Transfer` on both legs, so the only
 * category this write creates is on the Wells Fargo opening deposit, which is
 * uncategorized today. That is the ONE row that can move a kind total, and the
 * guards below assert the transfer pool gains exactly its $25.00 and that
 * income and spending do not move at all.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/money";
import { listAccounts } from "@/services/accounts";
import { activeTxnsInRange } from "@/services/analytics";
import { linkTransferPair, transferCandidates, transferCategoryResolver } from "@/services/transfer-links";

const db = getDb();
const one = <T>(q: string): T => (db.all(sql.raw(q)) as T[])[0]!;
const num = (q: string): number => one<{ v: number }>(q).v;
const str = (q: string): string => one<{ v: string }>(q).v;

const netCents = () => num("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status='active'");
const rowCount = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active'");
const balances = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT account_id||day||balance_cents||basis x FROM daily_balances ORDER BY account_id, day)");
const groupMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(transfer_group_id,'-') g FROM transactions ORDER BY id")) as { id: string; g: string }[])
    .map((r) => [r.id, r.g]));
const catMap = (): Map<string, string> =>
  new Map((db.all(sql.raw("SELECT id, COALESCE(category_id,'-') c FROM transactions ORDER BY id")) as { id: string; c: string }[])
    .map((r) => [r.id, r.c]));
const seriesLinks = () =>
  str("SELECT COALESCE(group_concat(x),'') v FROM (SELECT id||':'||COALESCE(recurring_series_id,'-') x FROM transactions ORDER BY id)");
const kindTotal = (kind: string) =>
  num(`SELECT COALESCE(SUM(t.amount_cents),0) v FROM transactions t
       JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
       WHERE t.status='active' AND COALESCE(p.kind, c.kind)='${kind}'`);
const uncategorized = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND category_id IS NULL");
const reviewQueue = () => num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND needs_review=1");

/**
 * The 21 pairs, by id. `out` keys the group (detector convention: the outflow
 * leg's id IS the transfer_group_id). `arrived` is the counterpart's posted day
 * — it is a day EARLIER than `day` on the opening deposit, because Wells Fargo
 * credited it before Chase posted the payment, which is ordinary and is why
 * `linkTransferPair` does not care about leg order.
 */
const PAIRS: { out: string; in: string; cents: number; day: string; arrived: string; route: string }[] = [
  { out: "019f5ded-2540-7009-8696-40cb48d087d0", in: "019f4ca7-a6d0-7a4c-bb25-643a61ea0876", cents: 32400, day: "2026-02-05", arrived: "2026-02-05", route: "SoFi → Chase" },
  { out: "019f5ded-2540-7007-8ec1-962727a35474", in: "019f4ca7-a6cf-779e-a484-bf3c9151c2f9", cents: 20100, day: "2026-02-12", arrived: "2026-02-12", route: "SoFi → Chase" },
  { out: "019f5ded-2540-7003-a15c-164b1b6fb522", in: "019f4ca7-a6ce-7f73-9ff7-eb718199c48d", cents: 20000, day: "2026-02-19", arrived: "2026-02-19", route: "SoFi → Chase" },
  { out: "019f5ded-2540-7000-a655-c0e993d2cdee", in: "019f4ca7-a6cd-7ef0-b1f1-a2eaf7dad97d", cents: 20182, day: "2026-02-26", arrived: "2026-02-27", route: "SoFi → Chase" },
  { out: "019f5ded-254f-7009-b64b-bb1c70d0ddd3", in: "019f4ca7-a6cc-7c57-a5fa-d183653ef590", cents: 69503, day: "2026-03-04", arrived: "2026-03-04", route: "SoFi → Chase" },
  { out: "019f5ded-254f-7007-bdfc-3cc8fe307251", in: "019f4ca7-a6cc-7a4a-b6fe-13470866411d", cents: 25300, day: "2026-03-08", arrived: "2026-03-09", route: "SoFi → Chase" },
  { out: "019f4ca7-a6cb-7dda-9e6d-e2db507acf83", in: "019f5ded-254f-7006-a379-b9ff715cacfb", cents: 20000, day: "2026-03-09", arrived: "2026-03-09", route: "Chase → SoFi" },
  { out: "019f5ded-254f-7004-90fe-bdaad52192b2", in: "019f4ca7-a6cc-7d62-900b-5424016ccbb2", cents: 590, day: "2026-03-09", arrived: "2026-03-09", route: "SoFi → Chase" },
  { out: "019f5ded-254f-7000-b096-ea676cc3e594", in: "019f4ca7-a6ca-7b6f-b29f-5f233443ccba", cents: 5000, day: "2026-03-30", arrived: "2026-03-30", route: "SoFi → Chase" },
  { out: "019f5ded-255d-7006-8ee0-12b1d7004560", in: "019f4ca7-a6c8-7a4e-8139-d3656c42e5ac", cents: 1000, day: "2026-04-25", arrived: "2026-04-27", route: "SoFi → Chase" },
  { out: "019f5ded-255d-7000-a7eb-17e281bba5fc", in: "019f4ca7-a6c8-7237-abc6-add1604e3eda", cents: 12000, day: "2026-04-30", arrived: "2026-04-30", route: "SoFi → Chase" },
  { out: "019f5ded-255d-7002-980b-c240e007a3ad", in: "019f4ca7-a6c8-7090-a1ac-0cc2fffee55e", cents: 5000, day: "2026-04-30", arrived: "2026-04-30", route: "SoFi → Chase" },
  { out: "019f5ded-255d-7004-8b3e-c9dc0e8c6b6e", in: "019f4ca7-a6c8-77d0-87ab-400bfb9e2a63", cents: 11300, day: "2026-04-30", arrived: "2026-04-30", route: "SoFi → Chase" },
  { out: "019f5ded-256b-7009-bf59-8a0240f446a8", in: "019f4ca7-a6c7-79d2-b3fa-fdcd4da56536", cents: 16800, day: "2026-05-05", arrived: "2026-05-05", route: "SoFi → Chase" },
  { out: "019f5ded-256b-7007-8c87-5dc177e98b1c", in: "019f4ca7-a6c7-7536-90aa-17056c3819dc", cents: 20376, day: "2026-05-08", arrived: "2026-05-08", route: "SoFi → Chase" },
  { out: "019f5ded-256b-7005-8938-95bcdfb9c393", in: "019f4ca7-a6c6-7181-b8a3-6bf08f6bb42c", cents: 61513, day: "2026-05-13", arrived: "2026-05-13", route: "SoFi → Chase" },
  { out: "019f5ded-256b-7003-9ed1-659cb8c4adb1", in: "019f4ca7-a6c5-718c-ac90-858ab30fee64", cents: 15000, day: "2026-05-20", arrived: "2026-05-20", route: "SoFi → Chase" },
  { out: "019f5ded-256b-7001-a962-9beab9c238e6", in: "019f4ca7-a6c5-730e-9352-14f1f97e3368", cents: 5400, day: "2026-05-23", arrived: "2026-05-26", route: "SoFi → Chase" },
  { out: "01a000fe-e33a-700c-b3b3-f375781cc229", in: "01a03f46-db03-7000-bf3e-cda11cb8e762", cents: 2500, day: "2026-07-28", arrived: "2026-07-27", route: "Chase → Wells Fargo" },
  { out: "01a000fe-e33b-7003-8aa0-30a061d5b866", in: "01a03f46-db04-7001-880f-a0dbec1bfeec", cents: 100, day: "2026-07-29", arrived: "2026-07-29", route: "Chase → Wells Fargo" },
  { out: "01a000fe-e33b-7004-b9f4-d821eb93b049", in: "01a03f46-db05-7000-929d-c54da087923e", cents: 19900, day: "2026-07-29", arrived: "2026-07-29", route: "Chase → Wells Fargo" },
];

/**
 * ⛔ Re-derive the rule and refuse to run unless it reproduces PAIRS exactly.
 *
 * The ids above are the authority for WHICH rows get linked; this is the check
 * that they are still the rows the owner approved. A stale id, a re-import, a
 * leg linked by another session, or a new exact mirror appearing next to one of
 * these departures all surface here as a loud mismatch rather than as a write
 * against the wrong row.
 */
function assertPlan(): void {
  const own = new Set(listAccounts(db).map((a) => transferCategoryResolver(db)([a.id])));
  const catOf = catMap();
  const groupOf = groupMap();
  const derived = new Map<string, string>();
  const unpaired = activeTxnsInRange(db, "2026-02-01", "2026-07-31")
    .filter((t) => t.categoryId !== null && own.has(t.categoryId) && t.amountCents < 0 && groupOf.get(t.id) === "-")
    .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.id.localeCompare(b.id));
  let bucketC = 0;
  for (const leg of unpaired) {
    const mirrors = transferCandidates(db, leg.id).filter((c) => c.amountDeltaCents === 0);
    if (mirrors.length === 0) continue;
    const ownMirrors = mirrors.filter((m) => own.has(catOf.get(m.id) ?? "-"));
    if (ownMirrors.length === 1) derived.set(leg.id, ownMirrors[0]!.id);
    else if (ownMirrors.length === 0 && mirrors.length === 1) derived.set(leg.id, mirrors[0]!.id);
    else bucketC += 1;
  }
  const problems: string[] = [];
  if (derived.size !== PAIRS.length) problems.push(`rule derives ${derived.size} pairs, table has ${PAIRS.length}`);
  if (bucketC !== 4) problems.push(`expected 4 rival-mirror legs left alone, found ${bucketC}`);
  for (const p of PAIRS) {
    const got = derived.get(p.out);
    if (got === undefined) problems.push(`${p.day} ${formatCents(p.cents)}: the rule no longer reaches ${p.out}`);
    else if (got !== p.in) problems.push(`${p.day} ${formatCents(p.cents)}: rule says ${got}, table says ${p.in}`);
  }
  // no row may be claimed twice — linkTransferPair would throw on the second,
  // but a collision means the PLAN is wrong and must not start at all
  const seen = new Set<string>();
  for (const p of PAIRS) {
    for (const id of [p.out, p.in]) {
      if (seen.has(id)) problems.push(`row ${id} appears in two pairs`);
      seen.add(id);
    }
  }
  if (seen.size !== PAIRS.length * 2) problems.push(`${seen.size} distinct rows, expected ${PAIRS.length * 2}`);
  if (problems.length > 0) {
    throw new Error(`PLAN NO LONGER MATCHES THE LEDGER:\n  ${problems.join("\n  ")}`);
  }
  console.log(`plan verified: the own-mirror rule reproduces all ${PAIRS.length} pairs, and still leaves ${bucketC} rival-mirror legs alone\n`);
}

// ── restore point ────────────────────────────────────────────────────
const dbPath = process.env.MONEYAPP_DB_PATH ?? path.join(process.cwd(), "data", "moneyapp.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const restore = path.join(path.dirname(dbPath), "backups", `pre-${stamp}-link-transfers.db`);
fs.mkdirSync(path.dirname(restore), { recursive: true });
new Database(dbPath, { readonly: true }).backup(restore);
console.log(`restore point: ${path.relative(process.cwd(), restore)}\n`);

assertPlan();

/*
 * What the transfer pool is about to gain, computed from the rows themselves
 * rather than asserted as a constant: only legs arriving from a NON-transfer
 * kind move it, because a row already in a transfer category is already in it.
 */
const touched = PAIRS.flatMap((p) => [p.out, p.in]);
const priorKind = new Map(
  (db.all(sql.raw(`SELECT t.id, COALESCE(p.kind, c.kind, '-') k FROM transactions t
     LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
     WHERE t.id IN (${touched.map((id) => `'${id}'`).join(",")})`)) as { id: string; k: string }[])
    .map((r) => [r.id, r.k]),
);
const amountOf = new Map(
  (db.all(sql.raw(`SELECT id, amount_cents a FROM transactions WHERE id IN (${touched.map((id) => `'${id}'`).join(",")})`)) as { id: string; a: number }[])
    .map((r) => [r.id, r.a]),
);
const arriving = touched.filter((id) => priorKind.get(id) !== "transfer");
const transferDelta = arriving.reduce((s, id) => s + amountOf.get(id)!, 0);

const before = {
  net: netCents(),
  rows: rowCount(),
  balances: balances(),
  groups: groupMap(),
  cats: catMap(),
  series: seriesLinks(),
  expense: kindTotal("expense"),
  income: kindTotal("income"),
  transfer: kindTotal("transfer"),
  uncat: uncategorized(),
  review: reviewQueue(),
  linkedRows: num("SELECT COUNT(*) v FROM transactions WHERE status='active' AND transfer_group_id IS NOT NULL"),
};

for (const p of PAIRS) {
  console.log(`  ${p.day}  ${formatCents(p.cents).padStart(11)}  ${p.route.padEnd(20)} arrived ${p.arrived}`);
}
console.log(`\n  ${PAIRS.length} pairs, ${formatCents(PAIRS.reduce((s, p) => s + p.cents, 0))}`);
console.log(`  ${arriving.length} leg(s) arriving from a non-transfer kind: ${formatCents(transferDelta)}\n`);

// ── the write ────────────────────────────────────────────────────────
let affected = 0;
for (const p of PAIRS) {
  const result = linkTransferPair(db, p.out, p.in);
  // linkTransferPair also detaches stale counterparts; on a clean plan there
  // are none, and a surprise here must not pass silently
  if (result.affected !== 2) throw new Error(`${p.out}: linked ${result.affected} rows, expected exactly 2`);
  affected += result.affected;
}

// ── guards ───────────────────────────────────────────────────────────
const failures: string[] = [];
const guard = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name.padEnd(36)} ${detail}`);
  if (!ok) failures.push(name);
};

const afterGroups = groupMap();
const afterCats = catMap();
const changedGroups = [...before.groups.entries()].filter(([id, g]) => afterGroups.get(id) !== g).map(([id]) => id);
const changedCats = [...before.cats.entries()].filter(([id, c]) => afterCats.get(id) !== c).map(([id]) => id);
const expected = new Set(touched);

guard("rows linked", affected === PAIRS.length * 2, `${affected} of ${PAIRS.length * 2}`);
guard("ledger row sum", before.net === netCents(), formatCents(netCents()));
guard("active row count", before.rows === rowCount(), String(rowCount()));
guard("daily_balances", before.balances === balances(), "untouched");
guard("recurring links", before.series === seriesLinks(), "every series link unchanged");
guard(
  "exactly the planned rows re-linked",
  changedGroups.length === expected.size && changedGroups.every((id) => expected.has(id)),
  `${changedGroups.length} link changes, all expected`,
);
guard(
  "no pre-existing link disturbed",
  [...before.groups.entries()].every(([id, g]) => g === "-" || afterGroups.get(id) === g),
  `${before.linkedRows} rows were already linked and still are`,
);
guard(
  "every planned row went null → group",
  touched.every((id) => before.groups.get(id) === "-" && afterGroups.get(id) !== "-"),
  `${touched.length} rows gained a transfer_group_id`,
);
guard(
  "the outflow keys each group",
  PAIRS.every((p) => afterGroups.get(p.out) === p.out && afterGroups.get(p.in) === p.out),
  "detector convention held",
);
guard(
  "21 distinct groups",
  new Set(touched.map((id) => afterGroups.get(id))).size === PAIRS.length,
  `${new Set(touched.map((id) => afterGroups.get(id))).size} groups`,
);
guard(
  "each group holds 2 legs that cancel",
  PAIRS.every((p) => {
    const legs = db.all(sql.raw(`SELECT amount_cents a FROM transactions WHERE transfer_group_id='${p.out}' AND status='active'`)) as { a: number }[];
    return legs.length === 2 && legs.reduce((s, l) => s + l.a, 0) === 0;
  }),
  "one out, one in, summing to zero",
);
guard(
  "only the WF opening deposit recategorized",
  changedCats.length === 1 && changedCats[0] === "01a03f46-db03-7000-bf3e-cda11cb8e762",
  `${changedCats.length} category change`,
);
guard("INCOME unchanged", before.income === kindTotal("income"), formatCents(kindTotal("income")));
guard("SPENDING unchanged", before.expense === kindTotal("expense"), formatCents(-kindTotal("expense")));
guard(
  "transfers gain the arriving leg only",
  kindTotal("transfer") === before.transfer + transferDelta,
  `${formatCents(before.transfer)} → ${formatCents(kindTotal("transfer"))}  (+${formatCents(transferDelta)})`,
);
guard(
  "uncategorized falls by one",
  uncategorized() === before.uncat - 1,
  `${before.uncat} → ${uncategorized()}`,
);
guard(
  "review queue cleared by the pair that was in it",
  reviewQueue() === before.review - 2 && before.review === 2,
  `${before.review} → ${reviewQueue()}`,
);

if (failures.length > 0) {
  throw new Error(`GUARD FAILED: ${failures.join(", ")}. Restore:\n  cp "${restore}" "${dbPath}"`);
}
console.log("\nall guards held.");
