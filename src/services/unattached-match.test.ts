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
import { alreadyDueWords } from "@/components/recurring/labels";
import { arrearsClause, NOT_POSTED, overdueReading } from "@/lib/arrears-reading";
import { arrearsSentence } from "@/lib/committed";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { passedPaydaysWords } from "@/lib/unbanked-income";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings } from "./cash-earnings";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { incomeCard } from "./income-card";
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

  test("three of four rows: the fourth payday is still the one that did not reach a bank", () => {
    importUnattached(PAYDAYS.slice(0, 3), false);
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toContain(
      "— 3 of them are matched to the cent by rows of $1,141.92 on Oct 1, Oct 8, and Oct 15 that are not attached to " +
        "it, and for the other 1 the pay did not reach a bank",
    );
  });
});
