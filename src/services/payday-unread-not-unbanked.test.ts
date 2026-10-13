import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
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
const { RecurringCalendar } = await import("@/components/recurring/RecurringCalendar");

/**
 * 🔴 VISIBLE on a copy of his ledger 2026-10-12: /recurring?tab=calendar drew the Oct 1 and Oct 8 paydays of "It
 * America LLC (weekly pay)" (+$1,141.92) "not yet known (not banked yet)", while the dashboard, the forecast and
 * /budgets said they "fall after Sep 24, the last day every account that pay lands in has been checked through — so
 * the ledger has not looked for their deposits". `settledVerdict` answered "unbanked" of EVERY passed payday before it
 * asked whether anyone had looked; a bill's day asks first ("no import has covered it yet", his decision 60).
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
  test("Oct 1 and Oct 8 fall after Wells Fargo's Sep 24: no import has covered them yet", () => {
    const october = unsettledPaydays().filter((d) => d.startsWith("2026-10"));
    expect(october).toEqual(["2026-10-01 not_imported", "2026-10-08 not_imported"]);
  });

  test("the weeks on or before Sep 24 stay not banked yet — Aug 13 and Aug 20 too, after Chase's Aug 12", () => {
    const before = unsettledPaydays().filter((d) => compareDates(d.slice(0, 10), "2026-09-24") <= 0);
    expect(before).toContain("2026-08-13 unbanked");
    expect(before).toContain("2026-08-20 unbanked");
    for (const d of before) expect(d).toMatch(/ unbanked$/);
  });

  /*
   * ⛔ ONE READING: the calendar's "not banked yet" marks are exactly the paydays the forecast and /budgets count as
   * checked (`checkedOccurrenceCount`), and its "no import has covered it yet" marks the ones they say nobody has
   * looked for.
   *
   * 🔴 With Wells Fargo open the two frontiers are the same day, so a calendar reading its paydays against the day a
   * series' SILENCE is measured to (`silenceMeasuredThroughBySeries`, which `recurringCalendar` binds to a local named
   * `checkedThrough` a few lines above its payday frontier) passed every test (review of 7fc67d5). They part on a
   * landing account no statement is coming for (`accountsAwaitingStatements`), archived or a cash wallet: its silence
   * is read through today, while the days the ledger has looked at stop where its record does
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
        "2026-10-01 not_imported",
        "2026-10-08 not_imported",
      ]);
      expect(marks.filter((d) => d.endsWith(" unbanked"))).toHaveLength(passed.checkedOccurrenceCount);
      expect(marks.filter((d) => d.endsWith(" not_imported"))).toHaveLength(
        passed.occurrenceCount - passed.checkedOccurrenceCount,
      );
      expect(passed.occurrenceCount - passed.checkedOccurrenceCount).toBe(2);
    },
  );

  test("THE BOUNDARY: a payday ON the day its accounts are checked through was looked for", () => {
    checkedThrough(WF, "2026-09-25", "2026-10-01");
    const october = unsettledPaydays().filter((d) => d.startsWith("2026-10"));
    expect(october).toEqual(["2026-10-01 unbanked", "2026-10-08 not_imported"]);
    const passed = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-10-01", TODAY).series[0]!;
    expect([passed.occurrenceCount, passed.checkedOccurrenceCount]).toEqual([2, 1]);
  });

  test("the day cell's name says it, as the Day Sheet does", () => {
    const month = recurringCalendar(bundle.db, "2026-10", TODAY);
    const html = renderToStaticMarkup(createElement(RecurringCalendar, { initialMonth: month, today: TODAY })).replace(
      /&#x27;/g,
      "'",
    );
    expect(html).toContain(
      'aria-label="Oct 1, 2026 — 1 item: It America LLC (weekly pay) not yet known (no import has covered it yet) $1,141.92"',
    );
    expect(html).not.toContain("not banked yet");
  });
});
