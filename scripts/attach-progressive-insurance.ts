import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createDatabase } from "@/db/client";
import { manualSnapshot } from "@/db/backup";
import { carCard } from "@/services/committed";
import { subscriptionsCard } from "@/services/subscriptions-card";

/**
 * Attaches the first car-insurance payment to the "Car insurance" series.
 *
 * The owner registered the series on 2026-08-31 starting at payment #2 (Sep 11),
 * because #1 had "already been paid 2026-08-11 on Venture X" — and it had: the
 * Venture X statement carries PROGRESSIVE INS $357.58 on 2026-08-12, filed by
 * hand under Car > Car Insurance. Nothing links the two, so on 2026-09-03 the
 * dashboard read "Car insurance — never billed" beside "Progressive Insurance
 * appears once in your ledger, for $357.58", and the car card counted that
 * premium as "Paid up front, spread over the lease".
 *
 * REHEARSAL by default: copies the real database to .trial/ and applies there.
 * `--apply` writes to the real database behind a restore point. Every guard is
 * a fact about ONE row and ONE series; the script refuses on any surprise.
 *
 *   pnpm tsx scripts/attach-progressive-insurance.ts            # rehearse
 *   pnpm tsx scripts/attach-progressive-insurance.ts --apply    # for real
 */

const APPLY = process.argv.includes("--apply");
const TODAY = "2026-09-03";

const ROW = {
  id: "01a01014-0d58-700a-893e-bb24d8f109a6",
  postedOn: "2026-08-12",
  amountCents: -35758,
  descriptionPrefix: "PROGRESSIVE INS",
  categoryName: "Car Insurance",
  accountName: "Venture X",
};
const SERIES = { id: "019ff202-9d0c-7000-96e8-d678b7d13783", name: "Car insurance", nextExpectedOn: "2026-09-11" };

const REAL = path.join(process.cwd(), "data", "moneyapp.db");
const SCRATCH = path.join(process.cwd(), ".trial", "attach-progressive.db");

function money(c: number): string {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  let target = REAL;
  if (!APPLY) {
    fs.mkdirSync(path.dirname(SCRATCH), { recursive: true });
    fs.rmSync(SCRATCH, { force: true });
    const src = new Database(REAL, { readonly: true });
    await src.backup(SCRATCH);
    src.close();
    target = SCRATCH;
  }
  const { db, sqlite } = createDatabase(target);

  // ── guards: one row, one series, nothing linked yet ────────────────────
  const row = sqlite
    .prepare(
      `SELECT t.id, t.posted_on, t.amount_cents, t.raw_description, t.recurring_series_id, t.status, c.name AS category, a.name AS account
       FROM transactions t JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id
       WHERE t.id = ?`,
    )
    .get(ROW.id) as
    | { id: string; posted_on: string; amount_cents: number; raw_description: string; recurring_series_id: string | null; status: string; category: string; account: string }
    | undefined;
  if (!row) throw new Error("guard: row not found");
  if (row.posted_on !== ROW.postedOn) throw new Error(`guard: posted_on ${row.posted_on}`);
  if (row.amount_cents !== ROW.amountCents) throw new Error(`guard: amount ${row.amount_cents}`);
  if (!row.raw_description.startsWith(ROW.descriptionPrefix)) throw new Error(`guard: description ${row.raw_description}`);
  if (row.category !== ROW.categoryName) throw new Error(`guard: category ${row.category}`);
  if (row.account !== ROW.accountName) throw new Error(`guard: account ${row.account}`);
  if (row.status !== "active") throw new Error(`guard: status ${row.status}`);
  if (row.recurring_series_id !== null) throw new Error(`guard: already linked to ${row.recurring_series_id}`);

  const series = sqlite
    .prepare(`SELECT id, name, status, next_expected_on, last_matched_on FROM recurring_series WHERE id = ?`)
    .get(SERIES.id) as { id: string; name: string; status: string; next_expected_on: string; last_matched_on: string | null } | undefined;
  if (!series) throw new Error("guard: series not found");
  if (series.name !== SERIES.name) throw new Error(`guard: series name ${series.name}`);
  if (series.status !== "confirmed") throw new Error(`guard: series status ${series.status}`);
  if (series.next_expected_on !== SERIES.nextExpectedOn) throw new Error(`guard: next_expected_on ${series.next_expected_on}`);
  const linkedAlready = sqlite.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE recurring_series_id = ?`).get(SERIES.id) as { n: number };
  if (linkedAlready.n !== 0) throw new Error(`guard: series already has ${linkedAlready.n} linked rows`);

  const before = {
    car: carCard(db, TODAY)!,
    subs: subscriptionsCard(db, TODAY)!,
  };

  if (APPLY) {
    const snap = manualSnapshot(sqlite);
    console.log(`Restore point: ${snap.path ?? "(none)"}`);
  }

  const now = new Date().toISOString();
  const changed = sqlite.transaction(() => {
    const a = sqlite
      .prepare(`UPDATE transactions SET recurring_series_id = ?, series_link_source = 'user', updated_at = ? WHERE id = ? AND recurring_series_id IS NULL`)
      .run(SERIES.id, now, ROW.id).changes;
    // last_matched_on is what "last seen" reads; next_expected_on stays Sep 11
    const b = sqlite
      .prepare(`UPDATE recurring_series SET last_matched_on = ?, updated_at = ? WHERE id = ? AND last_matched_on IS NULL`)
      .run(ROW.postedOn, now, SERIES.id).changes;
    if (a !== 1 || b !== 1) throw new Error(`guard: expected 1+1 changes, got ${a}+${b}`);
    return a + b;
  })();

  const after = {
    car: carCard(db, TODAY)!,
    subs: subscriptionsCard(db, TODAY)!,
  };

  const insuranceBefore = before.subs.live.find((r) => r.name === SERIES.name);
  const insuranceAfter = after.subs.live.find((r) => r.name === SERIES.name);
  const seen = (l: { lastMatchedOn: string | null; neverBilled: boolean } | undefined): string =>
    l === undefined ? "(not on the card)" : l.neverBilled ? "never billed" : `last seen ${l.lastMatchedOn}`;
  console.log(`${APPLY ? "APPLIED to the REAL database" : "REHEARSED on a copy"} — ${changed} rows changed\n`);
  console.log(`car card, paid up front   ${money(before.car.cost.upfrontCents)} -> ${money(after.car.cost.upfrontCents)}`);
  console.log(`car card, a month all in  ${money(before.car.cost.allInMonthlyCents)} -> ${money(after.car.cost.allInMonthlyCents)}`);
  console.log(`car card, lease+insurance ${money(before.car.cost.monthlyCents)} -> ${money(after.car.cost.monthlyCents)}`);
  console.log(`subscriptions, insurance  ${seen(insuranceBefore)} -> ${seen(insuranceAfter)}`);
  console.log(`subscriptions, never-billed ${money(before.subs.neverBilledMonthlyCents)} -> ${money(after.subs.neverBilledMonthlyCents)}`);
  console.log(`subscriptions, monthly     ${money(before.subs.liveMonthlyCents)} -> ${money(after.subs.liveMonthlyCents)}`);

  sqlite.close();
  if (!APPLY) console.log(`\nCopy left at ${SCRATCH}. The real database was opened READONLY and never written.`);
}

await main();
