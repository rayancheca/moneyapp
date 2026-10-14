/**
 * REAL-DB WRITE — the owner's answer to §74 of 2026-10-13: file the August 2026 card rows that sat with NO category,
 * each under the category his ledger already gives a like merchant.
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-13: 32 rows (−$1,194.41, Aug 3 – Aug 29) carried no category and no
 * review flag — queued for the app's Claude classifier since the Aug 18 run. /spending's August read "Uncategorized
 * $1,194.41"; Food, the Eating-out card and the August budgets missed every one; the dashboard's "To review" counted 2.
 * He chose: I file them (restaurants → Dining, Publix/Canteen → Groceries, PayByPhone → Parking & Tolls, Ocean Cinemas
 * → Entertainment like his other cinema row, the vape shop → Shopping › General like 25 of his Vape N Smoke rows), and
 * the four I cannot name stay unfiled for him: KnockBox AI −$2.20, SUPER+ −$15.00, Move Fitness 2 × −$1.00.
 *
 * ## The runbook — from the main checkout, with the dev server stopped
 *
 *   pnpm tsx scripts/file-august-unfiled-2026-10-13.ts --db=data/moneyapp.db             # dry run: plan + rehearsal
 *   pnpm tsx scripts/file-august-unfiled-2026-10-13.ts --db=data/moneyapp.db --confirm   # restore point, write, guards
 *   pnpm tsx scripts/file-august-unfiled-2026-10-13.ts --db=data/moneyapp.db             # ALREADY APPLIED
 *   pnpm ledger-check
 *
 * ⛔ Only the 28 rows' `category_id`, `categorization_source` (→ `user`: he chose the categories) and `updated_at` may
 * change. Every other transaction column, every other row (the four left unfiled included), every daily balance and
 * every series is compared before and after, on the rehearsal copy and on the ledger. A row in any state but unfiled
 * or already filed to its target is refused — never overwritten.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const LABEL = "file-august-unfiled";

const CATEGORY = {
  dining: { id: "019f4c7d-cc8a-76a3-87e2-e1ad8fbce064", path: "Food › Dining" },
  groceries: { id: "019f4c7d-cc8a-7d27-892c-41dda63c8f8c", path: "Food › Groceries" },
  parking: { id: "019f4c7d-cc8a-785c-87e7-7022ac2cc335", path: "Transport › Parking & Tolls" },
  entertainment: { id: "019f4c7d-cc8b-77d8-bbf8-21c315864bf4", path: "Entertainment" },
  general: { id: "019f4c7d-cc8a-70e5-8328-e3b8be5da1a7", path: "Shopping › General" },
} as const;
type CategoryKey = keyof typeof CATEGORY;

const WF = "Wells Fargo Everyday Checking";
const SAPPHIRE = "Chase Sapphire";

/** id, posted day, amount, account, the normalized description read on the copy, and where it goes */
const ROWS: readonly { id: string; postedOn: string; amountCents: number; account: string; nd: string; to: CategoryKey }[] = [
  { id: "01a03f46-db07-7001-b0a7-b8ca876e4998", postedOn: "2026-08-03", amountCents: -2100, account: WF, nd: "OCEAN CINEMAS INC MIAMI", to: "entertainment" },
  { id: "01a03f46-db08-7000-a334-7507990bb879", postedOn: "2026-08-03", amountCents: -300, account: WF, nd: "CPI*CANTEEN VENDIN 800-628-8363", to: "groceries" },
  { id: "01a03f46-db08-7001-8393-60d74c050b99", postedOn: "2026-08-03", amountCents: -1926, account: WF, nd: "WRAP PIT STOP MIAMI", to: "dining" },
  { id: "01a03f46-db08-7002-81ef-88161711a790", postedOn: "2026-08-03", amountCents: -3471, account: WF, nd: "DONUT GALLERY DINE KEY BISCAYNE", to: "dining" },
  { id: "01a06860-2d69-700b-b014-489462720190", postedOn: "2026-08-08", amountCents: -486, account: SAPPHIRE, nd: "MEN915 MENCHIES SHOPS MIAMI", to: "dining" },
  { id: "01a06860-2d69-7007-98ef-14244f0ccec3", postedOn: "2026-08-09", amountCents: -7500, account: SAPPHIRE, nd: "CHEESECAKE DOLPHIN MALL MIAMI", to: "dining" },
  { id: "01a03f46-db0b-7003-83ab-adf1335673ef", postedOn: "2026-08-10", amountCents: -2677, account: WF, nd: "TACO STAND MIA MIAMI BEACH", to: "dining" },
  { id: "01a03f46-db0c-7000-952d-2dc6d9a34111", postedOn: "2026-08-10", amountCents: -2264, account: WF, nd: "SUFRAT MEDITE MIAMI BEACH", to: "dining" },
  { id: "01a06860-2d6a-7001-b1e9-f93f0e7c545e", postedOn: "2026-08-10", amountCents: -2725, account: SAPPHIRE, nd: "WYNBALLS RESTAURANT AND MIAMI", to: "dining" },
  { id: "01a06860-2d6a-7003-b62a-8803243ff2eb", postedOn: "2026-08-10", amountCents: -2511, account: SAPPHIRE, nd: "SKINNY LOUIE - WYNWO MIAMI", to: "dining" },
  { id: "01a03f46-db0d-7002-8027-a015970e1182", postedOn: "2026-08-11", amountCents: -2889, account: WF, nd: "THE EMPANADAS KEY BISCAYNE", to: "dining" },
  { id: "01a06860-2d6a-7009-95ce-7290e9b25fe4", postedOn: "2026-08-11", amountCents: -6548, account: SAPPHIRE, nd: "BUCCAN - MIRACLE MIL CORAL GABLES", to: "dining" },
  { id: "01a06860-2d6a-7005-a77f-e0214335b3cd", postedOn: "2026-08-12", amountCents: -3890, account: SAPPHIRE, nd: "WORLD OF SMOKE & VAPE MIAMI", to: "general" },
  { id: "01a06860-2d6a-7006-ac53-ccef84b71cf6", postedOn: "2026-08-12", amountCents: -534, account: SAPPHIRE, nd: "PUBLIX CORAL GABLES", to: "groceries" },
  { id: "01a06860-2d6a-7007-afea-3c4f6ae6b96e", postedOn: "2026-08-12", amountCents: -428, account: SAPPHIRE, nd: "PUBLIX CORAL GABLES", to: "groceries" },
  { id: "01a06860-2d6a-7008-b3a1-6ecbc6fc7851", postedOn: "2026-08-12", amountCents: -1806, account: SAPPHIRE, nd: "PUBLIX CORAL GABLES", to: "groceries" },
  { id: "01a06860-2d6a-700a-b6aa-74db10b36442", postedOn: "2026-08-12", amountCents: -2932, account: SAPPHIRE, nd: "THE EMPANADAS - KB KEY BISCAYNE", to: "dining" },
  { id: "01a06860-2d6a-700e-88ea-186f83943c58", postedOn: "2026-08-15", amountCents: -9026, account: SAPPHIRE, nd: "ESPANOLITA MIAMI BEACH", to: "dining" },
  { id: "01a06860-2d6b-7003-b815-15e4e83a7833", postedOn: "2026-08-15", amountCents: -764, account: SAPPHIRE, nd: "EL COCO LOCO FRIO HIALEAH", to: "dining" },
  { id: "01a06860-2d6b-7004-b748-8bb8fef47c86", postedOn: "2026-08-15", amountCents: -853, account: SAPPHIRE, nd: "WINGS PIZZA MIAMI", to: "dining" },
  { id: "01a06860-2d6b-700b-b2ec-6c7fdf4ca0a3", postedOn: "2026-08-19", amountCents: -24006, account: SAPPHIRE, nd: "KYU MIAMI MIAMI", to: "dining" },
  { id: "01a06860-2d6b-7011-a6af-785fefe66c3e", postedOn: "2026-08-20", amountCents: -15933, account: SAPPHIRE, nd: "GYU-KAKU JAPANESE BBQ- 305-", to: "dining" },
  { id: "01a06860-2d6c-7003-8cd8-73527617445d", postedOn: "2026-08-22", amountCents: -1774, account: SAPPHIRE, nd: "CHICK-FIL-A DAVIE", to: "dining" },
  { id: "01a06860-2d6b-7013-93e7-78fc88dd7a76", postedOn: "2026-08-23", amountCents: -2424, account: SAPPHIRE, nd: "BUTTER MOON MERRICK P SUNNY ISLES B", to: "dining" },
  { id: "01a06860-2d6b-7014-9070-fd81dfc2f3ca", postedOn: "2026-08-23", amountCents: -1926, account: SAPPHIRE, nd: "EMPANADAS AVENTURA", to: "dining" },
  { id: "01a06860-2d6c-7001-87f6-8131e34d6bf6", postedOn: "2026-08-23", amountCents: -1037, account: SAPPHIRE, nd: "CARROT EXPRESS - AVE AVENTURA", to: "dining" },
  { id: "01a06860-2d6c-700b-92f5-b7e2e6726d3a", postedOn: "2026-08-29", amountCents: -615, account: SAPPHIRE, nd: "CORAL GABLES PAYBYPHONE 305-460-5540", to: "parking" },
  { id: "01a06860-2d6c-700c-b842-4fb2569b0936", postedOn: "2026-08-29", amountCents: -14176, account: SAPPHIRE, nd: "BAIRES GRILL MIAMI", to: "dining" },
];

/** The four he names himself — read to prove they are still there, unfiled, and untouched by this write. */
const LEFT_FOR_HIM = [
  "01a03f46-db09-7000-a47d-9af791333be8", // Move Fitness −$1.00, Aug 3
  "01a03f46-db0b-7002-a77f-0f321104a4d1", // Move Fitness −$1.00, Aug 7
  "01a06860-2d69-700a-a2ac-c38b4d687387", // SUPER+ −$15.00, Aug 7
  "01a0a0d4-836b-7001-b831-25b8fc069d99", // KnockBox AI −$2.20, Aug 17
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

/** Every transaction as it stands — the 28 rows without the three columns this write may change. */
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
  if (moved.length > 0) failures.push(`${moved.length} transaction(s) changed beyond the 28 rows' category: ${moved.slice(0, 5).join(", ")}`);
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
