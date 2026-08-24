/**
 * Put the pass-63 "What this means" section where a fresh install would put it.
 *
 * WHY THIS IS A WRITE AND NOT A CODE CHANGE. `normalizeOrder` keeps a saved
 * layout's own sequence and appends canonical ids it has never seen to the END,
 * which is the right rule — a section the owner deliberately moved must not jump
 * because a later pass added a neighbour. The consequence here is that a
 * dashboard which saved a layout before pass 63 gains the runway and car cards
 * BELOW Recent transactions.
 *
 * That would be his call to overrule, except the saved layout is byte-identical
 * to the pre-pass-63 default — ["hero","activity","accounts","recent"] — so
 * nothing was ever arranged. Restoring the canonical order is giving him the
 * default he already had, not overriding a preference. The guard below refuses
 * to run if that stops being true.
 *
 * Reversible in one drag from the dashboard's own arrange control.
 *
 *   pnpm tsx scripts/place-decisions-section.ts          # dry run, prints only
 *   pnpm tsx scripts/place-decisions-section.ts --write  # writes
 */
import { createDatabase } from "@/db/client";
import { DASHBOARD_SECTION_IDS, readSettings, writeSetting } from "@/services/settings";
import { normalizeOrder } from "@/lib/reorder";

const WRITE = process.argv.includes("--write");
const DB_PATH = process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db";

/** The layout this script is willing to replace: the pre-pass-63 default. */
const UNARRANGED = ["hero", "activity", "accounts", "recent"];

const { sqlite, db } = createDatabase(DB_PATH);

try {
  const before = readSettings(db).dashboardLayout;
  console.log("db      :", DB_PATH);
  console.log("before  :", JSON.stringify(before));

  if (before.includes("decisions")) {
    console.log("\nnothing to do — the layout already places the section.");
    process.exit(0);
  }

  /*
   * Δ-GUARD. Anything other than the untouched default means he arranged his
   * dashboard, and an arranged dashboard is his. Refuse rather than guess.
   */
  if (JSON.stringify(before) !== JSON.stringify(UNARRANGED)) {
    console.error(
      `\nREFUSING: the saved layout is not the pre-pass-63 default.\n` +
        `  saved   ${JSON.stringify(before)}\n` +
        `  default ${JSON.stringify(UNARRANGED)}\n` +
        `This dashboard was arranged deliberately; moving a section is the owner's call.`,
    );
    process.exit(1);
  }

  const after = [...DASHBOARD_SECTION_IDS];
  console.log("after   :", JSON.stringify(after));

  // POST-CONDITION, checked before the write: the new order must contain
  // exactly the canonical ids, no more and no fewer, and must survive the same
  // reconciliation the page runs.
  const reconciled = normalizeOrder(after, DASHBOARD_SECTION_IDS);
  if (JSON.stringify(reconciled) !== JSON.stringify(after)) {
    throw new Error(`normalizeOrder would rewrite this order: ${JSON.stringify(reconciled)}`);
  }
  if (new Set(after).size !== DASHBOARD_SECTION_IDS.length) {
    throw new Error("the new order is not exactly the canonical id set");
  }

  if (!WRITE) {
    console.log("\ndry run — pass --write to apply.");
    process.exit(0);
  }

  writeSetting(db, "dashboardLayout", after);

  const verified = readSettings(db).dashboardLayout;
  if (JSON.stringify(verified) !== JSON.stringify(after)) {
    throw new Error(`post-write read-back disagrees: ${JSON.stringify(verified)}`);
  }
  console.log("\nwritten and verified:", JSON.stringify(verified));
} finally {
  sqlite.close();
}
