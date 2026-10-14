import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { cashEarningsReadings } from "./cash-earnings";

/**
 * /spending's pay notes, composed as the page composes them — `cashEarningsReadings(…, withChecked)` into
 * `cashEarningsSectionNotes` — over a temp ledger.
 *
 * 🔴 Read on his ledger 2026-10-13: the only sentence about a window's unbanked paydays was gated on a STALE series, and
 * his pay was "Awaiting statements" — so August (Aug 6, 13, 20 paid by no deposit, Aug 27 by Sep 24's) read "INCOME
 * $54.12" with no note, while September's surplus note named the lump that paid Aug 27.
 *
 * ⛔ The fixture is his shape at one rate: a Thursday schedule ANCHORED (an unanchored series projects no payday for
 * the settlement to walk), a deposit that pays its own payday, and a later one whose money walks back over the month
 * line — Thu Sep 3's $2,000.00 pays Sep 3 and Aug 27. Today is Mon Sep 14, one payday (Sep 10) since: not stale.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-14";
const WF = "acct-wf";
const SERIES = "series-pay";

function salaryId(): string {
  const income = bundle.db.select().from(categories).where(and(eq(categories.name, "Income"), isNull(categories.parentId))).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id))).get()!.id;
}

function deposit(id: string, postedOn: string, amountCents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: WF,
      postedOn,
      amountCents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function coverThrough(to: string): void {
  for (let day = "2026-07-01"; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WF, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pay-shortfall-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WF,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: SERIES,
      name: "Cash job (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-09-17",
      accountId: WF,
      status: "confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  deposit("t-jul", "2026-07-30", 100_000);
  deposit("t-sep", "2026-09-03", 200_000);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const notesFor = (from: string, to: string, today = TODAY) =>
  cashEarningsSectionNotes({
    rows: cashEarningsReadings(bundle.db, { from, to, today, withChecked: true }),
    formatDay: formatDayLong,
  });

describe("/spending — a window whose read paydays were not banked inside it", () => {
  test("a shortfall a later deposit paid: that payday is named with its deposit, the rest never reached a bank", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-08-31")).toEqual([
      {
        id: "cash-earnings-shortfall-Cash job (weekly pay)",
        body:
          "Cash job (weekly pay)'s paydays over Aug 6 – 27, 2026 came to $4,000.00, and none of it was banked inside " +
          "the window: $1,000.00 (Aug 27) was paid by the deposit of Thu, Sep 3, 2026 and $3,000.00 never reached a " +
          "bank.",
      },
    ]);
  });

  test("a window ending on the day the lump landed: that day's payday is read and its deposit banked inside", () => {
    // 🔴 found in review 2026-10-13: the last day could fall out of the window with every test green — then this read
    // "Aug 6 – 27 … $1,000.00 (Aug 27) was paid by the deposit of Thu, Sep 3, 2026", a deposit inside its own window
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-09-03").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – Sep 3, 2026 came to $5,000.00, of which $2,000.00 was banked " +
        "inside the window and $3,000.00 never reached a bank.",
    ]);
  });

  test("a shortfall no deposit ever paid", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-08-01", "2026-08-21").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – 20, 2026 came to $3,000.00, and none of it reached a bank.",
    ]);
  });

  test("a window mixing read and unread paydays: the unread one is not looked for, never unbanked", () => {
    coverThrough("2026-09-05");
    expect(notesFor("2026-08-01", "2026-09-30").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays over Aug 6 – Sep 3, 2026 came to $5,000.00, of which $2,000.00 was banked " +
        "inside the window and $3,000.00 never reached a bank; 1 more payday in the window falls after Sat, Sep 5, " +
        "2026, the last day every account that pay lands in has been checked through — so the ledger has not looked " +
        "for its deposit.",
    ]);
  });

  test("a series that is not stale, its window banked in full: no note", () => {
    coverThrough("2026-09-12");
    expect(notesFor("2026-07-01", "2026-07-31")).toEqual([]);
  });

  test("a payday paid early, by a deposit before the window began (§6A 29)", () => {
    // Wed Sep 9 pays Thu Sep 10 — inside its tolerance — and the window opens on Sep 10
    deposit("t-early", "2026-09-09", 100_000);
    coverThrough("2026-09-12");
    expect(notesFor("2026-09-10", "2026-09-13").map((n) => n.body)).toEqual([
      "Cash job (weekly pay)'s paydays on Sep 10, 2026 came to $1,000.00, and none of it was banked inside the " +
        "window: $1,000.00 (Sep 10) was paid early, by the deposit of Wed, Sep 9, 2026.",
    ]);
  });

  test("a stale series keeps its own note — never both", () => {
    // Mon Oct 5: Sep 10, 17, 24 and Oct 1 have passed since Sep 3, all on checked days
    coverThrough("2026-10-03");
    expect(notesFor("2026-08-01", "2026-08-31", "2026-10-05").map((n) => n.id)).toEqual([
      "cash-earnings-unbanked-Cash job (weekly pay)",
    ]);
  });
});
