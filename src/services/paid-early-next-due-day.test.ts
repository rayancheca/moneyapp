import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsThisMonth } from "./arrears";
import { checkedThrough } from "./checked-days-fixture";
import { forecastForMonth } from "./forecast";
import { listSeries, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 73 (2026-10-13, either/or, recommended): a payment that posts MORE than its grace days EARLY PAYS THE
 * NEXT DUE DAY EARLY — when it lies nearer that day than the one before (his decision 76, 2026-10-14, which replaced
 * 73's "once the day before is paid by another"; `nearer-due-day.test.ts`) — on every grader of a bill's day: the
 * arrears (the runway's "came due … not posted", /budgets' "expected by now", the bill's "Already due"), the calendar,
 * and every reader that looks ahead (the forecast, Upcoming, the dashboard strip, the bill's "Next expected").
 *
 * 🔴 Measured on his ledger copy 2026-10-13: FPL (electricity), due the 8th (his number, 3 days' grace), on Chase
 * Checking — Jul 10 −$14.21 (Jul 8's, on time) and Jul 28 −$56.22, 11 days before Aug 8. Jul 28 paid no due day. Those
 * two are every FPL posting on his ledger (his copy, 2026-10-21): a bill drafted around every 28th (a what-if, below)
 * would have read each statement's newest 8th "not posted" until the following one. His FPL is anchored on Sep 8 (his
 * date, still so on his copy 2026-10-21), so no grader asks his Aug 8 and nothing on his ledger moves today; the
 * fixture anchors it on Jul 8, detection's way, so July and August are graded.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const FPL = "fpl";
const RENT = "rent";
const UTIL = "util";
const now = (): string => new Date().toISOString();

function pay(id: string, seriesId: string, postedOn: string, cents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: "acct",
      postedOn,
      amountCents: cents,
      rawDescription: id,
      normalizedDescription: id.toUpperCase(),
      categoryId,
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

const bill = (id: string, name: string, cents: number, nextOn: string) => ({
  id,
  name,
  kind: "bill" as const,
  cadence: "monthly" as const,
  intervalDaysAvg: 30,
  amountCentsAvg: cents,
  toleranceDays: 3,
  nextExpectedOn: nextOn,
  nextExpectedAmountCents: cents,
  userAmountCents: cents,
  anchorDay: Number(nextOn.slice(8)),
  accountId: "acct",
  status: "confirmed" as const,
  userCategoryId: categoryId,
  createdAt: now(),
  updatedAt: now(),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-paid-early-next-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Chase Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all().find((c) => c.kind === "expense" && c.parentId === null)!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** FPL's shape: due the 8th, 3 days' grace, $58.87 — its rows as given */
function fplWith(...rows: [string, number][]): void {
  bundle.db
    .insert(recurringSeries)
    .values({ ...bill(FPL, "FPL (electricity)", -5887, "2026-07-08"), lastMatchedOn: rows.at(-1)![0] })
    .run();
  for (const [postedOn, cents] of rows) pay(`t-fpl-${postedOn}`, FPL, postedOn, cents);
}

/** each series' marks on a day — `[series, state, paidWith]` */
const marks = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? []).map((e) => [e.seriesId, e.state, e.paidWith]);
const owed = (today: string) =>
  arrearsThisMonth(bundle.db, new Set([FPL, RENT, UTIL]), today).series.map((s) => [s.id, s.nextDate, s.amountCents]);

describe("FPL's Jul 28 −$56.22 pays Aug 8 early — nearer it than Jul 8, which Jul 10 paid", () => {
  beforeEach(() => fplWith(["2026-07-10", -1421], ["2026-07-28", -5622]));

  test("August draws Aug 8 paid, naming the payment of Jul 28 — early — and settling $0.00 there", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
    const august = recurringCalendar(bundle.db, "2026-08", "2026-08-20");
    expect([august.missedCount, august.unsettledCount, august.postedNetCents]).toEqual([0, 0, 0]);
  });

  test("July draws the two rows where they posted, and no Jul 8 mark — the Jul 10 row stands for it", () => {
    const july = recurringCalendar(bundle.db, "2026-07", "2026-08-20");
    expect(Object.keys(july.entriesByDay).sort()).toEqual(["2026-07-10", "2026-07-28"]);
    expect(july.postedNetCents).toBe(-1421 - 5622);
  });

  test("the arrears owe no Aug 8 — the runway, /budgets and the bill's page say nothing came due unpaid", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(owed("2026-08-20")).toEqual([]);
  });

  test("read on Aug 1, nothing looks ahead to Aug 8: the forecast, Upcoming and the bill's page start at Sep 8", () => {
    const TODAY = "2026-08-01";
    expect(upcomingOccurrences(bundle.db, TODAY, 45).filter((o) => o.seriesId === FPL).map((o) => o.date)).toEqual([
      "2026-09-08",
    ]);
    expect(seriesDetail(bundle.db, FPL, TODAY).nextExpected.map((o) => o.date)).toEqual([
      "2026-09-08",
      "2026-10-08",
      "2026-11-08",
    ]);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === FPL)?.nextExpectedOn).toBe("2026-09-08");
    expect(forecastForMonth(bundle.db, "2026-08", TODAY)!.components.map((c) => c.label)).not.toContain(
      "FPL (electricity)",
    );
    // …and the grid agrees: Aug 8 is paid, not upcoming
    expect(marks("2026-08", "2026-08-08", TODAY)).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
  });
});

// A what-if: his FPL has posted only Jul 10 and Jul 28 — the Aug 28 and Sep 28 drafts and their amounts are made up
describe("a what-if drafted every 28th: each draft pays the next 8th — the newest 8th by the newest draft", () => {
  beforeEach(() =>
    fplWith(["2026-07-10", -1421], ["2026-07-28", -5622], ["2026-08-28", -5887], ["2026-09-28", -6012]),
  );

  test("September draws Sep 8 paid early by Aug 28, October Oct 8 by Sep 28 — and the arrears owe neither", () => {
    checkedThrough(bundle.db, "acct", "2026-10-12");
    expect(marks("2026-09", "2026-09-08", "2026-10-13")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-08-28", early: true }],
    ]);
    expect(marks("2026-10", "2026-10-08", "2026-10-13")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-09-28", early: true }],
    ]);
    expect(recurringCalendar(bundle.db, "2026-10", "2026-10-13").missedCount).toBe(0);
    expect(owed("2026-10-13")).toEqual([]);
  });
});

/*
 * ⚖️ …nearer Aug 8 it pays Aug 8 even with the day before UNPAID — his decision 76 (2026-10-14), the cost he accepted:
 * one month owed either way. 🔴 Under decision 73 the late rule kept it for Jul 8 and Aug 8 was owed.
 */
describe("the day before UNPAID — Jul 28, nearer Aug 8, pays it, and Jul 8 is the month owed (decision 76)", () => {
  beforeEach(() => fplWith(["2026-07-28", -5622]));

  test("July draws a Jul 8 mark beside the Jul 28 row, and August draws Aug 8 paid early by it", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(Object.keys(recurringCalendar(bundle.db, "2026-07", "2026-08-20").entriesByDay).sort()).toEqual([
      "2026-07-08",
      "2026-07-28",
    ]);
    expect(owed("2026-08-20")).toEqual([]);
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
  });
});

/*
 * ⚖️ What is billed inside the rent is paid by the rent's payments, by the rent's own test (§6A 59) — the same walk
 * over the same postings, so the pair cannot part over an early payment either. His rent: $2,109.00 on the 1st, 3 days'
 * grace, posted Jul 8, Aug 4 and Sep 2 (anchored Jul 1 here so July is graded); the utilities never post.
 */
describe("the carrier path: the utilities paid with the rent's payments, as before — and early with an early one", () => {
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-07-01"), lastMatchedOn: "2026-09-02" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-07-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    pay("t-rent-jul", RENT, "2026-07-08", -228570);
    pay("t-rent-aug", RENT, "2026-08-04", -223711);
    pay("t-rent-sep", RENT, "2026-09-02", -229121);
  });

  test("his rent's own days: Jul 1 late by Jul 8, Aug 1 by Aug 4, Sep 1 by Sep 2 — none of them early", () => {
    const TODAY = "2026-09-20";
    expect(marks("2026-07", "2026-07-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-07-08", early: false }],
    ]);
    expect(marks("2026-08", "2026-08-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-08-04", early: false }],
    ]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-02", early: false }],
    ]);
    expect(owed(TODAY)).toEqual([]);
  });

  test("a rent paid Sep 20 — nearer Oct 1 than Sep 1 — pays Oct 1 early, and what it carries with it", () => {
    pay("t-rent-early", RENT, "2026-09-20", -229121);
    const TODAY = "2026-10-09";
    checkedThrough(bundle.db, "acct", "2026-10-08");
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [RENT, "paid", { carrier: null, postedOn: "2026-09-20", early: true }],
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-20", early: true }],
    ]);
    expect(owed(TODAY)).toEqual([]);
  });
});
