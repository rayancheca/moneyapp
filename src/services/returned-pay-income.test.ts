import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFilters } from "@/components/transactions/query";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { cashFlowSegmentHref, ledgerHref } from "@/lib/ledger-href";
import { resolvePeriod } from "@/lib/period";
import { incomeByMonth, incomeTransactions } from "./analytics";
import { incomeExpectation } from "./budgets";
import { cashEarningsReadings } from "./cash-earnings";
import { incomeCard } from "./income-card";
import { paydaySettlement } from "./payday-settlement";
import { periodActivity } from "./period-activity";
import { spendingSankey } from "./sankey";
import { cashFlowByPeriod, dailySpendHeatmap, periodTotals } from "./spending";
import { matchingTransactionIds } from "./transactions-query";

/**
 * ⚖️ HIS DECISION 75 (2026-10-13), read by EVERY figure that says Income: a day whose rows linked to his pay net to
 * $0.00 banked nothing, and a day partly returned banked its net — so a figure of what came in counts his pay by the
 * DAY, as settlement spends it (`daysThatBanked`), and every one of them gives the same answer.
 *
 * 🔴 Only /budgets' "in so far" (and the dashboard's "Income recorded", which is it) had learned it, and only for a
 * return filed under Income: the Income card, Net, the cash-flow chart, the heatmap, the Sankey, the dashboard's
 * period panel and analytics' per-month split still summed `isIncome` row by row, so a payroll returned the same day
 * read $3,425.76 on /spending beside $2,283.84 in so far, and a return filed anywhere but Income was in no netting at
 * all (review of 54d77ad; hypothetical: every row linked to his pay is money in filed under Income, a copy of his
 * ledger 2026-10-13).
 *
 * The fixture is his series' shape — weekly Thursdays at $1,141.92 into Wells Fargo, Sep 3 and Sep 10 banked — read
 * on Monday Sep 21 with Wells Fargo checked through Sep 20.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-21";
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
const WELLS = "acct-wells";
const PAY = "series-it-america";
const WEEK = 114_192;
const now = (): string => new Date().toISOString();

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
const salary = (): string => categoryId("Salary", "Income");
const otherIncome = (): string => categoryId("Other Income", "Income");
/** a bank's own "transfer" filing — a transfer-kind category, in no figure of Income or Spent */
const internalTransfer = (): string => categoryId("Internal Transfer", "Transfers");

let seq = 0;
/**
 * A row linked to his pay — a deposit, or (negative) the money of one going back out — filed where it is filed; with
 * `series` null, a row linked to nothing.
 */
function payRow(
  postedOn: string,
  amountCents: number,
  filedAs: string | null = salary(),
  series: string | null = PAY,
): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: amountCents > 0 ? "It America LLC Payroll" : "Return It America LLC Payroll",
      normalizedDescription: amountCents > 0 ? "IT AMERICA LLC PAYROLL" : "RETURN IT AMERICA LLC PAYROLL",
      categoryId: filedAs,
      recurringSeriesId: series,
      seriesLinkSource: series === null ? null : "user",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-returned-pay-income-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "WELLS FARGO",
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
      id: PAY,
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: WEEK,
      userAmountCents: WEEK,
      nextExpectedOn: "2026-09-03",
      nextExpectedAmountCents: WEEK,
      lastMatchedOn: "2026-09-03",
      toleranceDays: 3,
      accountId: WELLS,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  for (let day = "2026-09-01"; day <= "2026-09-20"; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 100_000, basis: "derived" }).run();
  }
  payRow("2026-09-03", WEEK);
  payRow("2026-09-10", WEEK);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** Every figure that says Income for September, as each surface computes it. */
function incomeEverywhere(today = TODAY) {
  const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, today), today);
  const graph = spendingSankey(bundle.db, SEPT);
  return {
    budgetsInSoFar: incomeExpectation(bundle.db, SEPT.from, SEPT.to, today).postedCents,
    dashboardIncomeRecorded: incomeCard(bundle.db, today)!.postedThisMonthCents,
    spendingIncomeCard: periodTotals(bundle.db, SEPT).earnedCents,
    cashFlowTotal: flow.totals.earnedCents,
    cashFlowBars: sum(flow.buckets.map((b) => b.incomeCents)),
    heatmap: sum(dailySpendHeatmap(bundle.db, "2026-09").days.map((d) => d.incomeCents)),
    sankeySources: sum(graph.links.filter((l) => l.source.startsWith("inc:")).map((l) => l.valueCents)),
    incomeByMonth: sum(incomeByMonth(bundle.db, { months: 1, refDate: SEPT.to }).map((c) => c.incomeCents)),
    periodPanel: periodActivity(bundle.db, SEPT.from, SEPT.to, 10).summary.inCents,
  };
}
/** …and the one answer they must all give. */
function everywhere(cents: number): ReturnType<typeof incomeEverywhere> {
  return {
    budgetsInSoFar: cents,
    dashboardIncomeRecorded: cents,
    spendingIncomeCard: cents,
    cashFlowTotal: cents,
    cashFlowBars: cents,
    heatmap: cents,
    sankeySources: cents,
    incomeByMonth: cents,
    periodPanel: cents,
  };
}

/** What the bank netted in September — every row this fixture holds is his pay or its money going back. */
const bankNetted = (): number =>
  sum(bundle.db.select({ c: transactions.amountCents }).from(transactions).all().map((r) => r.c));

/** The rows a link opens, summed. */
function opened(href: string): number {
  const filters = parseFilters(Object.fromEntries(new URL(href, "http://ledger.test").searchParams));
  const ids = matchingTransactionIds(bundle.db, filters, "all");
  return sum(
    bundle.db
      .select({ c: transactions.amountCents })
      .from(transactions)
      .where(inArray(transactions.id, ids))
      .all()
      .map((r) => r.c),
  );
}

/**
 * The drill-down contract for every Income link: the Income card's, the Sankey's sources' and the cash-flow chart's
 * income segments' — each opens rows that sum to the figure printed over it.
 */
function incomeLinksAddUp(): void {
  expect(opened(ledgerHref({ category: "income", ...SEPT })), "the Income card").toBe(
    periodTotals(bundle.db, SEPT).earnedCents,
  );
  const graph = spendingSankey(bundle.db, SEPT);
  for (const node of graph.nodes.filter((n) => n.meta?.kind === "income")) {
    expect(opened(node.href!), `the Sankey's ${node.label}`).toBe(
      graph.links.find((l) => l.source === node.id)!.valueCents,
    );
  }
  const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, TODAY), TODAY);
  for (const s of flow.incomeSeries) {
    for (const b of flow.buckets) {
      const cents = b.income[s.key] ?? 0;
      const href = cashFlowSegmentHref(s.key, s.categoryId, { from: b.from, to: b.to }, "in");
      expect(opened(href), `the chart's ${s.label} on ${b.key}`).toBe(cents);
    }
  }
}

describe("⚖️ decision 75 on every Income figure — a payroll returned the same day banked nothing", () => {
  test("filed under Income: every figure counts Sep 3 and Sep 10, and Net is what the bank netted", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    expect(periodTotals(bundle.db, SEPT).netCents).toBe(bankNetted());
    // the heatmap draws no earned bar on a day that banked nothing
    expect(dailySpendHeatmap(bundle.db, "2026-09").days.find((d) => d.iso === "2026-09-17")?.incomeCents ?? 0).toBe(0);
    incomeLinksAddUp();
  });

  /*
   * 🔴 A return the bank files as a TRANSFER is in no figure of Income or Spent, so "in so far" — netting only rows
   * filed under Income — kept the deposit while settlement netted it: September read $3,425.76 in so far, $1,141.92
   * still expected and Sep 17's $1,141.92 passed against four paydays at $4,567.68 (review of 54d77ad).
   */
  test("filed as a transfer: the same — the day is read by every row linked to his pay that no other figure counts", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK, internalTransfer());
    expect(paydaySettlement(bundle.db, PAY, TODAY).portions.some((p) => p.paydayOn === "2026-09-17")).toBe(false);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    const e = incomeExpectation(bundle.db, SEPT.from, SEPT.to, TODAY);
    expect(e.postedCents - e.paidForAnotherMonthCents + e.expectedCents + e.passedUnpaidCents).toBe(e.scheduledCents);
    expect(periodTotals(bundle.db, SEPT).netCents).toBe(bankNetted());
    incomeLinksAddUp();
  });

  test("more money back than came in that day banks nothing — the day is $0.00 of Income, never less", () => {
    payRow("2026-09-17", 50_000);
    payRow("2026-09-17", -WEEK);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    incomeLinksAddUp();
  });
});

/*
 * A pay day's net is counted under ONE category — the one its largest row of his Income is filed in — on every surface
 * that splits Income by category, and its link opens the day there and nowhere else.
 */
describe("a pay day is counted under its largest row of his Income", () => {
  test("$641.92 under Salary and $500.00 under Other Income on Sep 17 are Salary's; Other Income keeps its own", () => {
    payRow("2026-09-05", 2_000, otherIncome(), null);
    payRow("2026-09-17", WEEK - 50_000);
    payRow("2026-09-17", 50_000, otherIncome());
    const graph = spendingSankey(bundle.db, SEPT);
    const sources = Object.fromEntries(
      graph.links
        .filter((l) => l.source.startsWith("inc:"))
        .map((l) => [graph.nodes.find((n) => n.id === l.source)!.label, l.valueCents]),
    );
    expect(sources).toEqual({ Salary: WEEK * 3, "Other Income": 2_000 });
    expect(incomeByMonth(bundle.db, { months: 1, refDate: SEPT.to }).map((c) => [c.categoryName, c.incomeCents])).toEqual(
      [
        ["Other Income", 2_000],
        ["Salary", WEEK * 3],
      ],
    );
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 3 + 2_000));
    incomeLinksAddUp();
  });
});

describe("⚖️ a partial return the same day: every Income figure counts the day's net", () => {
  test("$1,141.92 in and $500.00 back on Sep 17 is $641.92 of Income, on every surface and every link", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -50_000);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 3 - 50_000));
    expect(periodTotals(bundle.db, SEPT).netCents).toBe(bankNetted());
    const sep17 = dailySpendHeatmap(bundle.db, "2026-09").days.find((d) => d.iso === "2026-09-17")!;
    expect(sep17.incomeCents).toBe(WEEK - 50_000);
    // the per-month split counts the rows its figure stands for: three deposits and the money back — the rows its
    // sibling list (`incomeTransactions`) returns
    const [cell] = incomeByMonth(bundle.db, { months: 1, refDate: SEPT.to });
    expect([cell!.categoryName, cell!.txnCount]).toEqual(["Salary", 4]);
    const behind = incomeTransactions(bundle.db, { categoryId: cell!.categoryId, ...SEPT });
    expect([behind.length, sum(behind.map((r) => r.amountCents))]).toEqual([4, cell!.incomeCents]);
    incomeLinksAddUp();
  });
});

/*
 * ⚖️ ONE WEEK SENT AS TWO TRANSFERS, one of them unfiled: settlement pays Sep 17 in full with the day's $1,141.92, and
 * every Income figure counts the day it paid — the link to his pay says what the unfiled half is. 🔴 Only the $500.00
 * filed under Income was "in so far", beside a calendar that drew the week paid in full.
 */
describe("a day's money linked to his pay is his pay's, filed or not, when the day holds his pay", () => {
  test("$500.00 filed under Salary and $641.92 unfiled on Sep 17 are the week settlement paid", () => {
    payRow("2026-09-17", 50_000);
    payRow("2026-09-17", WEEK - 50_000, null);
    expect(paydaySettlement(bundle.db, PAY, TODAY).portions.filter((p) => p.paydayOn === "2026-09-17")).toEqual([
      { paydayOn: "2026-09-17", depositOn: "2026-09-17", cents: WEEK },
    ]);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 3));
    expect(periodTotals(bundle.db, SEPT).netCents).toBe(bankNetted());
    incomeLinksAddUp();
  });

  test("…but money linked to his pay on a day no row filed as his income holds is no Income — the queue owns it", () => {
    payRow("2026-09-17", WEEK, null);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    incomeLinksAddUp();
  });
});

/*
 * A RETURN ON A LATER DAY is no same-day return (decision 75): the payroll's own day banked $1,141.92 and paid Sep 17,
 * and the return's day nets below $0.00 and banks nothing — so every Income figure counts Sep 17, as settlement does,
 * and they still give one answer — Earned vs banked's banked figure and /spending's shortfall note too, which read the
 * same days (`daysThatBanked`). (Net does not take that return off — out of decision 75's reach.)
 * 🔴 Earned vs banked summed every row: it banked two weeks of September against the three Income counted, and the
 * note said $1,141.92 "never reached a bank" for Sep 17, a payday the calendar drew paid (review of d75).
 */
describe("a payroll returned on a LATER day is not a same-day return", () => {
  test("every Income figure counts Sep 17's payroll, as settlement pays it", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-18", -WEEK);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 3));
    incomeLinksAddUp();
  });

  test("…and so do Earned vs banked and /spending's note: three weeks banked, none short", () => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-18", -WEEK);
    const [reading] = cashEarningsReadings(bundle.db, { ...SEPT, today: TODAY, withChecked: true });
    const line = incomeCard(bundle.db, TODAY)!.pay.find((l) => l.seriesId === PAY)!;
    expect([reading!.bankedCents, reading!.shortfall!.shortCents, line.bankedCents]).toEqual([WEEK * 3, 0, WEEK * 3]);
  });
});

/*
 * ⚖️ ONE DEFINITION OF A PAY DAY'S ROWS (`isPayDayRow`): settlement and every Income figure read the same rows, so a
 * row linked to his pay that is his SPENDING — an unfiled debit, or one filed under a spending category — is in
 * neither. Netted out of Income as well as counted in Spent it would come off twice: Income $2,283.84, Spent $1,141.92,
 * Net $1,141.92 against the $2,283.84 the bank netted. ⚖️ Orchestrator's default (2026-10-14, his call open): an
 * unfiled debit beside its payroll is his Uncategorized spending until he files it — the day still banked, settlement
 * pays its payday, Income counts the deposit and Spent the debit; filed under Income or as a transfer it is his pay
 * going back, and the day nets (decision 75).
 * 🔴 Settlement read EVERY linked row: an unfiled $1,141.92 back beside Sep 17's payroll left Sep 17 unpaid — passed
 * on /budgets — while "in so far" counted the payroll: $3,425.76 + $1,141.92 still expected + $1,141.92 passed against
 * four paydays at $4,567.68 (review of f1903f6; hypothetical: no money out is linked to his pay).
 */
describe("ONE definition of a pay day's rows — settlement and every Income figure read the same day", () => {
  const bankFees = (): string => categoryId("Bank Fees", "Fees");
  const sep17Paid = (): boolean =>
    paydaySettlement(bundle.db, PAY, TODAY).portions.some((p) => p.paydayOn === "2026-09-17");
  /** /budgets' September legs — in so far − paid for another month + still expected + passed — and its schedule */
  function legs(): [number, number] {
    const e = incomeExpectation(bundle.db, SEPT.from, SEPT.to, TODAY);
    return [e.postedCents - e.paidForAnotherMonthCents + e.expectedCents + e.passedUnpaidCents, e.scheduledCents];
  }

  test.each([
    ["unfiled", (): string | null => null],
    ["filed under a spending category", bankFees],
  ])("%s, the week's pay back the same day is his spending: Sep 17 is paid, Income counts it", (_, filedAs) => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK, filedAs());
    expect(sep17Paid()).toBe(true);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 3));
    // …and Spent shows the debit, once: Net is what the bank netted
    const totals = periodTotals(bundle.db, SEPT);
    expect([totals.spentCents, totals.netCents]).toEqual([WEEK, bankNetted()]);
    expect(legs()).toEqual([WEEK * 4, WEEK * 4]);
    incomeLinksAddUp();
  });

  test.each([
    ["filed under Salary", salary],
    ["filed as a transfer", internalTransfer],
  ])("%s, it is his pay going back: Sep 17 banked nothing — unpaid, and in no Income figure", (_, filedAs) => {
    payRow("2026-09-17", WEEK);
    payRow("2026-09-17", -WEEK, filedAs());
    expect(sep17Paid()).toBe(false);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    const totals = periodTotals(bundle.db, SEPT);
    expect([totals.spentCents, totals.netCents]).toEqual([0, bankNetted()]);
    expect(legs()).toEqual([WEEK * 4, WEEK * 4]);
    incomeLinksAddUp();
  });

  /*
   * ⚖️ …and a DAY is a pay day only where one of its rows is filed as his pay — for settlement as for Income. Money
   * linked to his pay on a day with none — a credit left unfiled (detection's descriptor match links a row without
   * filing it) or one re-filed as a transfer, which keeps its link — is the review queue's or a transfer's: it pays no
   * payday, and no figure counts it as Income. 🔴 Settlement paid Sep 17 with it while every Income figure left it out
   * — "in so far" $2,283.84 + $1,141.92 still expected against four paydays at $4,567.68, Sep 17 in no leg (review of
   * 8fc0b01; hypothetical: every row linked to his pay is a credit filed under Income, a copy of his ledger 2026-10-13).
   */
  test.each([
    ["left unfiled", (): string | null => null],
    ["filed as a transfer", internalTransfer],
  ])("a credit %s alone on Sep 17 is no pay day: Sep 17 is unpaid, and in no Income figure", (_, filedAs) => {
    payRow("2026-09-17", WEEK, filedAs());
    expect(sep17Paid()).toBe(false);
    expect(incomeEverywhere()).toEqual(everywhere(WEEK * 2));
    expect(legs()).toEqual([WEEK * 4, WEEK * 4]);
    incomeLinksAddUp();
  });

  // a row filed as his pay either sign makes the day his pay's — and Income counts what settlement paid, under it
  test("a transfer's $1,141.92 with $500.00 back filed under Salary the same day reads as $641.92 of Salary", () => {
    payRow("2026-09-17", WEEK, internalTransfer());
    payRow("2026-09-17", -50_000);
    const day = { paid: sep17Paid(), income: incomeEverywhere(), legs: legs() };
    expect(day.income).toEqual(everywhere(WEEK * 3 - 50_000));
    incomeLinksAddUp();
    bundle.db.delete(transactions).where(eq(transactions.postedOn, "2026-09-17")).run();
    payRow("2026-09-17", WEEK - 50_000);
    expect(day).toEqual({ paid: sep17Paid(), income: incomeEverywhere(), legs: legs() });
  });
});
