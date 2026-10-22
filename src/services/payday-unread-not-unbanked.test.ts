import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays, compareDates } from "@/lib/dates";
import { unbankedIncomeForSeries } from "./arrears";
import { checkedThroughBySeries, silenceMeasuredThroughBySeries } from "./cash-earnings";
import { CASH_INSTITUTION_NAME } from "./cash-wallet-rule";
import { recurringCalendar, type CalendarEntry } from "./recurring-calendar";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ loadRecurringMonthAction: vi.fn() }));
const { DaySheetBody, RecurringCalendar } = await import("@/components/recurring/RecurringCalendar");

/**
 * 🔴 VISIBLE on a copy of his ledger 2026-10-12: /recurring?tab=calendar drew the Oct 1 and Oct 8 paydays of "It
 * America LLC (weekly pay)" (+$1,141.92) "not yet known (not banked yet)", while the dashboard, the forecast and
 * /budgets said they "fall after Sep 24, the last day every account that pay lands in has been checked through — so
 * the ledger has not looked for their deposits". `settledVerdict` answered "unbanked" of EVERY passed payday before it
 * asked whether anyone had looked; a bill's day asks first ("no statement has covered it yet", his decisions 60, 65).
 *
 * ⛔ The fixture is that ledger's shape (as `late-over-unread-days`): the pay lands in Wells Fargo, checked through
 * Sep 24, and once landed in Chase Checking (two June ATM deposits), checked through Aug 12. The bills' reading
 * (`dueDayReadings`) takes every account a series ever posted to — Chase's Aug 12, measured on the copy — and would
 * call Aug 13 and Aug 20 unread beside a dashboard that counts them checked.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-10-12";
const WF = "acct-wf";
const CHASE = "acct-chase";
const PAY = "series-pay";
const now = (): string => new Date().toISOString();

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Salary, under Income — where his pay is filed (a pay day is one with a row filed as his pay) */
function salaryId(): string {
  const income = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Income"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Salary"), eq(categories.parentId, income.id)))
    .get()!.id;
}

let seq = 0;
function deposit(accountId: string, postedOn: string, amountCents: number): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      postedOn,
      amountCents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: salaryId(),
      recurringSeriesId: PAY,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Days the balance walk has read — what `accountCoverage` grades checked. */
function checkedThrough(accountId: string, from: string, to: string): void {
  for (let day = from; compareDates(day, to) <= 0; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-payday-unread-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  for (const id of [WF, CHASE]) addAccount(id);
  checkedThrough(WF, "2026-06-01", "2026-09-24");
  checkedThrough(CHASE, "2026-06-01", "2026-08-12");
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY,
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      accountId: WF,
      amountCentsAvg: 114_192,
      nextExpectedOn: "2026-10-01",
      nextExpectedAmountCents: 114_192,
      lastMatchedOn: "2026-09-24",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  deposit(CHASE, "2026-06-04", 100_000);
  deposit(CHASE, "2026-06-05", 40_000);
  deposit(WF, "2026-09-17", 114_192);
  deposit(WF, "2026-09-24", 114_192);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every passed payday the calendar draws unsettled, Jun – Oct, as `day reason`. */
function unsettledPaydays(): string[] {
  return ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].flatMap((m) =>
    Object.entries(recurringCalendar(bundle.db, m, TODAY).entriesByDay)
      .flatMap(([day, entries]) => entries.map((e): [string, CalendarEntry] => [day, e]))
      .filter(([, e]) => e.seriesId === PAY && e.state === "unsettled")
      .map(([day, e]) => `${day} ${e.unsettledReason}`)
      .sort(),
  );
}

describe("a payday the ledger has not looked for says so on the calendar — as every pay sentence does", () => {
  test("Oct 1 and Oct 8 fall after Wells Fargo's Sep 24: the ledger has not looked for their deposits", () => {
    const october = unsettledPaydays().filter((d) => d.startsWith("2026-10"));
    expect(october).toEqual(["2026-10-01 not_looked_for", "2026-10-08 not_looked_for"]);
  });

  /*
   * …and the weeks on or before it were looked for — Aug 13 and Aug 20 too, after Chase's Aug 12. 🔴 Every one read
   * "not banked yet", however long ago: his cash weeks beside the dashboard's "never reached a bank" for the same
   * paydays (reading the app, 2026-10-14). Checked through its days to land, a payday never reached a bank.
   */
  test("the weeks on or before Sep 24 were looked for — Aug 13 and Aug 20 never reached a bank", () => {
    const before = unsettledPaydays().filter((d) => compareDates(d.slice(0, 10), "2026-09-24") <= 0);
    expect(before).toContain("2026-08-13 never_banked");
    expect(before).toContain("2026-08-20 never_banked");
    for (const d of before) expect(d).toMatch(/ (unbanked|never_banked)$/);
  });

  /*
   * ⛔ ONE READING: the calendar's "not banked yet" marks are exactly the paydays the forecast and /budgets count as
   * checked (`checkedOccurrenceCount`), and its "the ledger has not looked for its deposit" marks the ones they say
   * nobody has looked for.
   *
   * 🔴 With Wells Fargo open the two frontiers are the same day, so a calendar reading its paydays against the day a
   * series' SILENCE is measured to (`silenceMeasuredThroughBySeries`, which `recurringCalendar` binds to
   * `silenceThroughOf` a few lines above its payday frontier, `paydaysCheckedOf`) passed every test (review of
   * 7fc67d5). They part on a landing account no statement is coming for (`accountsAwaitingStatements`), archived or a
   * cash wallet: its silence is read through today, while the days the ledger has looked at stop where its record does
   * (`checkedThroughBySeries`, review of 82d75d7). Under that swap Oct 1 and Oct 8 read "not banked yet" beside a
   * forecast note and /budgets saying "the ledger has not looked for their deposits"; swapped in the note's count
   * instead, the split fails here.
   */
  test.each([
    { landing: "open", archived: false, wallet: false, silenceThrough: "2026-09-24" },
    { landing: "archived", archived: true, wallet: false, silenceThrough: TODAY },
    { landing: "a cash wallet", archived: false, wallet: true, silenceThrough: TODAY },
  ])(
    "the calendar's two reasons split the passed paydays where the forecast's note does — Wells Fargo $landing",
    ({ archived, wallet, silenceThrough }) => {
      bundle.db.update(accounts).set({ isActive: !archived }).where(eq(accounts.id, WF)).run();
      if (wallet) {
        const cash = bundle.db.insert(institutions).values({ name: CASH_INSTITUTION_NAME }).returning().get();
        bundle.db.update(accounts).set({ institutionId: cash.id }).where(eq(accounts.id, WF)).run();
      }
      // the fixture can tell the two frontiers apart: the days looked at stop at Sep 24 either way
      expect(checkedThroughBySeries(bundle.db, TODAY)(PAY)).toBe("2026-09-24");
      expect(silenceMeasuredThroughBySeries(bundle.db, TODAY)(PAY)).toBe(silenceThrough);

      const passed = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-06-01", TODAY).series[0]!;
      const marks = unsettledPaydays();
      expect(marks.filter((d) => d.startsWith("2026-10"))).toEqual([
        "2026-10-01 not_looked_for",
        "2026-10-08 not_looked_for",
      ]);
      // looked for: not banked yet, or — through its days to land — never reached a bank, as the note counts its warning
      expect(marks.filter((d) => / (unbanked|never_banked)$/.test(d))).toHaveLength(passed.checkedOccurrenceCount);
      expect(marks.filter((d) => d.endsWith(" never_banked"))).toHaveLength(passed.pastGraceOccurrenceCount);
      expect(marks.filter((d) => d.endsWith(" not_looked_for"))).toHaveLength(
        passed.occurrenceCount - passed.checkedOccurrenceCount,
      );
      expect(passed.occurrenceCount - passed.checkedOccurrenceCount).toBe(2);
    },
  );

  test("THE BOUNDARY: a payday ON the day its accounts are checked through was looked for", () => {
    checkedThrough(WF, "2026-09-25", "2026-10-01");
    const october = unsettledPaydays().filter((d) => d.startsWith("2026-10"));
    expect(october).toEqual(["2026-10-01 unbanked", "2026-10-08 not_looked_for"]);
    const passed = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-10-01", TODAY).series[0]!;
    expect([passed.occurrenceCount, passed.checkedOccurrenceCount]).toEqual([2, 1]);
  });

  /*
   * ⚖️ In the pay sentences' words (`notLookedForDeposits`, his decision 65's for pay), whatever the frontier: a day
   * (Sep 24), or an account the pay could land in with no checked record at all, where the pay sentence says "the
   * ledger has not checked every account that pay could land in". 🔴 Both read "no import has covered it yet", then "no
   * statement has covered it yet" — a bill's words, and the only ones beside his pay that say a statement is coming.
   */
  function october1(): { cell: string; sheet: string } {
    const month = recurringCalendar(bundle.db, "2026-10", TODAY);
    const decode = (html: string): string => html.replace(/&#x27;/g, "'");
    const render = (node: Parameters<typeof renderToStaticMarkup>[0]): string => decode(renderToStaticMarkup(node));
    const cell = render(createElement(RecurringCalendar, { initialMonth: month, today: TODAY }));
    const sheet = render(createElement(DaySheetBody, { entries: month.entriesByDay["2026-10-01"]! }));
    return { cell, sheet: sheet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  }

  test("the day cell's name says it — and so does the Day Sheet the cell opens, read off the sheet itself", () => {
    const { cell, sheet } = october1();
    expect(cell).toContain(
      'aria-label="Oct 1, 2026 — 1 item: It America LLC (weekly pay) not yet known (the ledger has not looked for its deposit) $1,141.92"',
    );
    expect(sheet).toContain("not yet known — the ledger has not looked for its deposit");
    for (const html of [cell, sheet]) {
      expect(html).not.toContain("not banked yet");
      expect(html).not.toContain("no statement has covered");
    }
  });

  test("an account the pay could land in with no checked record: the same words, never a statement's", () => {
    bundle.db.delete(dailyBalances).where(eq(dailyBalances.accountId, WF)).run();
    expect(checkedThroughBySeries(bundle.db, TODAY)(PAY)).toBeNull();
    const { cell, sheet } = october1();
    expect(sheet).toContain("not yet known — the ledger has not looked for its deposit");
    expect(cell).not.toContain("no statement has covered");
  });

  /*
   * ⚖️ …and where NO statement is coming — the pay lands in an archived account or a cash wallet — the words promise
   * none: no "yet". 🔴 "no statement has covered it yet" there waits for an upload /imports will never ask for.
   */
  test.each([
    { landing: "archived", archived: true, wallet: false },
    { landing: "a cash wallet", archived: false, wallet: true },
  ])("Wells Fargo $landing: no word of a statement still to come", ({ archived, wallet }) => {
    bundle.db.update(accounts).set({ isActive: !archived }).where(eq(accounts.id, WF)).run();
    if (wallet) {
      const cash = bundle.db.insert(institutions).values({ name: CASH_INSTITUTION_NAME }).returning().get();
      bundle.db.update(accounts).set({ institutionId: cash.id }).where(eq(accounts.id, WF)).run();
    }
    const { cell, sheet } = october1();
    expect(sheet).toContain("not yet known — the ledger has not looked for its deposit");
    for (const html of [cell, sheet]) expect(html).not.toMatch(/statement has covered|imported yet|import has covered/);
  });
});
