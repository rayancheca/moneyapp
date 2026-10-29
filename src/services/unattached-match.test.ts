import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { alreadyDueWords, unsettledWords } from "@/components/recurring/labels";
import { arrearsClause, NOT_POSTED, overdueReading } from "@/lib/arrears-reading";
import { arrearsSentence } from "@/lib/committed";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { passedPaydaysWords, unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings } from "./cash-earnings";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { incomeCard } from "./income-card";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";
import { unattachedMatchesBySeries } from "./unattached-match";

/**
 * ⛔ A row that matches a payday or a due day to the cent, sitting unattached, is never reported as money that did not
 * arrive (`lib/unattached-match`) — and is never counted as paid.
 *
 * His shape on 2026-10-29, after the Wells Fargo statement of Sep 25 → Oct 26 was imported and before he filed it:
 * the weekly pay ($1,141.92 every Thursday, on Wells Fargo, its last attached deposit Sep 24) and four +$1,141.92
 * payroll rows (Oct 1, 8, 15, 22) unattached; the Car lease (−$695.04 on the 15th, no account of its own, paid from
 * Wells Fargo) and its Oct 15 "Mbfs.Com Auto Pay" unattached. Wells Fargo checked through Oct 26.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-10-29";
const WF = "acct-wf";
const CARD = "acct-card";
const PAY = "series-pay";
const LEASE = "series-lease";
const PAYDAYS = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"];
const now = (): string => new Date().toISOString();

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id === WF ? "Wells Fargo" : "Card",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function categoryId(name: string, parent: string): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parent), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, top.id)))
    .get()!.id;
}

let seq = 0;
function row(
  postedOn: string,
  amountCents: number,
  opts: { accountId?: string; seriesId?: string | null; categoryId?: string | null; status?: "active" | "superseded"; transferGroupId?: string } = {},
): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: opts.accountId ?? WF,
      postedOn,
      amountCents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: opts.categoryId ?? null,
      recurringSeriesId: opts.seriesId ?? null,
      status: opts.status ?? "active",
      transferGroupId: opts.transferGroupId ?? null,
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-unattached-match-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(WF);
  addAccount(CARD);
  checkedThrough(bundle.db, WF, "2026-10-26", "2026-08-01");
  checkedThrough(bundle.db, CARD, "2026-10-26", "2026-08-01");
  const salary = categoryId("Salary", "Income");
  bundle.db
    .insert(recurringSeries)
    .values([
      {
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
      },
      {
        id: LEASE,
        name: "Car lease",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        accountId: null,
        amountCentsAvg: -69_504,
        toleranceDays: 3,
        nextExpectedOn: "2026-10-15",
        nextExpectedAmountCents: -69_504,
        userAmountCents: -69_504,
        anchorDay: 15,
        lastMatchedOn: "2026-09-15",
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      },
    ])
    .run();
  // the attached history: his pay through Sep 24, the lease's payments through Sep 15, all on Wells Fargo
  for (const day of ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]) {
    row(day, 114_192, { seriesId: PAY, categoryId: salary });
  }
  for (const day of ["2026-07-15", "2026-08-15", "2026-09-15"]) row(day, -69_504, { seriesId: LEASE });
  row("2026-10-26", -450); // an unrelated coffee: Wells Fargo's rows reach the checked day
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The October rows the statement brought in, attached to nothing. */
function importUnattached(paydays: readonly string[] = PAYDAYS, lease = true): void {
  for (const day of paydays) row(day, 114_192);
  if (lease) row("2026-10-15", -69_504);
}

const payDays = (days: readonly string[] = PAYDAYS) => days.map((date) => ({ date, amountCents: 114_192 }));

describe("the predicate (`unattachedMatchesBySeries`): active, unattached, on the series' account, to the cent", () => {
  test("his four payroll rows match his four paydays, and the lease's row its Oct 15 though the lease names no account", () => {
    importUnattached();
    const got = unattachedMatchesBySeries(
      bundle.db,
      new Map([
        [PAY, payDays()],
        [LEASE, [{ date: "2026-10-15", amountCents: -69_504 }]],
      ]),
      TODAY,
    );
    expect(got.get(PAY)?.map((m) => m.row.postedOn)).toEqual(PAYDAYS);
    expect(got.get(LEASE)?.map((m) => m.row.postedOn)).toEqual(["2026-10-15"]);
  });

  test.each([
    ["on another account", { accountId: CARD }],
    ["superseded", { status: "superseded" as const }],
    ["attached to a series", { seriesId: LEASE }],
    ["a leg of a transfer", { transferGroupId: "tg-1" }],
  ])("a row %s is no candidate", (_, opts) => {
    row("2026-10-01", 114_192, opts);
    expect(unattachedMatchesBySeries(bundle.db, new Map([[PAY, payDays(["2026-10-01"])]]), TODAY).get(PAY)).toBeUndefined();
  });

  test("nothing dated after today has arrived — and a series with no account and no payment has nowhere to look", () => {
    row("2026-10-30", 114_192);
    expect(
      unattachedMatchesBySeries(bundle.db, new Map([[PAY, payDays(["2026-10-29"])]]), TODAY).get(PAY),
    ).toBeUndefined();
    bundle.db.update(transactions).set({ recurringSeriesId: null }).where(eq(transactions.recurringSeriesId, LEASE)).run();
    row("2026-10-15", -69_504);
    expect(
      unattachedMatchesBySeries(bundle.db, new Map([[LEASE, [{ date: "2026-10-15", amountCents: -69_504 }]]]), TODAY).get(
        LEASE,
      ),
    ).toBeUndefined();
  });
});

describe("the bills: no surface says the Car lease's Oct 15 'has not posted' beside its unattached row — and it stays owed", () => {
  function leaseSurfaces() {
    const book = committedBook(bundle.db, TODAY);
    const detail = forecastCurrentMonth(bundle.db, TODAY).components.find((c) => c.label === "Car lease")?.detail ?? "";
    const o = seriesDetail(bundle.db, LEASE, TODAY).overdue!;
    return {
      owed: book.overdueCents,
      runway: arrearsSentence(book),
      mathTable: detail,
      page: alreadyDueWords(overdueReading(o), o.graceDays, o.occurrenceCount, o.carriedGrace),
      next: arrearsClause(overdueReading(o), NOT_POSTED),
    };
  }

  test("without the row: 'has not posted', every surface", () => {
    const s = leaseSurfaces();
    expect(s.runway).toBe("A further $695.04 came due earlier this month and has not posted.");
    expect(s.mathTable).toContain("came due Oct 15 and has not posted");
    expect(s.page.heading).toBe("Already due, and not posted");
    expect(s.next).toBe("not posted");
  });

  test("with it: the row by its day and amount, the money still owed, the tone unchanged", () => {
    importUnattached([]);
    const s = leaseSurfaces();
    const words = "matched to the cent by a row of $695.04 on Oct 15 that is not attached to it";
    expect(s.owed).toBe(69_504);
    expect(s.runway).toBe(`A further $695.04 came due earlier this month and is ${words}.`);
    expect(s.mathTable).toContain(`came due Oct 15 and is ${words}`);
    expect(s.page.heading).toBe(`Already due, and ${words}`);
    expect(s.page.body).toContain("no posting attached to this bill within 3 days of it; they hold a row of $695.04");
    expect(s.page.warning).toBe(true);
    expect(s.next).toBe(words);
    for (const said of [s.runway, s.mathTable, s.page.heading, s.page.body, s.next]) expect(said).not.toMatch(/has not posted|not posted/);
  });

  test("a cent off is not a match: 'has not posted' stays", () => {
    row("2026-10-15", -69_503);
    expect(leaseSurfaces().runway).toBe("A further $695.04 came due earlier this month and has not posted.");
  });

  test("the tolerance is the series' own: three days after the due day matches, four does not", () => {
    row("2026-10-18", -69_504);
    expect(leaseSurfaces().runway).toContain("a row of $695.04 on Oct 18");
    bundle.db.update(transactions).set({ postedOn: "2026-10-19" }).where(eq(transactions.postedOn, "2026-10-18")).run();
    expect(leaseSurfaces().runway).toBe("A further $695.04 came due earlier this month and has not posted.");
  });
});

describe("the pay: no surface says his October paydays did not reach a bank beside their unattached payroll rows", () => {
  const spendingNote = () =>
    cashEarningsSectionNotes({
      rows: cashEarningsReadings(bundle.db, { from: "2026-10-01", to: "2026-10-31", today: TODAY, withChecked: true }),
      formatDay: formatDayLong,
    })
      .map((n) => n.body)
      .join(" ");

  test("without the rows: the absence claims his ledger copy read before the filing", () => {
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.verdict).toContain("4 paydays have passed since Sep 24 with no deposit. 4 of them fall on days the records");
    expect(line.verdict).toContain("so the pay did not reach a bank");
    expect(spendingNote()).toContain("and none of it reached an account.");
    expect(passedPaydaysWords(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome, formatDayShort).notProjected).toBe(
      "Pay that never reaches a bank cannot be projected as arriving",
    );
  });

  test("with them: each surface names the rows, and counts nothing they hold as banked", () => {
    importUnattached(PAYDAYS, false);
    const rows = "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that are not attached to it";
    const card = incomeCard(bundle.db, TODAY)!;
    const line = card.pay[0]!;
    expect(line.verdict).toBe(
      "4 paydays have passed since Sep 24 with no deposit attached to this schedule. 4 of them fall on days the records " +
        `already cover, through Oct 26 — they are matched to the cent by ${rows}. Whether it was earned is a different ` +
        "question, and this card cannot answer it.",
    );
    expect(line.bankedCents).toBe(4 * 114_192);
    expect(line.unattachedCents).toBe(4 * 114_192);
    expect(line.gapLabel).toContain(`is matched to the cent by ${rows}`);
    expect(line.gapLabel).not.toContain("never reached a bank");
    expect(card.postedNote).toContain("though the rows the lines above name match its paydays to the cent");
    const note = spendingNote();
    expect(note).toContain(`and none of it reached an account attached to it; $4,567.68 is matched to the cent by ${rows}.`);
    expect(note).not.toContain("none of it reached an account.");
    const words = passedPaydaysWords(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome, formatDayShort);
    expect(words.notProjected).toBe(`Pay matched to the cent by ${rows} cannot be projected as arriving`);
    expect(words.passed).toBe("already passed this month with no deposit attached to it");
    expect(words.warning).toBe(true);
    const budgets = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", TODAY);
    expect(budgets.passedUnpaidCents).toBe(4 * 114_192);
    expect(budgets.passedUnpaidUnattached.map((m) => m.date)).toEqual(PAYDAYS);
  });

  /*
   * 🔴 Review of e6ad55a (MEDIUM): with a payday not looked for yet, his pay's page (`words.unread ??`) and /budgets
   * (`passedNoDeposit` only when the clause is null) print the frontier clause alone — on the pre-filing copy read Oct
   * 31, "4 fall on days already checked, with no deposit attached to it; the other one falls after Mon, Oct 26,
   * 2026 …", never the rows' day or amount.
   */
  test("with a payday not looked for yet, read Oct 31: his pay's page, /budgets and the forecast name the rows", () => {
    importUnattached(PAYDAYS, false);
    const today = "2026-10-31";
    const clause =
      "4 fall on days already checked, with no deposit attached to it — they are matched to the cent by rows of " +
      "$1,141.92 on Thu, Oct 1, 2026, Thu, Oct 8, 2026, Thu, Oct 15, 2026, and Thu, Oct 22, 2026 that are not " +
      "attached to it; the other one falls after Mon, Oct 26, 2026, the last day every account that pay lands in has " +
      "been checked through.";
    // his pay's page prints the clause as its body (`PassedPaydaysCard`)
    expect(passedPaydaysWords(seriesDetail(bundle.db, PAY, today).unbankedPaydays!, formatDayLong).unread).toBe(clause);
    // /budgets prints it from its own reading of the month (src/app/budgets/page.tsx)
    const income = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", today);
    const budgets = unbankedIncomeFrontierClause(
      {
        occurrenceCount: income.passedUnpaidOccurrences,
        checkedOccurrenceCount: income.passedUnpaidCheckedOccurrences,
        frontier: income.passedUnpaidFrontier,
        unattached: income.passedUnpaidUnattached,
      },
      formatDayLong,
    );
    expect(budgets).toBe(clause);
    // the forecast's note prints the clause and its subject, which points at the rows rather than naming them twice
    const forecast = passedPaydaysWords(forecastCurrentMonth(bundle.db, today).unbankedIncome, formatDayLong);
    expect(forecast.unread).toBe(clause);
    expect(forecast.notProjected).toBe(
      "Pay those rows match, and pay the ledger has not looked for, cannot be projected as arriving",
    );
  });

  // ⛔ of a silence two paydays long that one row answers, "1 of them is" — "it is" said the silence was the row's
  test("one row of a two-payday silence the ledger has read: '1 of them is matched', never 'it is'", () => {
    const salary = categoryId("Salary", "Income");
    for (const day of PAYDAYS.slice(0, 2)) row(day, 114_192, { seriesId: PAY, categoryId: salary });
    importUnattached(PAYDAYS.slice(2, 3), false);
    expect(incomeCard(bundle.db, "2026-10-27")!.pay[0]!.verdict).toBe(
      "2 paydays have passed since Oct 8 with no deposit attached to this schedule: 1 of them is matched to the cent " +
        "by a row of $1,141.92 on Oct 15 that is not attached to it — a schedule is called stale only after 3 quiet " +
        "periods, so this is not a warning yet.",
    );
  });

  test("three of four rows: the fourth payday is still the one that did not reach a bank", () => {
    importUnattached(PAYDAYS.slice(0, 3), false);
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toContain(
      "— 3 of them are matched to the cent by rows of $1,141.92 on Oct 1, Oct 8, and Oct 15 that are not attached to " +
        "it, and for the other 1 the pay did not reach a bank",
    );
  });
});

/*
 * ⛔ The calendar asks the one rule too (`settledVerdict`, `asksForUnattachedMatch`). 🔴 Review of de31d22 (HIGH): it
 * never did — his ledger copy (2026-10-29, after the Oct 26 import, before his filing) drew Oct 1, 8, 15 and 22 "not yet
 * known — never reached a bank $1,141.92" beside the forecast card's "Pay matched to the cent by rows of $1,141.92 …",
 * and, with Breezeline's Oct 10 −$50.00 unlinked, a red ✕ on Oct 8 beside /recurring's "Oct 8 — matched to the cent by
 * a row of $50.00 on Oct 10 that is not attached to it".
 */
describe("the calendar: no ✕ and no 'never reached a bank' beside a row matching the day to the cent — and none paid", () => {
  const october = () => recurringCalendar(bundle.db, "2026-10", TODAY);
  /** the series' expected mark on the day — the one carrying no posting of its own */
  const markOn = (day: string, seriesId: string) =>
    october().entriesByDay[day]?.find((e) => e.seriesId === seriesId && e.transactionId === null);

  test("without the rows: each payday never reached a bank, and the lease's Oct 15 is missed", () => {
    for (const day of PAYDAYS) expect(markOn(day, PAY)).toMatchObject({ state: "unsettled", unsettledReason: "never_banked" });
    expect(markOn("2026-10-15", LEASE)).toMatchObject({ state: "missed", unsettledReason: null });
  });

  test("with them: each mark names its row and stays not yet known — never paid, never missed", () => {
    importUnattached();
    for (const day of PAYDAYS) {
      const mark = markOn(day, PAY)!;
      expect(mark).toMatchObject({ state: "unsettled", unsettledReason: "matched_unattached", settledCents: null });
      expect(unsettledWords(mark)).toBe(
        `matched to the cent by a row of $1,141.92 on ${formatDayShort(day)} that is not attached to it`,
      );
    }
    const lease = markOn("2026-10-15", LEASE)!;
    expect(lease).toMatchObject({ state: "unsettled", unsettledReason: "matched_unattached" });
    expect(unsettledWords(lease)).toBe("matched to the cent by a row of $695.04 on Oct 15 that is not attached to it");
    const month = october();
    expect(month.missedCount).toBe(0);
    // nothing they hold is settled: the month's Settled figure is what it was without them
    expect(month.postedNetCents).toBe(0);
  });

  test("a cent off, or past the lease's own three days, is no match: the ✕ stays", () => {
    row("2026-10-15", -69_503);
    row("2026-10-19", -69_504);
    expect(markOn("2026-10-15", LEASE)).toMatchObject({ state: "missed", unsettledReason: null });
  });
});

/*
 * 🔴 Review of de31d22 (HIGH): with b53989c's link, the next Wells Fargo import ATTACHES his four payroll rows — linked
 * `detected`, category NULL, as an import's link files nothing (`recurring-links`) — and settlement counts no unfiled
 * credit (`payDayRows`), while the one rule skipped every row with a series link. Trial import of the Oct 26 statement
 * into the pre-import copy at de31d22: "4 paydays have passed since Sep 24 with no deposit. … — so the pay did not reach
 * a bank", the difference "never reached a bank", /spending "none of it reached an account", the forecast "Pay that never
 * reaches a bank", and the calendar Oct 1, 8, 15 and 22 "never reached a bank". ⚖️ Default built, not asked
 * (2026-10-29): such a row is named — attached, not filed as income — and still counted as nothing; whether the import
 * should FILE it is his call.
 */
describe("an import's link that files nothing: his payroll rows attached and unfiled are named, never called absent", () => {
  /** The October rows the next statement brings in, as the import links them: attached by detection, filed nowhere. */
  function importLinkedUnfiled(paydays: readonly string[] = PAYDAYS): void {
    for (const day of paydays) {
      const id = row(day, 114_192, { seriesId: PAY });
      bundle.db.update(transactions).set({ seriesLinkSource: "detected" }).where(eq(transactions.id, id)).run();
    }
  }
  const spendingNote = () =>
    cashEarningsSectionNotes({
      rows: cashEarningsReadings(bundle.db, { from: "2026-10-01", to: "2026-10-31", today: TODAY, withChecked: true }),
      formatDay: formatDayLong,
    })
      .map((n) => n.body)
      .join(" ");
  const rows = "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that are attached to it but not filed as income";

  test("the predicate takes a row attached to the pay and filed nowhere — never one its settlement counts, nor a bill's", () => {
    importLinkedUnfiled();
    const got = unattachedMatchesBySeries(bundle.db, new Map([[PAY, payDays()]]), TODAY).get(PAY) ?? [];
    expect(got.map((m) => [m.row.postedOn, m.row.notFiledAsIncome])).toEqual(PAYDAYS.map((d) => [d, true]));
    // filed under Income on its day, it is a deposit settlement reads: it pays a payday, and no surface names it
    bundle.db
      .update(transactions)
      .set({ categoryId: categoryId("Salary", "Income") })
      .where(and(eq(transactions.postedOn, "2026-10-22"), eq(transactions.recurringSeriesId, PAY)))
      .run();
    const filed = unattachedMatchesBySeries(bundle.db, new Map([[PAY, payDays()]]), TODAY).get(PAY) ?? [];
    expect(filed.map((m) => m.row.postedOn)).not.toContain("2026-10-22");
    // a bill's linked row is a payment of it, whatever its filing
    row("2026-10-15", -69_504, { seriesId: LEASE });
    expect(
      unattachedMatchesBySeries(bundle.db, new Map([[LEASE, [{ date: "2026-10-15", amountCents: -69_504 }]]]), TODAY).get(
        LEASE,
      ),
    ).toBeUndefined();
  });

  test("every surface names the rows as attached and not filed as income, and counts none of them", () => {
    importLinkedUnfiled();
    const card = incomeCard(bundle.db, TODAY)!;
    const line = card.pay[0]!;
    expect(line.verdict).toBe(
      "4 paydays have passed since Sep 24 with no deposit attached to this schedule and filed as income. 4 of them fall " +
        `on days the records already cover, through Oct 26 — they are matched to the cent by ${rows}. Whether it was ` +
        "earned is a different question, and this card cannot answer it.",
    );
    expect(line.bankedCents).toBe(4 * 114_192);
    expect(line.gapLabel).toContain(`is matched to the cent by ${rows}`);
    expect(line.gapLabel).not.toContain("never reached a bank");
    expect(card.postedNote).toBe(
      "No income at all has been recorded in Oct 2026, though the rows the lines above name match its paydays to the " +
        "cent — they are not filed as income, so none of them is counted.",
    );
    const note = spendingNote();
    expect(note).toContain(
      `and none of it reached an account attached to it and filed as income; $4,567.68 is matched to the cent by ${rows}.`,
    );
    expect(note).toContain("that money sits in the rows named above, not filed as income, was held as cash");
    expect(note).not.toContain("none of it reached an account.");
    const words = passedPaydaysWords(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome, formatDayShort);
    expect(words.notProjected).toBe(`Pay matched to the cent by ${rows} cannot be projected as arriving`);
    expect(words.passed).toBe("already passed this month with no deposit attached to it and filed as income");
    const budgets = incomeExpectation(bundle.db, "2026-10-01", "2026-10-31", TODAY);
    expect(budgets.passedUnpaidCents).toBe(4 * 114_192);
    expect(budgets.passedUnpaidUnattached.map((m) => m.date)).toEqual(PAYDAYS);
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    for (const day of PAYDAYS) {
      const mark = october.entriesByDay[day]!.find((e) => e.seriesId === PAY && e.transactionId === null)!;
      expect(mark.state).toBe("unsettled");
      expect(unsettledWords(mark)).toBe(
        `matched to the cent by a row of $1,141.92 on ${formatDayShort(day)} that is attached to it but not filed as income`,
      );
    }
  });
});

/*
 * 🔴 Review of de31d22 (MEDIUM): /spending's shortfall note never read the matched paydays — on the pre-filing copy read
 * with today 2026-10-13 it said "It America LLC (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, and none
 * of it reached a bank." while the dashboard named the rows; with Oct 1, 8 and 15 filed, Oct 22 unattached and today
 * Nov 2, "…$941.92 never reached a bank" beside the card's "$1,141.92 is matched to the cent by a row of $1,141.92 on
 * Oct 22". ⛔ The difference's one split (`neverSplit`, `neverClauses`), shared with Earned vs banked.
 */
describe("/spending's shortfall note names the rows the one rule matched, as the card's difference does", () => {
  const notes = (today: string) =>
    cashEarningsSectionNotes({
      rows: cashEarningsReadings(bundle.db, { from: "2026-10-01", to: "2026-10-31", today, withChecked: true }),
      formatDay: formatDayLong,
    }).map((n) => n.body);

  test("a live schedule's October, Oct 1 and Oct 8 matched: all of it is the rows' — never 'none of it reached a bank'", () => {
    const today = "2026-10-13";
    expect(notes(today).join(" ")).toContain("came to $2,283.84, and none of it reached a bank.");
    importUnattached(PAYDAYS.slice(0, 2), false);
    const note = notes(today).join(" ");
    expect(note).toContain(
      "It America LLC (weekly pay)'s paydays over Oct 1 – 8, 2026 came to $2,283.84, and all of it is matched to the " +
        "cent by rows of $1,141.92 on Oct 1 and Oct 8 that are not attached to it.",
    );
    expect(note).not.toContain("reached a bank");
  });

  test("three filed, Oct 22 unattached: the banked part, and the row for the rest — the card's frontier clause too", () => {
    const today = "2026-11-02";
    const salary = categoryId("Salary", "Income");
    for (const day of PAYDAYS.slice(0, 3)) row(day, 114_192, { seriesId: PAY, categoryId: salary });
    expect(notes(today).join(" ")).toContain(
      "of which $3,425.76 was banked inside the window and $1,141.92 never reached a bank",
    );
    importUnattached(PAYDAYS.slice(3), false);
    const note = notes(today).join(" ");
    expect(note).toContain(
      "of which $3,425.76 was banked inside the window and $1,141.92 is matched to the cent by a row of $1,141.92 on " +
        "Oct 22 that is not attached to it",
    );
    expect(note).not.toContain("never reached a bank");
    // ⛔ …and the verdict below the stale bar names the row, as the difference under it does (review of e6ad55a)
    expect(incomeCard(bundle.db, today)!.pay[0]!.verdict).toBe(
      "2 paydays have passed since the last deposit on Oct 15. 1 falls on a day already checked, with no deposit " +
        "attached to it — it is matched to the cent by a row of $1,141.92 on Oct 22 that is not attached to it; the " +
        "other one falls after Oct 26, the last day every account that pay lands in has been checked through.",
    );
  });

  // his own shape: the off-cycle +$200.00 of Oct 15, filed Salary, paid no payday and is netted into October's figure
  test("…and with money toward no payday netted in, the figure is the payday's — the row matches the payday", () => {
    const today = "2026-11-02";
    const salary = categoryId("Salary", "Income");
    for (const day of PAYDAYS.slice(0, 3)) row(day, 114_192, { seriesId: PAY, categoryId: salary });
    row("2026-10-15", 20_000, { seriesId: PAY, categoryId: salary });
    expect(notes(today).join(" ")).toContain("and $941.92 never reached a bank");
    importUnattached(PAYDAYS.slice(3), false);
    const note = notes(today).join(" ");
    expect(note).toContain(
      "and $941.92 is for the payday of Oct 22, which a row of $1,141.92 on Oct 22 that is not attached to it matches " +
        "to the cent",
    );
    expect(note).not.toContain("never reached a bank");
  });
});

/*
 * ⛔ ONE ROW ANSWERS ONE SERIES' DAY — on every surface, whichever series a page asks about (`unattachedMatchesAcross`,
 * and the `rivals` a reader asked of some series passes). 🔴 Review of e6ad55a (MEDIUM): with two confirmed −$15.99
 * monthly bills on one card both due Oct 10 and a single −$15.99 row of Oct 10 unattached, the runway read "A further
 * $727.02 came due earlier this month and $31.98 is matched to the cent by rows of $15.99 on Oct 10 and Oct 10 that are
 * not attached to it, and $695.04 has not posted." — and each bill's page claimed the row, so the one that really did
 * not post lost its "not posted".
 */
describe("two bills of one amount due one day, one row: it answers one of them, on every surface", () => {
  // uuidv7 ids sort by creation: A is the older
  const A = "series-stream-a";
  const B = "series-stream-b";
  const due = [{ date: "2026-10-10", amountCents: -1_599 }];
  const ROW_OF_OCT_10 = "matched to the cent by a row of $15.99 on Oct 10 that is not attached to it";
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values(
        [A, B].map((id) => ({
          id,
          name: id === A ? "Streaming A" : "Streaming B",
          kind: "subscription" as const,
          cadence: "monthly" as const,
          intervalDaysAvg: 30,
          accountId: CARD,
          amountCentsAvg: -1_599,
          toleranceDays: 3,
          nextExpectedOn: "2026-10-10",
          nextExpectedAmountCents: -1_599,
          userAmountCents: -1_599,
          anchorDay: 10,
          lastMatchedOn: "2026-09-10",
          status: "confirmed" as const,
          createdAt: now(),
          updatedAt: now(),
        })),
      )
      .run();
    // three charges each: a schedule the calendar grades (`scheduleIsProven`)
    for (const id of [A, B]) {
      for (const day of ["2026-07-10", "2026-08-10", "2026-09-10"]) row(day, -1_599, { accountId: CARD, seriesId: id });
    }
    row("2026-10-26", -450, { accountId: CARD }); // the card's rows reach its checked day
  });
  const pageOf = (id: string): string => {
    const o = seriesDetail(bundle.db, id, TODAY).overdue!;
    return alreadyDueWords(overdueReading(o), o.graceDays, o.occurrenceCount, o.carriedGrace).heading;
  };
  const markOn = (seriesId: string) =>
    recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-10"]!.find(
      (e) => e.seriesId === seriesId && e.transactionId === null,
    )!;

  test("asked together, the row goes to one of them — the older — and the other is matched by nothing", () => {
    const only = row("2026-10-10", -1_599, { accountId: CARD });
    const got = unattachedMatchesBySeries(
      bundle.db,
      new Map([
        [B, due],
        [A, due],
      ]),
      TODAY,
    );
    expect(got.get(A)?.map((m) => m.row.id)).toEqual([only]);
    expect(got.get(B)).toBeUndefined();
  });

  // ⛔ a rival is a series the caller did NOT ask of: its reading of an asked one never adds a day the caller left out
  test("the asked series' own days stand beside its rivals' reading of it", () => {
    const only = row("2026-10-10", -1_599, { accountId: CARD });
    const asked = new Map([[A, [{ date: "2026-10-13", amountCents: -1_599 }]]]);
    const got = unattachedMatchesBySeries(bundle.db, asked, TODAY, { rivals: () => new Map([[A, due]]) });
    expect(got.get(A)?.map((m) => [m.date, m.row.id])).toEqual([["2026-10-13", only]]);
  });

  test("the runway names it once and owes the other bill's $15.99 as not posted — the money once, never $31.98", () => {
    const only = row("2026-10-10", -1_599, { accountId: CARD });
    const book = committedBook(bundle.db, TODAY);
    expect(book.overdueCents).toBe(69_504 + 2 * 1_599);
    expect(book.overdueUnattached.map((m) => m.row.id)).toEqual([only]);
    const runway = arrearsSentence(book)!;
    expect(runway).toContain("$15.99 is matched to the cent by a row of $15.99 on Oct 10 that is not attached to it");
    expect(runway).toContain("$711.03 has not posted");
    expect(runway).not.toContain("$31.98");
  });

  test("each bill's own page, asked alone, agrees with the runway: A names the row, B has not posted", () => {
    row("2026-10-10", -1_599, { accountId: CARD });
    expect(pageOf(A)).toBe(`Already due, and ${ROW_OF_OCT_10}`);
    expect(pageOf(B)).toBe("Already due, and not posted");
    // …and the calendar: one mark named by the row, the other a ✕
    expect(markOn(A)).toMatchObject({ state: "unsettled", unsettledReason: "matched_unattached" });
    expect(markOn(B)).toMatchObject({ state: "missed", unsettledReason: null });
  });

  test("two rows answer the two bills, one each", () => {
    const x = row("2026-10-10", -1_599, { accountId: CARD });
    const y = row("2026-10-10", -1_599, { accountId: CARD });
    expect(
      committedBook(bundle.db, TODAY)
        .overdueUnattached.map((m) => m.row.id)
        .sort(),
    ).toEqual([x, y].sort());
    for (const id of [A, B]) expect(pageOf(id)).toBe(`Already due, and ${ROW_OF_OCT_10}`);
  });
});

/*
 * ⛔ …and of two pay schedules: the forecast, which reads every pay schedule, each schedule's own page, which reads only
 * itself (`unbankedIncomeThisMonth`), and Earned vs banked's lines give one row to one payday of one schedule.
 */
describe("two pay schedules of one amount on one account, one row: it answers one of them, on every surface", () => {
  const PAY2 = "series-pay2";
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: PAY2,
        name: "Second job (weekly pay)",
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
    const salary = categoryId("Salary", "Income");
    for (const day of ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]) {
      row(day, 114_192, { seriesId: PAY2, categoryId: salary });
    }
  });

  test("the forecast, each pay page and the card's lines name it under one schedule — the older — only", () => {
    const only = row("2026-10-01", 114_192);
    const forecast = forecastCurrentMonth(bundle.db, TODAY).unbankedIncome.unattached ?? [];
    expect(forecast.map((m) => m.row.id)).toEqual([only]);
    const pageRows = (id: string): string[] =>
      (seriesDetail(bundle.db, id, TODAY).unbankedPaydays!.unattached ?? []).map((m) => m.row.id);
    expect(pageRows(PAY)).toEqual([only]);
    expect(pageRows(PAY2)).toEqual([]);
    const lines = incomeCard(bundle.db, TODAY)!.pay;
    expect(lines.find((l) => l.seriesId === PAY)!.unattached.map((m) => m.row.id)).toEqual([only]);
    expect(lines.find((l) => l.seriesId === PAY2)!.unattached).toEqual([]);
  });
});
