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
import { passedPaydaysWords } from "@/lib/unbanked-income";
import { cashEarningsReadings } from "./cash-earnings";
import { forecastCurrentMonth } from "./forecast";
import { incomeCard } from "./income-card";

/**
 * "Never reached a bank" is said of a payday only once the ledger has checked it through its DAYS TO LAND — its
 * series' own tolerance after it, the reach the settlement's anchor clause gives a deposit — on every surface that
 * says it: the forecast's note and the pay series' own page (`pastGraceOccurrenceCount`), the dashboard's Earned vs
 * banked and /spending's shortfall note.
 *
 * 🔴 Review of 878c3d5 (the grace rule reached 2 of its 4 readers): weekly $1,000.00 paid through Thu Aug 27, Chase
 * read through Sat Sep 5, today Sep 15 — the forecast called Thu Sep 3 "Pay not banked yet", while the dashboard said
 * "$1,000.00 of it never reached a bank" and /spending September "…came to $1,000.00, and none of it reached a bank"
 * of the same payday, whose deposit could still land on Sun Sep 6.
 *
 * ⛔ A payday a deposit SETTLED is not one of them, inside its days to land or not: on his ledger copy 2026-10-21 Wells
 * Fargo is checked through Thu Sep 24, whose payday the Sep 24 deposit paid, and Earned vs banked's "$11,117.00 of it
 * never reached a bank" (decision 55's figure) must not move.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-15";
const CHASE = "acct-chase";
const SERIES = "series-pay";
const now = (): string => new Date().toISOString();
const CHECKED_DAY = "the last day every account that pay lands in has been checked through";

function salaryId(): string {
  const named = (name: string, parentId: string | null) => {
    const parent = parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId);
    return bundle.db.select().from(categories).where(and(eq(categories.name, name), parent)).get()!;
  };
  return named("Salary", named("Income", null).id).id;
}

let seq = 0;
function deposit(postedOn: string, cents = 100_000): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: CHASE,
      postedOn,
      amountCents: cents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** A deposit on every Thursday from Jun 4 through `last` — each paying its own payday. */
function paidThrough(last: string): void {
  for (let day = "2026-06-04"; day <= last; day = addDays(day, 7)) deposit(day);
}

/** Days the balance walk has read — the second arbiter `accountCoverage` grades. */
function readThrough(to: string, from = "2026-06-01"): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: CHASE, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-days-to-land-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: CHASE,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Chase",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: SERIES,
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 100_000,
      lastMatchedOn: "2026-06-04",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What each surface says of the same paydays. */
function surfaces() {
  const f = forecastCurrentMonth(bundle.db, TODAY).unbankedIncome;
  const spending = (from: string, to: string): string[] =>
    cashEarningsSectionNotes({
      rows: cashEarningsReadings(bundle.db, { from, to, today: TODAY, withChecked: true }),
      formatDay: formatDayLong,
    }).map((n) => n.body);
  return {
    forecast: passedPaydaysWords(f, formatDayLong).notProjected,
    dashboard: incomeCard(bundle.db, TODAY)!.totals.gapLabel,
    september: spending("2026-09-01", "2026-09-30"),
    year: spending("2026-01-01", "2026-12-31"),
  };
}

describe("a payday checked on its day but not through its days to land never 'never reached a bank'", () => {
  test("the reviewer's state: Sep 3 checked through Sep 5 — every surface says not banked yet", () => {
    paidThrough("2026-08-27");
    readThrough("2026-09-05");
    const s = surfaces();

    expect(s.forecast).toBe("Pay not banked yet cannot be projected as arriving");
    expect(s.dashboard).toBe(
      `$1,000.00 of it is for paydays whose days to land run past Sep 5, ${CHECKED_DAY} — so it is not banked ` +
        "yet; the other $1,000.00 is for paydays after that day — so the ledger has not looked for it.",
    );
    expect(s.september).toEqual([
      "It America LLC (weekly pay)'s paydays on Sep 3, 2026 came to $1,000.00, and none of it is banked yet; " +
        `Sep 3's days to land run past Sat, Sep 5, 2026, ${CHECKED_DAY}; 1 more payday in the window falls after ` +
        "Sat, Sep 5, 2026 — so the ledger has not looked for its deposit.",
    ]);
    expect(s.year).toEqual([
      "It America LLC (weekly pay)'s paydays over Jun 4 – Sep 3, 2026 came to $14,000.00, of which $13,000.00 was " +
        "banked inside the window and $1,000.00 is not banked yet; Sep 3's days to land run past Sat, Sep 5, 2026, " +
        `${CHECKED_DAY}; 1 more payday in the window falls after Sat, Sep 5, 2026 — so the ledger has not looked ` +
        "for its deposit.",
    ]);
    for (const words of [s.dashboard, ...s.september, ...s.year]) expect(words).not.toMatch(/reached a bank/);
  });

  // ⛔ A date window has two ends: Sun Sep 6, three days on, is the last of Sep 3's days to land
  test("…and checked through Sep 6, its last day to land, every surface says it never reached a bank", () => {
    paidThrough("2026-08-27");
    readThrough("2026-09-06");
    const s = surfaces();

    expect(s.forecast).toBe("Pay that never reaches a bank cannot be projected as arriving");
    expect(s.dashboard).toBe(
      `$1,000.00 of it never reached a bank; the other $1,000.00 is for paydays after Sep 6, ${CHECKED_DAY} — so ` +
        "the ledger has not looked for it.",
    );
    expect(s.september).toEqual([
      "It America LLC (weekly pay)'s paydays on Sep 3, 2026 came to $1,000.00, and none of it reached a bank; 1 " +
        `more payday in the window falls after Sun, Sep 6, 2026, ${CHECKED_DAY} — so the ledger has not looked for ` +
        "its deposit.",
    ]);
  });

  // ⚖️ …by its OWN series' tolerance: a schedule given 5 days waits 5
  test("a schedule given 5 days to land is not banked yet through Sep 7, and never reached a bank from Sep 8", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, SERIES)).run();
    paidThrough("2026-08-27");
    readThrough("2026-09-07");
    expect(surfaces().dashboard).toMatch(/^\$1,000\.00 of it is for paydays whose days to land run past Sep 7/);
    readThrough("2026-09-08", "2026-09-08");
    expect(surfaces().dashboard).toMatch(/^\$1,000\.00 of it never reached a bank/);
  });

  test("past its days to land, inside them, and after the checked day: three paydays, three parts", () => {
    paidThrough("2026-08-20");
    readThrough("2026-09-05");
    expect(surfaces().dashboard).toBe(
      `$1,000.00 of it never reached a bank; $1,000.00 is for paydays whose days to land run past Sep 5, ` +
        `${CHECKED_DAY} — so it is not banked yet; the other $1,000.00 is for paydays after that day — so the ` +
        "ledger has not looked for it.",
    );
    expect(surfaces().year).toEqual([
      "It America LLC (weekly pay)'s paydays over Jun 4 – Sep 3, 2026 came to $14,000.00, of which $12,000.00 was " +
        "banked inside the window, $1,000.00 is not banked yet, and $1,000.00 never reached a bank; Sep 3's days " +
        `to land run past Sat, Sep 5, 2026, ${CHECKED_DAY}; 1 more payday in the window falls after Sat, Sep 5, ` +
        "2026 — so the ledger has not looked for its deposit.",
    ]);
  });

  /*
   * ⛔ His ledger's shape on 2026-10-21: the payday ON the checked day was paid by its own deposit. The days to land
   * are a question about money still to come — settled money has come, so its payday stays in the checked part, and
   * the unpaid payday before it still never reached a bank. ⛔ Never the checked day moved back by the days to land:
   * measured on his ledger copy 2026-10-21, that reading turned Earned vs banked's "$11,117.00 of it never reached a
   * bank" into $9,975.08, Sep 24's paid $1,141.92 among the pay "the ledger has not looked for"
   * (`paydaysNotBankedYet`).
   */
  test("a payday settled inside its days to land moves nothing — the unpaid one before it never reached a bank", () => {
    paidThrough("2026-08-20");
    deposit("2026-09-03");
    readThrough("2026-09-05");
    const s = surfaces();

    expect(s.dashboard).toBe(
      `$1,000.00 of it never reached a bank; the other $1,000.00 is for paydays after Sep 5, ${CHECKED_DAY} — so ` +
        "the ledger has not looked for it.",
    );
    expect(s.year.join(" ")).toContain("and $1,000.00 never reached a bank;");
    expect(s.year.join(" ")).not.toMatch(/not banked yet|days to land/);
  });
});
