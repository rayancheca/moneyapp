import path from "node:path";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { manualSnapshot } from "@/db/backup";
import { createDatabase } from "@/db/client";
import { accounts, transactions } from "@/db/schema";
import { accountCoverage } from "@/services/coverage";
import { netWorthSeries, rebuildAccount } from "@/services/derivation";
import { reconcileAccounts } from "@/services/import/service";

/**
 * One-off correction for Discover rows whose `Post Date` precedes their
 * `Trans. Date`.
 *
 * A charge cannot post before it happens. Discover prints it that way for
 * dispute adjustments: the credit is BACK-DATED to the charge it reverses,
 * while the real posting date sits in `Trans. Date`. `discover-card-csv` v2 now
 * takes the later of the two, but a parser version bump does not reach rows
 * that are already imported — hence this script.
 *
 * Measured before writing (see docs/HANDOFF-2026-08-06-pass40.md): three
 * consecutive reconciliation spans were each wrong by exactly ±$40.00, and
 * moving both dispute credits to their true posting date lands all three on
 * their statement anchors to the cent:
 *
 *   A 2024-08-19..09-18   +$9.21 → −$30.79   (target −$30.79)
 *   B 2024-09-19..10-18  +$41.82 →  +$1.82   (target  +$1.82)
 *   C 2024-10-19..11-18 −$193.34 → −$113.34  (target −$113.34)
 *
 * This moves DATES only. No row is created, deleted, or re-signed, so net worth
 * cannot change — the script asserts that and tells you to restore if it does.
 *
 *   pnpm tsx scripts/fix-discover-backdated-adjustments.ts            # dry run
 *   pnpm tsx scripts/fix-discover-backdated-adjustments.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.join(process.cwd(), "data", "moneyapp.db"));

  const discover = db.select().from(accounts).where(eq(accounts.name, "Discover")).get();
  if (!discover) throw new Error("No Discover account");

  // the defect is definitionally "transacted after posted", so the predicate is
  // the invariant itself rather than a hand-listed set of row ids — ids change
  // across an unimport/reimport cycle, the invariant does not
  const affected = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, discover.id),
        isNotNull(transactions.transactedOn),
        gt(transactions.transactedOn, transactions.postedOn),
      ),
    )
    .all();

  console.log(`Discover rows posted BEFORE they transacted: ${affected.length}\n`);
  for (const t of affected) {
    console.log(
      `  ${t.postedOn} → ${t.transactedOn}  ${money(t.amountCents).padStart(10)}  ${t.rawDescription.slice(0, 46)}`,
    );
  }
  if (affected.length === 0) {
    console.log("\nNothing to do.");
    sqlite.close();
    return;
  }

  if (!CONFIRMED) {
    console.log("\nDry run — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  const snap = manualSnapshot(sqlite);
  console.log(`\nRestore point: ${snap.path ?? "(none)"}`);

  const beforeNet = netWorthSeries(db).at(-1)?.totalCents ?? 0;

  db.transaction((tx) => {
    for (const t of affected) {
      tx.update(transactions)
        .set({ postedOn: t.transactedOn as string, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(transactions.id, t.id))
        .run();
    }
  });

  // dates moved, so the anchor-to-anchor walk and every period that contains
  // one of these rows must be recomputed
  rebuildAccount(db, discover.id);
  reconcileAccounts(db, [discover.id]);

  const afterNet = netWorthSeries(db).at(-1)?.totalCents ?? 0;
  const grade = accountCoverage(db).find((c) => c.accountName === "Discover");

  console.log(`\nDiscover coverage: ${grade?.grade} · verified→ ${grade?.verifiedThrough ?? "—"}`);
  console.log(`NET WORTH  ${money(beforeNet)} → ${money(afterNet)}`);
  if (beforeNet !== afterNet) {
    console.log("  ⚠ net worth moved. Moving a date cannot do that — restore from the snapshot above.");
  } else {
    console.log("  unchanged, as a date-only correction must be.");
  }

  sqlite.close();
}

main();
