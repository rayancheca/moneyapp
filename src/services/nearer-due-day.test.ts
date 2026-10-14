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
import { upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";

/**
 * ⚖️ His decision 76 (2026-10-14, his answer, refines 73): THE NEARER DUE DAY WINS — a payment between two due days
 * pays the one it lies nearer, a tie the earlier. It pays the later day early only when nothing paid that day on time;
 * otherwise it is the earlier day's, late — or pays nothing, if that day is already paid. On every grader of a bill's
 * day: the arrears (the runway's "came due … not posted", /budgets' "expected by now", the bill's "Already due"), the
 * calendar, and every reader that looks ahead (the forecast, Upcoming, the dashboard strip, "Next expected").
 *
 * 🔴 Measured on his ledger copy 2026-10-13: the Car lease, due the 15th (3 days' grace), posted Sep 2 −$695.04 — and
 * decision 73 read it as Aug 15's LATE payment (Aug 15 was unpaid, so it kept the payment), leaving Sep 15 unpaid; a
 * web pay around every 1st would read as the month before's, and the newest 15th "not posted" once Wells Fargo is read
 * past it. His lease is anchored on Oct 15 (his date), so no grader asks his Aug 15 or Sep 15 and nothing on his ledger
 * moves today; the fixtures anchor each bill where its days are graded.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const LEASE = "lease";
const FPL = "fpl";
const RENT = "rent";
const UTIL = "util";
const MEAL = "meal";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-nearer-due-day-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Checking",
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

/** one series and its own rows, as given — `[postedOn, cents]` */
function seriesWith(id: string, name: string, cents: number, anchor: string, ...rows: [string, number][]): void {
  bundle.db
    .insert(recurringSeries)
    .values({ ...bill(id, name, cents, anchor), lastMatchedOn: rows.at(-1)?.[0] ?? null })
    .run();
  for (const [postedOn, rowCents] of rows) pay(`t-${id}-${postedOn}`, id, postedOn, rowCents);
}

/** each series' marks on a day — `[series, state, paidWith]` */
const marks = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? []).map((e) => [e.seriesId, e.state, e.paidWith]);
/**
 * the series drawn UNPAID on a day — missed, or "?" where one or two postings prove no schedule yet
 * (`scheduleIsProven`): which state is the read's, not the payment's
 */
const unpaid = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? [])
    .filter((e) => e.paidWith === null && e.transactionId === null && (e.state === "missed" || e.state === "unsettled"))
    .map((e) => e.seriesId);
const owed = (today: string) =>
  arrearsThisMonth(bundle.db, new Set([LEASE, FPL, RENT, UTIL, MEAL]), today).series.map((s) => [
    s.id,
    s.nextDate,
    s.amountCents,
  ]);
const coming = (today: string, id: string) =>
  upcomingOccurrences(bundle.db, today, 60)
    .filter((o) => o.seriesId === id)
    .map((o) => o.date);

describe("the Car lease's Sep 2 −$695.04 pays Sep 15 — 13 days before it, 18 after Aug 15", () => {
  // anchored on Aug 15 so August and September are graded — his own date is Oct 15
  beforeEach(() => seriesWith(LEASE, "Car lease", -69504, "2026-08-15", ["2026-09-02", -69504]));

  test("September draws no Sep 15 mark — the Sep 2 row stands for it — and owes nothing in September", () => {
    checkedThrough(bundle.db, "acct", "2026-09-19");
    const september = recurringCalendar(bundle.db, "2026-09", "2026-09-20");
    expect(Object.keys(september.entriesByDay)).toEqual(["2026-09-02"]);
    expect(september.missedCount).toBe(0);
    expect(owed("2026-09-20")).toEqual([]);
  });

  test("…and Aug 15 is the month owed: August draws it missed, never paid by Sep 2", () => {
    checkedThrough(bundle.db, "acct", "2026-09-19");
    expect(unpaid("2026-08", "2026-08-15", "2026-09-20")).toEqual([LEASE]);
    expect(owed("2026-08-25")).toEqual([[LEASE, "2026-08-15", 69504]]);
  });

  test("an Oct 1 web pay — 16 days after Sep 15, 14 before Oct 15 — pays Oct 15: on Oct 13, not still to come", () => {
    pay("t-lease-oct", LEASE, "2026-10-01", -69504);
    // sixty days from Oct 13: Nov 15 alone — Oct 15 is paid
    expect(coming("2026-10-13", LEASE)).toEqual(["2026-11-15"]);
    expect(Object.keys(recurringCalendar(bundle.db, "2026-10", "2026-10-13").entriesByDay)).toEqual(["2026-10-01"]);
  });

  test("a payment past Sep 15's own grace window is Sep 15's, late — never Aug 15's, a whole gap behind it", () => {
    pay("t-lease-sep19", LEASE, "2026-09-19", -69504);
    checkedThrough(bundle.db, "acct", "2026-09-25");
    // Sep 2 still pays Sep 15 early, so Sep 19 — four days past it, past its 3 — pays nothing more
    expect(unpaid("2026-08", "2026-08-15", "2026-09-26")).toEqual([LEASE]);
    expect(owed("2026-09-26")).toEqual([]);
  });
});

describe("a payment past the next day's grace window never reaches back to the day before it", () => {
  beforeEach(() => seriesWith(LEASE, "Car lease", -69504, "2026-08-15", ["2026-09-19", -69504]));

  test("Sep 19 — Sep 15 + 4 — is Sep 15's, late; Aug 15 stays owed, Oct 15 still to come", () => {
    checkedThrough(bundle.db, "acct", "2026-09-25");
    expect(unpaid("2026-08", "2026-08-15", "2026-09-26")).toEqual([LEASE]);
    expect(Object.keys(recurringCalendar(bundle.db, "2026-09", "2026-09-26").entriesByDay)).toEqual(["2026-09-19"]);
    expect(owed("2026-09-26")).toEqual([]);
    expect(coming("2026-09-26", LEASE)[0]).toBe("2026-10-15");
  });
});

describe("FPL, due the 8th — Jul 10 pays Jul 8 on time, Jul 28 (11 days before Aug 8) pays Aug 8 early", () => {
  beforeEach(() =>
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-10", -1421], ["2026-07-28", -5622]),
  );

  test("July draws its two rows and no Jul 8 mark; August draws Aug 8 paid early by Jul 28; nothing owed", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(Object.keys(recurringCalendar(bundle.db, "2026-07", "2026-08-20").entriesByDay).sort()).toEqual([
      "2026-07-10",
      "2026-07-28",
    ]);
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
    expect(owed("2026-08-20")).toEqual([]);
  });
});

describe("FPL with ONLY Jul 28 — nearer Aug 8, it pays Aug 8 even with Jul 8 unpaid (the cost he accepted)", () => {
  beforeEach(() => seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-28", -5622]));

  test("July draws Jul 8 missed beside the Jul 28 row, and owes its $58.87", () => {
    checkedThrough(bundle.db, "acct", "2026-07-29");
    expect(unpaid("2026-07", "2026-07-08", "2026-07-30")).toEqual([FPL]);
    expect(owed("2026-07-30")).toEqual([[FPL, "2026-07-08", 5887]]);
  });

  test("August draws Aug 8 paid early by Jul 28, and owes nothing — one month owed either way", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
    expect(owed("2026-08-20")).toEqual([]);
  });
});

describe("nearer a day already paid ON TIME by another payment: the other day, if that one is unpaid", () => {
  test("FPL's Jul 28 with Aug 8 paid on Aug 8 — it pays Jul 8, late: July owes nothing", () => {
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-28", -5622], ["2026-08-08", -5887]);
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(marks("2026-07", "2026-07-08", "2026-08-20")).toEqual([]);
    expect(owed("2026-07-30")).toEqual([]);
    expect(owed("2026-08-20")).toEqual([]);
  });

  test("…and with Jul 8 paid too (Jul 10), Jul 28 pays nothing: one payment, one due day", () => {
    seriesWith(
      FPL,
      "FPL (electricity)",
      -5887,
      "2026-07-08",
      ["2026-07-10", -1421],
      ["2026-07-28", -5622],
      ["2026-08-08", -5887],
    );
    checkedThrough(bundle.db, "acct", "2026-09-12");
    // Sep 8 is not paid early by it: Jul 28 is in no gap of Sep 8's
    expect(unpaid("2026-09", "2026-09-08", "2026-09-13")).toEqual([FPL]);
  });

  /*
   * ⚖️ The split October (measured on a what-if copy of his ledger with these two rows, read Oct 13): Oct 9 lies nearer
   * Oct 1, which Oct 1's $2,000.00 paid on time — so it pays NOTHING, and Nov 1 is still coming. 🔴 Under decision 73
   * Oct 9 paid Nov 1 early (Oct 1 was paid by then, and Oct 9 is more than 3 days before Nov 1): Nov 1 left Upcoming
   * and the November forecast lost its −$2,109.00 rent.
   */
  test("a rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 leaves Nov 1 coming — the rent's and what it carries", () => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-09-01"), lastMatchedOn: "2026-10-09" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-09-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    pay("t-rent-sep", RENT, "2026-09-02", -229121);
    pay("t-rent-oct1", RENT, "2026-10-01", -200000);
    pay("t-rent-oct9", RENT, "2026-10-09", -29121);
    const TODAY = "2026-10-13";
    expect(coming(TODAY, RENT)).toEqual(["2026-11-01", "2026-12-01"]);
    expect(coming(TODAY, UTIL)).toEqual(["2026-11-01", "2026-12-01"]);
    expect(forecastForMonth(bundle.db, "2026-11", TODAY)!.components.map((c) => c.label)).toContain(
      "Flamingo South Beach (rent)",
    );
    expect(owed(TODAY)).toEqual([]);
  });
});

/*
 * ⚖️ A tie is the earlier day's (decision 76). His rent posted Jun 16 — two rows, one payment (`occurrencesOf`) —
 * exactly 15 days after Jun 1 and 15 before Jul 1: June's, late.
 */
describe("an exact tie pays the earlier day — his Jun 16 rent, 15 days either side", () => {
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-06-01"), lastMatchedOn: "2026-06-16" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-06-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
  });

  test("Jun 16 pays Jun 1 (June draws no Jun 1 mark), and Jul 1 is owed — not paid early by it", () => {
    pay("t-rent-jun16a", RENT, "2026-06-16", -100000);
    pay("t-rent-jun16b", RENT, "2026-06-16", -129121);
    checkedThrough(bundle.db, "acct", "2026-07-19");
    expect(marks("2026-06", "2026-06-01", "2026-07-20")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-06-16", early: false }],
    ]);
    expect(unpaid("2026-07", "2026-07-01", "2026-07-20")).toEqual([RENT, UTIL]);
    expect(owed("2026-07-20")).toEqual([
      [RENT, "2026-07-01", 210900],
      [UTIL, "2026-07-01", 18221],
    ]);
  });

  test("a day later is nearer Jul 1: Jun 17 pays Jul 1 early, and Jun 1 is the month owed", () => {
    pay("t-rent-jun17", RENT, "2026-06-17", -229121);
    checkedThrough(bundle.db, "acct", "2026-07-19");
    expect(marks("2026-07", "2026-07-01", "2026-07-20")).toEqual([
      [RENT, "paid", { carrier: null, postedOn: "2026-06-17", early: true }],
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-06-17", early: true }],
    ]);
    expect(owed("2026-07-20")).toEqual([]);
    expect(owed("2026-06-20")).toEqual([
      [RENT, "2026-06-01", 210900],
      [UTIL, "2026-06-01", 18221],
    ]);
  });
});

/*
 * ⚖️ What is billed inside the rent is paid by the rent's payments, by the rent's own test (§6A 59) — unaffected: his
 * rent posted Jul 8, Aug 4 and Sep 2, each its own month's (Jul 8 a week late, nearer Jul 1 than Aug 1).
 */
describe("the utilities carried by the rent are paid with each month's rent payment, as before", () => {
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

  test("Jul 1 late by Jul 8, Aug 1 by Aug 4, Sep 1 by Sep 2 — none early, nothing owed, Oct 1 still to come", () => {
    const TODAY = "2026-09-20";
    checkedThrough(bundle.db, "acct", "2026-09-19");
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
    expect(coming(TODAY, RENT)[0]).toBe("2026-10-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-10-01");
  });
});

/*
 * The e2e fixture's Meal Kit: $125.00 due the 5th on Chase Freedom Unlimited, nothing ever posted under it — the
 * fixture's real miss. Nothing near it may pay it.
 */
describe("the e2e Meal Kit's real miss is still a miss", () => {
  test("no payment: Jul 5 owes its $125.00, and once read through its grace it is drawn missed", () => {
    seriesWith(MEAL, "Meal Kit", -12500, "2026-07-05");
    checkedThrough(bundle.db, "acct", "2026-07-08");
    expect(owed("2026-07-09")).toEqual([[MEAL, "2026-07-05", 12500]]);
    expect(marks("2026-07", "2026-07-05", "2026-07-09")).toEqual([[MEAL, "missed", null]]);
  });

  test("…and June's on-time payment and a second June row nearer Jun 5 pay no Jul 5 — still a miss", () => {
    seriesWith(MEAL, "Meal Kit", -12500, "2026-06-05", ["2026-06-05", -12500], ["2026-06-12", -1999]);
    checkedThrough(bundle.db, "acct", "2026-07-08");
    expect(owed("2026-07-09")).toEqual([[MEAL, "2026-07-05", 12500]]);
    expect(unpaid("2026-07", "2026-07-05", "2026-07-09")).toEqual([MEAL]);
  });
});
