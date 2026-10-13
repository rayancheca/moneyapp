import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { E2E_FAKE_TODAY, seededRecurringValues } from "../../e2e/seed-helpers";
import { createDatabase, type DbBundle } from "../../src/db/client";
import { accounts } from "../../src/db/schema/accounts";
import { institutions } from "../../src/db/schema/institutions";
import { recurringSeries } from "../../src/db/schema/recurring";
import { transactions } from "../../src/db/schema/transactions";
import { seedDatabase } from "../../src/db/seed";
import { addDays, compareDates } from "../../src/lib/dates";
import { settledPaydaysForSeries } from "../../src/services/payday-settlement";
import { runSimulation } from "./simulate";

/**
 * The e2e fixture's Paycheck schedule agrees with its own deposits.
 *
 * 🔴 It was anchored Fri Jul 10, 2026 while the ACME payroll deposits linked to it (`seedMissingCards`) fall on
 * the Fridays a week EARLIER — 2024-07-05 every 14 days to 2026-05-08. Under one payday universe (§6A 55 step B) a
 * pay series' paydays are its anchor's rhythm walked back to its first deposit, so every month of the fixture read
 * "paid by the deposit of a week later": July 2024's calendar drew Jul 5's deposit paying none, Jul 19's paying
 * Jul 12 and Aug 2's paying Jul 26 — a story the fixture told by accident, which no ledger of his has. Measured on
 * a scratch e2e seed 2026-10-13: 49 deposits, every one a Friday on that rhythm.
 *
 * The deposits are read from the simulator that generated the corpus, and the series from the rows the seed inserts,
 * so neither half is a copy. The settlement is the app's own (`settledPaydaysForSeries`) — the answer the calendar,
 * /budgets and the cash-earnings note all draw.
 */
const ACME = "ACME CORP PAYROLL";
const CHECKING = "e2e-chase-checking";

let dir: string;
let bundle: DbBundle;
let paycheck: ReturnType<typeof seededRecurringValues>[number];
let depositDays: string[];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-e2e-paycheck-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const at = "2026-01-01T00:00:00.000Z";
  bundle.db
    .insert(accounts)
    .values({
      id: CHECKING,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Chase Total Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  paycheck = seededRecurringValues().find((r) => r.name === "Paycheck")!;
  const seriesId = "e2e-paycheck";
  bundle.db.insert(recurringSeries).values({ ...paycheck, id: seriesId }).run();

  const deposits = runSimulation()
    .txns.get("chase-checking")!
    .filter((t) => t.rawDescription.startsWith(ACME));
  depositDays = deposits.map((t) => t.postedOn).sort(compareDates);
  deposits.forEach((t, i) =>
    bundle.db
      .insert(transactions)
      .values({
        id: `acme-${i}`,
        accountId: CHECKING,
        postedOn: t.postedOn,
        amountCents: t.amountCents,
        rawDescription: t.rawDescription,
        normalizedDescription: t.rawDescription,
        recurringSeriesId: seriesId,
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `acme-${i}`,
        createdAt: at,
        updatedAt: at,
      })
      .run(),
  );
});

afterAll(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the e2e seed's Paycheck", () => {
  test("is anchored on its deposits' rhythm: the first Friday after FAKE_TODAY the ACME payroll falls on", () => {
    expect(depositDays).toHaveLength(49);
    let next = depositDays.at(-1)!;
    while (compareDates(next, E2E_FAKE_TODAY) <= 0) next = addDays(next, 14);
    expect(paycheck.nextExpectedOn).toBe(next);
  });

  test("every payday is settled by the deposit of its own day, and every deposit settles one", () => {
    const settledBy = settledPaydaysForSeries(bundle.db, "e2e-paycheck", E2E_FAKE_TODAY);
    const paidByAnotherDay = [...settledBy].filter(([payday, by]) => payday !== by);

    expect(paidByAnotherDay).toEqual([]);
    expect([...settledBy.keys()].sort(compareDates)).toEqual(depositDays);
  });
});
