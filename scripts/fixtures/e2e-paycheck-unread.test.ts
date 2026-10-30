import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { E2E_FAKE_TODAY, seededRecurringValues } from "../../e2e/seed-helpers";
import { createDatabase, type DbBundle } from "../../src/db/client";
import { accounts } from "../../src/db/schema/accounts";
import { dailyBalances } from "../../src/db/schema/balances";
import { categories } from "../../src/db/schema/categories";
import { institutions } from "../../src/db/schema/institutions";
import { recurringSeries } from "../../src/db/schema/recurring";
import { transactions } from "../../src/db/schema/transactions";
import { seedDatabase } from "../../src/db/seed";
import { addDays, compareDates, periodBounds } from "../../src/lib/dates";
import { formatDayLong } from "../../src/lib/format-date";
import { cashEarningsSectionNotes } from "../../src/lib/section-notes";
import { unbankedIncomeFrontierClause } from "../../src/lib/unbanked-income";
import { incomeExpectation } from "../../src/services/budgets";
import { cashEarningsReadings, checkedThroughBySeries } from "../../src/services/cash-earnings";
import { dashboardData } from "../../src/services/dashboard";
import { forecastCurrentMonth } from "../../src/services/forecast";
import { incomeCard } from "../../src/services/income-card";
import { recurringCalendar } from "../../src/services/recurring-calendar";
import { seriesDetail } from "../../src/services/recurring-detail";
import { runSimulation } from "./simulate";

// the calendar's month paging is a server action, which pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ loadRecurringMonthAction: vi.fn() }));
const { DaySheetBody, RecurringCalendar } = await import("../../src/components/recurring/RecurringCalendar");
const { UnbankedIncomeNote } = await import("../../src/components/recurring/ForecastCard");
const { PassedPaydaysCard } = await import("../../src/components/recurring/PassedPaydaysCard");

/**
 * What every surface the e2e fixture reaches for an UNREAD payday says of it, as text.
 *
 * Since 8ef2fc5 the fixture's Paycheck pays on its own deposits' Fridays (anchored Jul 17), so Fri Jul 3 has passed at
 * E2E_FAKE_TODAY (Jul 8) after the day Chase Total Checking is checked through (Jun 30): a payday nobody has looked
 * for. 🔴 Only /spending's July note and the calendar's "?" glyph were asserted as text (e2e); the forecast's note, his
 * pay page's card, /budgets' header note, the calendar's cell name and Day Sheet, the income card's gap and the
 * year's cash-earnings note said it in no test at all — and two of them in no screenshot (review of 8ef2fc5).
 *
 * ⛔ The fixture is rebuilt from the seed's own Paycheck row (`seededRecurringValues`) and the simulator's own ACME
 * deposits, filed under Salary, as e2e-paycheck-anchor.test.ts builds it, with Chase Total Checking checked through
 * Jun 30. Every string below was measured from the same services on a scratch e2e seed (`seedE2eDatabase`) on
 * 2026-10-14, and again on the integration on 2026-10-21.
 */
const ACME = "ACME CORP PAYROLL";
const CHECKING = "e2e-chase-checking";
const SERIES = "e2e-paycheck";
const TODAY = E2E_FAKE_TODAY;
const CHECKED_THROUGH = "2026-06-30";
const UNREAD =
  "It falls after Tue, Jun 30, 2026, the last day every account that pay lands in has been checked through — so the " +
  "ledger has not looked for its deposit.";

let dir: string;
let bundle: DbBundle;

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-e2e-paycheck-unread-"));
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
  const paycheck = seededRecurringValues().find((r) => r.name === "Paycheck")!;
  bundle.db.insert(recurringSeries).values({ ...paycheck, id: SERIES }).run();
  /*
   * ⚖️ Filed as the seed files them — Income > Salary, by its merchant rule (`seed-merchants`: "Acme Corp (payroll)") —
   * as e2e-paycheck-anchor.test.ts files them (82f6a3a): a day is a pay day only where one of its rows is filed as his
   * pay (`payDayRows`, 1bbd393, decision 75). 🔴 Inserted unfiled, on the integration they were the review queue's:
   * settlement paid no payday and drew none, so every surface below read no Jul 3 at all — the forecast's frontier
   * "unchecked", 0 paydays, $0.00. Measured on a scratch e2e seed (`seedE2eDatabase`) 2026-10-21 on the integration:
   * all 49 Paycheck rows are Salary, and every string below reads as asserted — the fixture was wrong, not the app.
   */
  const income = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!;
  const salary = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id)))
    .get()!;
  runSimulation()
    .txns.get("chase-checking")!
    .filter((t) => t.rawDescription.startsWith(ACME))
    .forEach((t, i) =>
      bundle.db
        .insert(transactions)
        .values({
          id: `acme-${i}`,
          accountId: CHECKING,
          postedOn: t.postedOn,
          amountCents: t.amountCents,
          rawDescription: t.rawDescription,
          normalizedDescription: t.rawDescription,
          categoryId: salary.id,
          recurringSeriesId: SERIES,
          status: "active",
          needsReview: false,
          occurrenceIndex: 0,
          dedupeHash: `acme-${i}`,
          createdAt: at,
          updatedAt: at,
        })
        .run(),
    );
  // the days the balance walk has read — what `accountCoverage` grades checked: through Jun 30, as the seed's are
  for (let day = "2024-07-01"; compareDates(day, CHECKED_THROUGH) <= 0; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: CHECKING, day, balanceCents: 100_000, basis: "derived" }).run();
  }
});

afterAll(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the e2e fixture's Jul 3 payday, after Chase Total Checking's Jun 30 — every surface, as text", () => {
  test("the fixture expresses it: checked through Jun 30, and Jul 3 passed with no deposit", () => {
    expect(checkedThroughBySeries(bundle.db, TODAY)(SERIES)).toBe(CHECKED_THROUGH);
    expect(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome).toMatchObject({
      totalCents: 294_319,
      occurrenceCount: 1,
      checkedOccurrenceCount: 0,
      frontier: { kind: "day", through: CHECKED_THROUGH },
    });
  });

  test("/recurring's forecast note", () => {
    const html = renderToStaticMarkup(
      createElement(UnbankedIncomeNote, { unbanked: forecastCurrentMonth(bundle.db, TODAY).unbankedIncome }),
    );
    expect(text(html)).toBe(
      "1 payday worth $2,943.19 already passed this month (Paycheck) — not counted above, and not in EOM cash. " +
        `${UNREAD} Pay the ledger has not looked for cannot be projected as arriving; the month strip below counts ` +
        "it, because that line is the schedule.",
    );
    expect(html).not.toContain("text-warning");
  });

  test("the Paycheck page's passed-paydays card", () => {
    const passed = seriesDetail(bundle.db, SERIES, TODAY).unbankedPaydays!;
    expect(text(renderToStaticMarkup(createElement(PassedPaydaysCard, { passed })))).toBe(
      `1 payday worth $2,943.19 already passed this month ${UNREAD} Jul 3, 2026 +$2,943.19`,
    );
  });

  test("/budgets' header note — its frontier clause", () => {
    const month = periodBounds(TODAY, "monthly");
    const income = incomeExpectation(bundle.db, month.start, month.end, TODAY);
    expect([income.passedUnpaidOccurrences, income.passedUnpaidCents]).toEqual([1, 294_319]);
    const clause = unbankedIncomeFrontierClause(
      {
        occurrenceCount: income.passedUnpaidOccurrences,
        checkedOccurrenceCount: income.passedUnpaidCheckedOccurrences,
        frontier: income.passedUnpaidFrontier,
      },
      formatDayLong,
    );
    expect(clause).toBe(UNREAD);
  });

  test("the calendar: Jul 3's cell name and its Day Sheet, in the pay sentences' words", () => {
    const month = recurringCalendar(bundle.db, "2026-07", TODAY);
    const html = renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: TODAY }));
    expect(html.replace(/&#x27;/g, "'")).toContain(
      'aria-label="Jul 3, 2026 — 1 item: Paycheck not yet known (the ledger has not looked for its deposit) $2,943.19"',
    );
    expect(html).not.toContain("not banked yet");
    const jul3 = month.entriesByDay["2026-07-03"]!;
    const sheet = text(renderToStaticMarkup(createElement(DaySheetBody, { entries: jul3 })));
    expect(sheet).toContain("Paycheck not yet known — the ledger has not looked for its deposit");
  });

  test("the dashboard's income card: the gap's unread part", () => {
    const pay = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(pay.gapLabel).toBe(
      "$8,829.57 of it never reached a bank; the other $2,943.19 is for paydays after Jun 30, the last day every " +
        "account that pay lands in has been checked through — so the ledger has not looked for it.",
    );
    // …and the verdict under it names Jul 3 the same way. 🔴 It read "4 paydays have passed since May 8 with no
    // deposit. 3 of them fall on days the records already cover, through Jun 30 — so the pay did not reach a bank."
    // — Jul 3 never named, and "with no deposit" of a day nobody had read (review of 0c9bc8d)
    expect(pay.verdict).toBe(
      "4 paydays have passed since the last deposit on May 8. 3 of them fall on days the records already cover, " +
        "through Jun 30 — so the pay did not reach a bank; the other one falls after Jun 30, the last day every " +
        "account that pay lands in has been checked through — so the ledger has not looked for its deposit. Whether " +
        "it was earned is a different question, and this card cannot answer it.",
    );
  });

  test("/spending's cash-earnings notes — July's, and the year's 'the other payday'", () => {
    const note = (from: string, to: string): string =>
      cashEarningsSectionNotes({
        rows: cashEarningsReadings(bundle.db, { from, to, today: TODAY, withChecked: true }),
        formatDay: formatDayLong,
      })[0]!.body;
    expect(note("2026-07-01", "2026-07-31")).toContain(
      "Paycheck implies $2,943.19 of earnings on Jul 3, 2026, all of it after Tue, Jun 30, 2026, the last day every " +
        "account that pay lands in has been checked through — so the ledger has not looked for it.",
    );
    expect(note("2026-01-01", "2026-12-31")).toContain(
      "Paycheck implies $41,204.66 of earnings over Jan 2 – Jul 3, 2026 and only $29,431.90 reached an account " +
        "the ledger reads through Tue, Jun 30, 2026; the other payday falls after that, the last day every account " +
        "that pay lands in has been checked through.",
    );
  });

  /*
   * ⚖️ Default built, not asked (2026-10-29): the dashboard's pace tile names the payday Free to spend has in
   * neither leg (`SpendingPace.paydaysLeftOut`), in the forecast's words — the checked day as the income card above
   * writes it. Its figure stands only over a July with spending and income found, as the seed's is (rows to Jul 4,
   * the weekly ATM cash filed as Salary): one of each on Jul 2 for this test, removed after it.
   *
   * ⛔ …and that ATM cash — filed under Income, attached to no schedule, in Chase Total Checking where Paycheck lands —
   * is no row the one rule matches to Jul 3 (`lib/unattached-match`: its amount is not the payday's, to the cent), so
   * it takes back nothing: "— not in Free to spend" of Jul 3 (`leftOutOf`). 🔴 Review of 082a0ef5 (B3, MEDIUM): any
   * Income attached to nothing where the pay lands withheld the claim — of a payday that cash cannot be. The seed's Jul
   * 2 ATM CASH DEPOSIT is $1,262.00, Salary, attached to nothing (this test's stand-in: $1,150.00).
   */
  test("the dashboard's pace tile: the payday passed with no deposit, named under the figure", () => {
    const at = "2026-07-02T12:00:00.000Z";
    // Salary, as the ACME deposits are filed
    const salary = bundle.db.select().from(transactions).where(eq(transactions.id, "acme-0")).get()!.categoryId;
    const july = [
      { id: "jul-2-atm", amountCents: 1_150_00, rawDescription: "ATM CASH DEPOSIT 07/02", categoryId: salary },
      { id: "jul-2-coffee", amountCents: -4_50, rawDescription: "BLUE BOTTLE COFFEE", categoryId: null },
    ];
    for (const row of july) {
      bundle.db
        .insert(transactions)
        .values({
          ...row,
          accountId: CHECKING,
          postedOn: "2026-07-02",
          normalizedDescription: row.rawDescription,
          status: "active",
          needsReview: false,
          occurrenceIndex: 0,
          dedupeHash: row.id,
          createdAt: at,
          updatedAt: at,
        })
        .run();
    }
    try {
      const pace = dashboardData(bundle.db, TODAY).pace!;
      expect(pace.freeToSpendCents).not.toBeNull();
      expect(pace.paydaysLeftOut).toEqual({
        text:
          "1 payday worth $2,943.19 already passed this month — not in Free to spend. It falls after Jun 30, the last " +
          "day every account that pay lands in has been checked through — so the ledger has not looked for its deposit.",
        warning: false,
      });
    } finally {
      for (const row of july) bundle.db.delete(transactions).where(eq(transactions.id, row.id)).run();
    }
  });
});
