import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * The duplicates queue (duplicate_candidates): a pair the owner can actually
 * resolve, and take back.
 *
 * Seeded directly rather than through the UI because there is no UI that CREATES
 * a cross-source duplicate — they arrive from two import files recording one
 * charge, which is not a gesture a test can perform. The rows and the candidate
 * are deleted again at the end, so the shared database is left as it was found.
 *
 * Named `zz-zz-zz-` so it sorts after every spec that photographs or totals the
 * ledger: it adds two transactions, and a spec that runs before a full-page
 * baseline shot moves that baseline (measured in a previous pass, where a new
 * account made an accounts screenshot 32px taller).
 */

const DB_PATH = "data/e2e.db";
const A = "e2e-dupe-txn-a";
const B = "e2e-dupe-txn-b";
const CANDIDATE = "e2e-dupe-candidate";
const FILE_A = "e2e-dupe-file-a";
const FILE_B = "e2e-dupe-file-b";
const POSTED = "2026-07-02";
const AMOUNT = -1250;
const RAW_A = "CPI*CANTEEN VENDING MIAMI";
const RAW_B = "CPI*CANTEEN VENDING MIAMI 800-628-";

const canonical = (fields: string[]): string => fields.map((f) => `${f.length}:${f}`).join("\x1f");
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test.beforeAll(() => {
  withDb((db) => {
    // An account with NO reconciled period covering the seeded day, on purpose:
    // resolveDuplicate refuses to retire a row whose statement period balances
    // to the cent, and the UI shows "Proved by a statement" instead of a button.
    // Seeding into a reconciled window would test the refusal, not the retire.
    const account = db
      .prepare(
        `SELECT a.id, a.institution_id FROM accounts a
          WHERE a.is_active = 1
            AND NOT EXISTS (
              SELECT 1 FROM statement_periods p
               WHERE p.account_id = a.id AND p.reconciliation = 'reconciled'
                 AND ? BETWEEN p.period_start AND p.period_end)
          ORDER BY a.display_order LIMIT 1`,
      )
      .get(POSTED) as { id: string; institution_id: string };
    const now = "2026-07-02T00:00:00.000Z";

    for (const [id, name] of [
      [FILE_A, "statement-2026-07.pdf"],
      [FILE_B, "spending-report-2026.pdf"],
    ]) {
      db.prepare(
        `INSERT INTO import_files (id, file_name, file_sha256, format, institution_id, status, storage_path, imported_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, name, `sha-${id}`, "pdf", account.institution_id, "parsed", `/tmp/${name}`, now, now, now);
    }

    const rows: { id: string; fileId: string; raw: string }[] = [
      { id: A, fileId: FILE_A, raw: RAW_A },
      { id: B, fileId: FILE_B, raw: RAW_B },
    ];
    for (const { id, fileId, raw } of rows) {
      db.prepare(
        `INSERT INTO transactions (id, account_id, import_file_id, posted_on, amount_cents, raw_description,
           normalized_description, status, needs_review, occurrence_index, dedupe_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, account.id, fileId, POSTED, AMOUNT, raw, raw, "active", 1, 0,
        sha(canonical([account.id, POSTED, String(AMOUNT), raw, "0"])), now, now,
      );
    }

    const side = (raw: string): string => canonical([POSTED, "", String(AMOUNT), raw]);
    const pairKey = sha(canonical([account.id, ...[side(RAW_A), side(RAW_B)].sort()]));
    const ordered = [A, B].sort();
    const idA = ordered[0]!;
    const idB = ordered[1]!;
    db.prepare(
      `INSERT INTO duplicate_candidates (id, account_id, transaction_id_a, transaction_id_b, pair_key,
         reason, reason_detail, resolution, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      CANDIDATE, account.id, idA, idB, pairKey, "cross_source_same_day",
      "Two sources each recorded $12.50 on 2026-07-02.", "unresolved", now, now,
    );
  });
});

test.afterAll(() => {
  withDb((db) => {
    db.prepare("DELETE FROM duplicate_candidates WHERE id = ?").run(CANDIDATE);
    db.prepare("DELETE FROM transactions WHERE id IN (?,?)").run(A, B);
    db.prepare("DELETE FROM import_files WHERE id IN (?,?)").run(FILE_A, FILE_B);
  });
});

test("a duplicate pair can be retired and taken back", async ({ page }) => {
  await page.goto("/transactions?view=duplicates");

  // both copies are shown, with the file each came from — the owner's main way
  // to judge which one to keep
  const card = page.getByText("Two sources each recorded $12.50 on 2026-07-02.").locator("..").locator("..");
  await expect(card).toBeVisible();
  await expect(card).toContainText("statement-2026-07.pdf");
  await expect(card).toContainText("spending-report-2026.pdf");

  // retire the Spending Report copy — named by its SOURCE, because both rows
  // carry the same visible button text
  await card.getByRole("button", { name: "Retire the copy from spending-report-2026.pdf" }).click();

  await expect(card).toContainText("One copy retired");
  await expect(card).toContainText("Retired");

  // the retired row is `superseded`, and no other tab renders one — so the pair
  // must stay visible here or the retire is indistinguishable from a delete
  await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();

  // …and it really is out of the ledger
  expect(
    withDb((db) => (db.prepare("SELECT status FROM transactions WHERE id = ?").get(B) as { status: string }).status),
  ).toBe("superseded");

  await card.getByRole("button", { name: "Undo" }).click();
  await expect(card).toContainText("Retire the copy you do not want counted");
  expect(
    withDb((db) => (db.prepare("SELECT status FROM transactions WHERE id = ?").get(B) as { status: string }).status),
  ).toBe("active");
});

test("keeping both is a first-class answer, and it is remembered", async ({ page }) => {
  await page.goto("/transactions?view=duplicates");

  const card = page.getByText("Two sources each recorded $12.50 on 2026-07-02.").locator("..").locator("..");
  await card.getByRole("button", { name: "Not a duplicate" }).click();

  await expect(card).toContainText("Kept both");
  expect(withDb((db) => (db.prepare("SELECT resolution FROM duplicate_candidates WHERE id = ?").get(CANDIDATE) as { resolution: string }).resolution)).toBe("dismissed");

  // put it back so the next run starts from the same place
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(card).toContainText("Retire the copy you do not want counted");
});
