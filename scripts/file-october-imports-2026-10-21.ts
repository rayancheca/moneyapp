/**
 * REAL-DB WRITE — file the 45 card rows his 2026-10-21 statements brought in with NO category, each under the category
 * his ledger already gives a like merchant: the rule he chose for August's rows (§74, 2026-10-13), asked again for these.
 *
 * 🔴 Measured on his ledger after the 2026-10-21 import (Discover through Oct 9, Chase Sapphire through Oct 2, Venture X
 * through Oct 14): 46 of the 163 new rows carried no category. The precedent is his own filings of the same merchants —
 * TST* TOPGOLF → Entertainment (Sep 1, Sep 7), ANTHROPIC* CLAUDE SUB → Subscriptions › Software (Aug 24, Sep 1), JORGE
 * PEREIRA JIU JITSU → Health › Fitness (Sep 11), a gas station → Transport › Gas (Exotic Hub, 7-Eleven), a liquor store →
 * Shopping › General (Churys, Goat, Manousos); restaurants → Dining and markets → Groceries as in §74. SUPER+ −$15.00
 * (Sep 7) stays unfiled for him to name, as in August.
 *
 * ## The runbook — the dev server stopped; the restore point goes to the main checkout's data/backups
 *
 *   MONEYAPP_BACKUPS_DIR=<main>/data/backups npx tsx scripts/file-october-imports-2026-10-21.ts --db=<main>/data/moneyapp.db
 *   … the same with --confirm   # restore point, write, guards
 *   … the same again            # ALREADY APPLIED
 *   pnpm ledger-check
 *
 * ⛔ Only the 45 rows' `category_id`, `categorization_source` (→ `user`: he chose the categories) and `updated_at` may
 * change. Every other transaction column, every other row (SUPER+ included), every daily balance and every series is
 * compared before and after, on the rehearsal copy and on the ledger. A row in any state but unfiled or already filed
 * to its target is refused — never overwritten.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const LABEL = "file-october-imports";

const CATEGORY = {
  dining: { id: "019f4c7d-cc8a-76a3-87e2-e1ad8fbce064", path: "Food › Dining" },
  groceries: { id: "019f4c7d-cc8a-7d27-892c-41dda63c8f8c", path: "Food › Groceries" },
  parking: { id: "019f4c7d-cc8a-785c-87e7-7022ac2cc335", path: "Transport › Parking & Tolls" },
  gas: { id: "019f4c7d-cc8a-75f0-bfd1-4581fe512bc3", path: "Transport › Gas" },
  entertainment: { id: "019f4c7d-cc8b-77d8-bbf8-21c315864bf4", path: "Entertainment" },
  general: { id: "019f4c7d-cc8a-70e5-8328-e3b8be5da1a7", path: "Shopping › General" },
  clothing: { id: "019f4c7d-cc8a-7ea0-ae5e-7efc430d021d", path: "Shopping › Clothing" },
  fitness: { id: "019f4c7d-cc8b-77e1-980e-075d57816c7b", path: "Health › Fitness" },
  pharmacy: { id: "019f4c7d-cc8b-768f-b1d9-6589b6a1a707", path: "Health › Pharmacy" },
  personalCare: { id: "019f4c7d-cc8b-79b6-b957-fc1be6f46e98", path: "Personal Care" },
  software: { id: "019f4c7d-cc8b-715d-a2bf-8b2b39e6569b", path: "Subscriptions › Software" },
} as const;
type CategoryKey = keyof typeof CATEGORY;

const SAPPHIRE = "Chase Sapphire";
const VENTURE = "Venture X";
const DISCOVER = "Discover";

/** id, posted day, amount, account, the normalized description read on the copy, and where it goes */
const ROWS: readonly { id: string; postedOn: string; amountCents: number; account: string; nd: string; to: CategoryKey }[] = [
  { id: "01a15fdb-4b33-7001-ace8-c47f32d7e933", postedOn: "2026-09-04", amountCents: -655, account: SAPPHIRE, nd: "PARAISO MARKET CAFE MIAMI", to: "dining" },
  { id: "01a15fdb-4b35-7000-b177-ecc2ea8c53f8", postedOn: "2026-09-12", amountCents: -764, account: SAPPHIRE, nd: "EL COCO LOCO FRIO HIALEAH", to: "dining" },
  { id: "01a15fdb-4b35-7003-96c8-0919c28283bd", postedOn: "2026-09-12", amountCents: -565, account: SAPPHIRE, nd: "COMRAS PARKING 877-", to: "parking" },
  { id: "01a15fdb-4b35-7001-b3b0-569b5af29472", postedOn: "2026-09-13", amountCents: -1749, account: SAPPHIRE, nd: "CRAVE COOKIES OF DORA BOCA RATON", to: "dining" },
  { id: "01a15fdb-4b35-7002-b2f3-a115a9763b2d", postedOn: "2026-09-13", amountCents: -938, account: SAPPHIRE, nd: "CRAVE COOKIES OF DORA BOCA RATON", to: "dining" },
  { id: "01a15fdb-4b35-7005-b48f-dd270d5f1c57", postedOn: "2026-09-14", amountCents: -7507, account: SAPPHIRE, nd: "TOPGOLF - DORAL DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5e-7007-bccc-f05801b28de8", postedOn: "2026-09-14", amountCents: -6360, account: VENTURE, nd: "VAGARO_*THE SPOT BARBE MIAMI BEACH", to: "personalCare" },
  { id: "01a15fdb-4b5e-700a-b212-41f2cbd161a9", postedOn: "2026-09-14", amountCents: -758, account: VENTURE, nd: "SEDANO S MIAMI", to: "groceries" },
  { id: "01a15fdb-4b5e-700b-8ecf-248559e3fa60", postedOn: "2026-09-15", amountCents: -7249, account: VENTURE, nd: "FIVE BELOW 6040 MIAMI", to: "general" },
  { id: "01a15fdb-4b5e-700d-a1f5-6070ad09f6e0", postedOn: "2026-09-15", amountCents: -5772, account: VENTURE, nd: "NIKEPOS_US MIAMI BEACH", to: "clothing" },
  { id: "01a15fdb-4b35-7010-9bb7-e023238073bd", postedOn: "2026-09-20", amountCents: -2065, account: SAPPHIRE, nd: "PANDA EXPRESS MIAMI", to: "dining" },
  { id: "01a15fdb-4b35-7012-ae86-05311092b82e", postedOn: "2026-09-20", amountCents: -1332, account: SAPPHIRE, nd: "SIP 305 MIAMI", to: "dining" },
  { id: "01a15fdb-4b36-7000-8a74-6a9b7d8bf2f3", postedOn: "2026-09-20", amountCents: -265, account: SAPPHIRE, nd: "PAYBYPHONE US CITY OF 604-", to: "parking" },
  { id: "01a15fdb-4b5f-7002-8a94-d5f74c3dae64", postedOn: "2026-09-21", amountCents: -7036, account: VENTURE, nd: "DICKS SPORTING GOODS MIAMI", to: "general" },
  { id: "01a15fdb-4b5f-7005-b43e-cfe7eb07ba6c", postedOn: "2026-09-21", amountCents: -400, account: VENTURE, nd: "TOPGOLF DORAL ARCADE L DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-7006-b357-6b82fc028dde", postedOn: "2026-09-21", amountCents: -150, account: VENTURE, nd: "TOPGOLF DORAL ARCADE L DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-7007-bd7a-96ef2e201cad", postedOn: "2026-09-21", amountCents: -150, account: VENTURE, nd: "TOPGOLF DORAL ARCADE L DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-7008-937a-00513124fd0f", postedOn: "2026-09-22", amountCents: -2716, account: VENTURE, nd: "TOPGOLF - DORAL DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-700c-aeca-ede2791eaa24", postedOn: "2026-09-24", amountCents: -20329, account: VENTURE, nd: "LS SIMONS SPORTSWEAR 130-", to: "clothing" },
  { id: "01a15fdb-4b36-700d-8ae5-7bde0f08d92f", postedOn: "2026-09-26", amountCents: -1753, account: SAPPHIRE, nd: "CHICK-FIL-A DORAL", to: "dining" },
  { id: "01a15fdb-4b36-700e-99e0-bcc3c81da74f", postedOn: "2026-09-27", amountCents: -1424, account: SAPPHIRE, nd: "RAISING CANES 0675 MIAMI BEACH", to: "dining" },
  { id: "01a15fdb-4b36-700f-9bc6-6bc77a74435e", postedOn: "2026-09-28", amountCents: -1524, account: SAPPHIRE, nd: "FORTUNE COOKIES MIAMI BEACH", to: "dining" },
  { id: "01a15fdb-4b5f-700f-ad37-971cd4519154", postedOn: "2026-09-28", amountCents: -12190, account: VENTURE, nd: "ROSS STORES MIAMI BEACH", to: "clothing" },
  { id: "01a15fdb-4b5f-7011-9062-2d00065168a7", postedOn: "2026-09-28", amountCents: -175, account: VENTURE, nd: "TOPGOLF DORAL ARCADE L DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-7012-a4df-a7209227b6af", postedOn: "2026-09-28", amountCents: -175, account: VENTURE, nd: "TOPGOLF DORAL ARCADE L DORAL", to: "entertainment" },
  { id: "01a15fdb-4b5f-7013-b3e2-496291d09edd", postedOn: "2026-09-28", amountCents: -2865, account: VENTURE, nd: "ORION FUELS 114 MIAMI", to: "gas" },
  { id: "01a15fdb-4b5f-7014-a776-69bf8aa67685", postedOn: "2026-09-28", amountCents: -5450, account: VENTURE, nd: "ORION FUELS 114 MIAMI", to: "gas" },
  { id: "01a15fdb-4b60-7001-aae9-620e7356d6ae", postedOn: "2026-09-28", amountCents: -3583, account: VENTURE, nd: "TOPGOLF - DORAL DORAL", to: "entertainment" },
  { id: "01a15fdb-4b60-7003-9804-23c1b4013c96", postedOn: "2026-09-29", amountCents: -4013, account: VENTURE, nd: "VELOCITY CLIMBING", to: "fitness" },
  { id: "01a15fdb-4b60-7004-bade-8b0f9750e8c2", postedOn: "2026-09-29", amountCents: -6580, account: VENTURE, nd: "VELOCITY CLIMBING", to: "fitness" },
  { id: "01a15fdb-4b60-7005-92d5-5ef5232ee7a8", postedOn: "2026-09-29", amountCents: -3210, account: VENTURE, nd: "VELOCITY CLIMBING", to: "fitness" },
  { id: "01a15fdb-4b60-7007-9727-93ea8e69e156", postedOn: "2026-09-30", amountCents: -16585, account: VENTURE, nd: "NIKEPOS_US MIAMI BEACH", to: "clothing" },
  { id: "01a15fdb-4b7d-7004-80ed-d9225829bcd4", postedOn: "2026-10-01", amountCents: -20000, account: DISCOVER, nd: "ANTHROPIC* CLAUDE SUB", to: "software" },
  { id: "01a15fdb-4b60-7008-8506-b06818c93c91", postedOn: "2026-10-02", amountCents: -1867, account: VENTURE, nd: "ROSS STORE MIAMI", to: "clothing" },
  { id: "01a15fdb-4b60-700a-a6f6-50641550e822", postedOn: "2026-10-02", amountCents: -3818, account: VENTURE, nd: "TOPGOLF - DORAL DORAL", to: "entertainment" },
  { id: "01a15fdb-4b60-700b-b94c-5305da7a9c7c", postedOn: "2026-10-02", amountCents: -8498, account: VENTURE, nd: "GNC MIAMI", to: "pharmacy" },
  { id: "01a15fdb-4b60-700e-8839-08f82aca2629", postedOn: "2026-10-03", amountCents: -21367, account: VENTURE, nd: "ZARA USA MIAMI", to: "clothing" },
  { id: "01a15fdb-4b60-7011-8914-dadb9d1a9dc2", postedOn: "2026-10-05", amountCents: -3052, account: VENTURE, nd: "SAND BAR AND KITCHEN MIAMI BEACH", to: "dining" },
  { id: "01a15fdb-4b60-7012-8b81-f71cddec2bf4", postedOn: "2026-10-05", amountCents: -1905, account: VENTURE, nd: "SPO*FINNEGAN'SWAY MIAMI BEACH", to: "dining" },
  { id: "01a15fdb-4b61-7011-9f9c-b35997178a44", postedOn: "2026-10-12", amountCents: -25000, account: VENTURE, nd: "JORGE PEREIRA JIU JITSU 786-", to: "fitness" },
  { id: "01a15fdb-4b61-7012-802f-14f520a356ce", postedOn: "2026-10-12", amountCents: -2749, account: VENTURE, nd: "CLARK LIQUOR 5 DORAL", to: "general" },
  { id: "01a15fdb-4b61-7013-be1d-b1a0c61c6205", postedOn: "2026-10-12", amountCents: -6250, account: VENTURE, nd: "SUSHIATO - DORAL DORAL", to: "dining" },
  { id: "01a15fdb-4b61-7015-8dd8-cb280c2e42c7", postedOn: "2026-10-12", amountCents: -1089, account: VENTURE, nd: "MB MARKET MIAMI BEACH", to: "groceries" },
  { id: "01a15fdb-4b62-7002-9156-72f2402ce8dd", postedOn: "2026-10-14", amountCents: -313, account: VENTURE, nd: "WYNWOOD PADEL CLUB LLC MIAMI", to: "fitness" },
  { id: "01a15fdb-4b62-7003-a743-f7734e676227", postedOn: "2026-10-14", amountCents: -3748, account: VENTURE, nd: "WYNWOOD PADEL CLUB MIAMI MIAMI", to: "fitness" },
];

/** The one he names himself — read to prove it is still there, unfiled, and untouched by this write. */
const LEFT_FOR_HIM = [
  "01a15fdb-4b34-7000-a741-01405e92207d", // SUPER+ *1-833-773-8471 844-461-2577 -15.00, 2026-09-07
] as const;

interface RowFact {
  id: string;
  status: string;
  postedOn: string;
  amountCents: number;
  accountName: string;
  nd: string;
  categoryId: string | null;
  source: string | null;
}

type Verdict =
  | { kind: "plan"; writes: { id: string; categoryId: string }[] }
  | { kind: "applied" }
  | { kind: "refuse"; reasons: string[] };

function loadFacts(bundle: DbBundle, ids: readonly string[]): Map<string, RowFact> {
  const stmt = bundle.sqlite.prepare(`
    SELECT t.id, t.status, t.posted_on AS postedOn, t.amount_cents AS amountCents, a.name AS accountName,
           t.normalized_description AS nd, t.category_id AS categoryId, t.categorization_source AS source
      FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`);
  const facts = new Map<string, RowFact>();
  for (const id of ids) {
    const fact = stmt.get(id) as RowFact | undefined;
    if (fact !== undefined) facts.set(id, fact);
  }
  return facts;
}

function categoriesExist(bundle: DbBundle): string[] {
  const stmt = bundle.sqlite.prepare(
    "SELECT coalesce(p.name || ' › ', '') || c.name AS path FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?",
  );
  const reasons: string[] = [];
  for (const c of Object.values(CATEGORY)) {
    const row = stmt.get(c.id) as { path: string } | undefined;
    if (row?.path !== c.path) reasons.push(`category ${c.id} is ${row?.path ?? "missing"}, not ${c.path}`);
  }
  return reasons;
}

function classify(bundle: DbBundle): Verdict {
  const reasons = categoriesExist(bundle);
  const facts = loadFacts(bundle, ROWS.map((r) => r.id));
  const writes: { id: string; categoryId: string }[] = [];
  let filed = 0;
  for (const want of ROWS) {
    const f = facts.get(want.id);
    const target = CATEGORY[want.to];
    if (f === undefined) {
      reasons.push(`${want.id}: not in this ledger`);
      continue;
    }
    const before = reasons.length;
    if (f.status !== "active") reasons.push(`${want.id}: status ${f.status}, not active`);
    if (f.postedOn !== want.postedOn || f.amountCents !== want.amountCents) {
      reasons.push(`${want.id}: ${f.postedOn} ${formatCents(f.amountCents)}, not ${want.postedOn} ${formatCents(want.amountCents)}`);
    }
    if (f.accountName !== want.account) reasons.push(`${want.id}: on ${f.accountName}, not ${want.account}`);
    if (f.nd !== want.nd) reasons.push(`${want.id}: reads "${f.nd}", not "${want.nd}"`);
    if (reasons.length > before) continue;
    if (f.categoryId === target.id && f.source === "user") filed += 1;
    else if (f.categoryId === null) writes.push({ id: f.id, categoryId: target.id });
    else reasons.push(`${want.id}: filed under another category (${f.categoryId}, ${f.source}) — never overwritten`);
  }
  for (const [id, f] of loadFacts(bundle, LEFT_FOR_HIM)) {
    if (f.categoryId !== null) reasons.push(`${id} (${f.nd}) is filed now — it was left for him; re-measure before writing`);
  }
  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (filed === ROWS.length) return { kind: "applied" };
  return { kind: "plan", writes };
}

function apply(bundle: DbBundle, writes: readonly { id: string; categoryId: string }[]): void {
  const now = new Date().toISOString();
  const stmt = bundle.sqlite.prepare(
    "UPDATE transactions SET category_id = ?, categorization_source = 'user', updated_at = ? WHERE id = ? AND category_id IS NULL AND status = 'active'",
  );
  bundle.sqlite.transaction(() => {
    for (const w of writes) {
      if (stmt.run(w.categoryId, now, w.id).changes !== 1) throw new Error(`${w.id}: not written`);
    }
  })();
}

/** Every transaction as it stands — the 45 rows without the three columns this write may change. */
function snapshot(bundle: DbBundle): { rows: Map<string, string>; balances: string; series: string; statuses: string } {
  const rows = new Map<string, string>();
  const targets = new Set<string>(ROWS.map((r) => r.id));
  for (const row of bundle.sqlite.prepare("SELECT * FROM transactions").all() as Record<string, unknown>[]) {
    const id = row.id as string;
    if (targets.has(id)) {
      const { category_id: _c, categorization_source: _s, updated_at: _u, ...rest } = row;
      rows.set(id, JSON.stringify(rest));
    } else rows.set(id, JSON.stringify(row));
  }
  return {
    rows,
    balances: balancesHash(bundle),
    series: sha256Json(bundle.sqlite.prepare("SELECT * FROM recurring_series ORDER BY id").all()),
    statuses: statusCounts(bundle),
  };
}

function compare(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>): string[] {
  const failures: string[] = [];
  const moved = changedKeys(before.rows, after.rows);
  if (moved.length > 0) failures.push(`${moved.length} transaction(s) changed beyond the 45 rows' category: ${moved.slice(0, 5).join(", ")}`);
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.series !== after.series) failures.push("a recurring series moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");
  return failures;
}

function print(bundle: DbBundle): void {
  const facts = loadFacts(bundle, ROWS.map((r) => r.id));
  const totals = new Map<CategoryKey, number>();
  for (const want of ROWS) {
    const f = facts.get(want.id);
    if (f === undefined) continue;
    const now = f.categoryId === null ? "Uncategorized" : f.categoryId === CATEGORY[want.to].id ? "filed" : f.categoryId;
    totals.set(want.to, (totals.get(want.to) ?? 0) + f.amountCents);
    console.log(`  ${f.postedOn}  ${formatCents(f.amountCents).padStart(9)}  ${f.nd.padEnd(37)} → ${CATEGORY[want.to].path} · now ${now}`);
  }
  for (const [k, cents] of totals) console.log(`  = ${CATEGORY[k].path}: ${formatCents(cents)}`);
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const verdict = classify(real);
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    print(real);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log(`ALREADY APPLIED — nothing to do: all ${ROWS.length} are filed`);

    const rehearsal = await onRehearsalCopy(real, args.scratch, LABEL, (copy) => {
      const before = snapshot(copy);
      apply(copy, verdict.writes);
      const failures = compare(before, snapshot(copy));
      if (classify(copy).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
      return failures;
    });
    if (rehearsal.length > 0) {
      for (const failure of rehearsal) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ rehearsed on a copy: files ${verdict.writes.length}, nothing else moves, and a second run is ALREADY APPLIED`);
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = snapshot(real);
    withPreMutationSnapshot(real.db, LABEL, () => apply(real, verdict.writes));
    const failures = compare(before, snapshot(real));
    if (failures.length > 0) throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${LABEL}.db restore point:\n${failures.join("\n")}`);
    const again = classify(real);
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
