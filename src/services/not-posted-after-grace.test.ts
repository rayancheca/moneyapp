import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsAlarms, overdueReading } from "@/lib/arrears-reading";
import { arrearsReadingOf, arrearsSentence } from "@/lib/committed";
import { formatCents } from "@/lib/money";
import { alreadyDueWords } from "@/components/recurring/labels";
import { seriesEndInput, seriesEndLines } from "@/components/recurring/end-radius";
import { arrearsThisMonth } from "./arrears";
import { budgetPaceStatuses, createBudget } from "./budgets";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 60 (2026-10-08): a bill reads "not posted" (warning) — and the calendar's red ✕ — only once
 * statements cover the due day PLUS the bill's tolerance, the grace days a payment may still post on; until then "no
 * statement has covered it yet" (his decision 65, 2026-10-12), quiet. ONE rule on the calendar (`settledVerdict`), the
 * bill's page, the runway, /budgets, the End dialog and the forecast's arrears line.
 *
 * 🔴 "Read" meant the due day itself. The e2e fixture's Meal Kit — due Jul 5, its card imported through Jul 5 — drew
 * a red ✕ "missed", "Already due, and not posted" in warning colour and "$125.00 never posted" on the runway, while a
 * payment on Jul 6, 7 or 8 would still have paid it: days no import had reached.
 *
 * The fixture is his shape: the rent ($2,109.00 on the 1st, 3 days' grace, posted Jul 8, Aug 4 and Sep 2 — measured
 * on his ledger) on one checking account, and `Rent utilities & fees` ($182.21) billed with it (§6A 59), read on the
 * rent's accounts. Today is Oct 8; the rent has not posted for October.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const TODAY = "2026-10-08";
const RENT = "rent";
const UTIL = "util";

const now = () => new Date().toISOString();

function row(id: string, postedOn: string, cents: number, seriesId: string | null, description: string) {
  return {
    id,
    accountId: "acct",
    postedOn,
    amountCents: cents,
    rawDescription: description,
    normalizedDescription: description,
    categoryId,
    recurringSeriesId: seriesId,
    status: "active" as const,
    needsReview: false,
    occurrenceIndex: 0,
    dedupeHash: `h-${id}`,
    createdAt: now(),
    updatedAt: now(),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-not-posted-after-grace-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId,
      name: "Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all().find((c) => c.kind === "expense" && c.parentId === null)!.id;
  const series = (id: string, name: string, cents: number, lastMatchedOn: string | null) => ({
    id,
    name,
    kind: "bill" as const,
    cadence: "monthly" as const,
    intervalDaysAvg: 30,
    amountCentsAvg: cents,
    toleranceDays: 3,
    nextExpectedOn: "2026-10-01",
    nextExpectedAmountCents: cents,
    userAmountCents: cents,
    anchorDay: 1,
    status: "confirmed" as const,
    lastMatchedOn,
    userCategoryId: categoryId,
    createdAt: now(),
    updatedAt: now(),
  });
  bundle.db
    .insert(recurringSeries)
    .values([
      { ...series(RENT, "Flamingo South Beach (rent)", -210900, "2026-09-02"), accountId: "acct" },
      { ...series(UTIL, "Rent utilities & fees", -18221, null), userBilledWithSeriesId: RENT },
    ])
    .run();
  // his three rent payments: enough charges to hold the rent to its date (`scheduleIsProven`)
  bundle.db
    .insert(transactions)
    .values([
      row("t-jul", "2026-07-08", -228570, RENT, "FLAMINGO SOUTH BEACH"),
      row("t-aug", "2026-08-04", -228570, RENT, "FLAMINGO SOUTH BEACH"),
      row("t-sep", "2026-09-02", -229121, RENT, "FLAMINGO SOUTH BEACH"),
    ])
    .run();
  createBudget(bundle.db, { categoryId, period: "monthly", amountCents: 300_000, startsOn: "2026-10-01" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * An import of the checking account has reached `day` — a row of no series on it (`observationFrontier`) and its
 * balances checked through it (`checkedThrough`): the chip's day, which the ✕ reads (his decision 62, 2026-10-12).
 */
function importedThrough(day: string): void {
  bundle.db.insert(transactions).values(row(`t-coffee-${day}`, day, -450, null, "COFFEE")).run();
  checkedThrough(bundle.db, "acct", day);
}

/** What every surface that says a bill came due says of these series' Oct 1, at TODAY. */
function surfaces(ids: readonly string[] = [RENT, UTIL], [dueOn, dueWord] = ["2026-10-01", "Oct 1"]) {
  const calendar = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay[dueOn] ?? [];
  const book = committedBook(bundle.db, TODAY);
  const components = forecastCurrentMonth(bundle.db, TODAY).components;
  return {
    calendar: ids.map((id) => {
      const e = calendar.find((c) => c.seriesId === id)!;
      return [e.state, e.unsettledReason];
    }),
    card: ids.map((id) => {
      const d = seriesDetail(bundle.db, id, TODAY);
      // the page's own reading and grace (`overdue.graceDays`, `carriedGrace`), as `AlreadyDueCard` passes them
      const w = alreadyDueWords(
        overdueReading(d.overdue!),
        d.overdue!.graceDays,
        d.overdue!.occurrenceCount,
        d.overdue!.carriedGrace,
      );
      return [w.heading, w.warning];
    }),
    endDialog: ids.map(
      (id) =>
        seriesEndLines(seriesEndInput(seriesDetail(bundle.db, id, TODAY)), formatCents).find((l) =>
          l.label.startsWith("Already due"),
        )!.label,
    ),
    runway: [arrearsSentence(book), arrearsAlarms(arrearsReadingOf(book))],
    budgets: budgetPaceStatuses(bundle.db, TODAY).map((s) => [
      s.overdueCents,
      s.overdueUnreadCents,
      s.overdueInGraceCents,
    ]),
    forecast: ids.map((id) => {
      const name = id === RENT ? "Flamingo South Beach (rent)" : "Rent utilities & fees";
      const detail = components.find((c) => c.label === name)!.detail ?? "";
      return new RegExp(`came due ${dueWord}(.*)$`).exec(detail)![1];
    }),
  };
}

const QUIET = {
  calendar: [
    ["unsettled", "not_imported"],
    ["unsettled", "not_imported"],
  ],
  card: [
    ["Already due — no statement has covered it yet", false],
    ["Already due — no statement has covered it yet", false],
  ],
  endDialog: [
    "Already due this month, no statement has covered it yet",
    "Already due this month, no statement has covered it yet",
  ],
  runway: ["A further $2,291.21 came due earlier this month and no statement has covered it yet.", false],
  budgets: [[229121, 229121, 0]],
  forecast: [" and no statement has covered it yet", " and no statement has covered it yet"],
};

const NOT_POSTED = {
  calendar: [
    ["missed", null],
    ["missed", null],
  ],
  card: [
    ["Already due, and not posted", true],
    ["Already due, and not posted", true],
  ],
  endDialog: ["Already due this month, not posted", "Already due this month, not posted"],
  runway: ["A further $2,291.21 came due earlier this month and has not posted.", true],
  budgets: [[229121, 0, 0]],
  forecast: [" and has not posted", " and has not posted"],
};

describe("a due day is read once its accounts are imported through the due day + its grace (§6A 60)", () => {
  test("nothing imported past his Sep 2 payment: every surface is quiet", () => {
    expect(surfaces()).toEqual(QUIET);
  });

  /*
   * THE BOUNDARY. Oct 1 + 3 days' grace is Oct 4: a payment on Oct 2, 3 or 4 still pays the rent's Oct 1, so an
   * import that has reached only Oct 3 cannot vouch that none came.
   */
  test("imported through Oct 3 — due + grace − 1 — every surface still says no statement has covered it yet", () => {
    importedThrough("2026-10-03");
    expect(surfaces()).toEqual(QUIET);
  });

  test("imported through Oct 4 — due + grace — with no rent posting, every surface says not posted, in warning", () => {
    importedThrough("2026-10-04");
    expect(surfaces()).toEqual(NOT_POSTED);
  });

  test("imported through the due day itself, Oct 1, is quiet — the old boundary drew a ✕ over days unread", () => {
    importedThrough("2026-10-01");
    expect(surfaces()).toEqual(QUIET);
  });

  test("a rent payment inside its grace pays both, read or not: owed on no surface", () => {
    bundle.db.insert(transactions).values(row("t-oct", "2026-10-04", -229121, RENT, "FLAMINGO SOUTH BEACH")).run();
    importedThrough("2026-10-07");
    expect(arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series).toEqual([]);
    expect(recurringCalendar(bundle.db, "2026-10", TODAY).missedCount).toBe(0);
  });
});

describe("the grace is the bill's — and, for one billed with the rent, the rent payment's", () => {
  /*
   * ⚖️ What is billed inside the rent is paid by the rent's payment within the RENT's grace (`carrierPaymentsBySeries`,
   * §6A 59), so its day is read when that payment's last day is: never on a shorter grace of its own, or its Oct 1
   * would say "not posted" beside a rent still quiet — one payment, two answers.
   */
  test("a rent with 5 days' grace holds what it carries to Oct 6, though its own grace is 3", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, RENT)).run();
    importedThrough("2026-10-05");
    expect(surfaces().calendar).toEqual(QUIET.calendar);
    expect(surfaces().card).toEqual(QUIET.card);
    importedThrough("2026-10-06");
    expect(surfaces().calendar).toEqual(NOT_POSTED.calendar);
    expect(surfaces().card).toEqual(NOT_POSTED.card);
    // …and the utilities' own page names the grace its day waited for — the rent's 5, never its own 3 beside a rule
    // that waited for 5 (`seriesDetail.overdue.graceDays`, the card's words) — and the window each payment had: a
    // posting of their own within their 3, a rent payment within the rent's 5 (`carriedGrace`)
    const utilities = seriesDetail(bundle.db, UTIL, TODAY).overdue!;
    expect(utilities.graceDays).toBe(5);
    const words = alreadyDueWords(
      overdueReading(utilities),
      utilities.graceDays,
      utilities.occurrenceCount,
      utilities.carriedGrace,
    );
    expect(words.body).toContain(
      "the statements reach 5 days past it with no posting of its own within 3 days of it, and none of the rent's " +
        "payments within 5 days of it",
    );
  });

  /*
   * ⚖️ …and the rent's grace stays the rent's: his decision 60 (2026-10-08) reads "not posted" once statements cover
   * the due day plus THE BILL's tolerance, and only the rent's own payments pay the rent (`paymentFor`). What it
   * carries waits for every payment that may pay IT — a payment of its own within its own 5 days, too — so the pair can
   * split one way only: the rent not posted beside the utilities quiet, while a payment of theirs may still post.
   *
   * 🔴 One grace for the pair (5557162, review of the 2026-10-12 batch): the rent waited for the widest grace among what
   * it carries, so its Oct 1 stayed quiet past its own days — "no import reaches 5 days past it yet … so it may well
   * have posted", of a rent no posting after Oct 4 could pay on time — and with an annual item carried, every rent day
   * of the year waited 14 (below).
   *
   * ⚠️ NOT HIS ANSWER YET. Item (2) of the 2026-10-12 queue asked for the pair to answer on ONE day; this pins the other
   * reading — each on its own grace — which his decisions 60 and 62 imply but do not choose between. Which of the two
   * is his call, put to him 2026-10-13; latent on his ledger copy 2026-10-12, where both have 3 days.
   */
  test("what the rent carries, with 5 days' grace of its own, waits to Oct 6 — the rent is not posted on Oct 4", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, UTIL)).run();
    importedThrough("2026-10-04");
    expect(surfaces()).toEqual({
      calendar: [NOT_POSTED.calendar[0], QUIET.calendar[1]],
      card: [NOT_POSTED.card[0], QUIET.card[1]],
      endDialog: [NOT_POSTED.endDialog[0], QUIET.endDialog[1]],
      runway: [
        "A further $2,291.21 came due earlier this month: $2,109.00 has not posted, and no statement has covered the " +
          "other $182.21 yet.",
        true,
      ],
      budgets: [[229121, 18221, 0]],
      forecast: [NOT_POSTED.forecast[0], QUIET.forecast[1]],
    });
    importedThrough("2026-10-06");
    expect(surfaces()).toEqual(NOT_POSTED);
    // …each page naming the grace its own day waited for: the rent's 3, the utilities' own 5
    expect([RENT, UTIL].map((id) => seriesDetail(bundle.db, id, TODAY).overdue!.graceDays)).toEqual([3, 5]);
  });

  /*
   * 🔴 …and its page claimed a window its payments are not judged by (review of 5557162): with the utilities' 5 days
   * lent to it, a rent paid four days off Oct 1 read "Already due, and not posted … the imports, which reach 5 days past
   * it, hold no posting within 5 days of it" beside its own row. That row was Oct 5, which now pays Oct 1 late (below);
   * and Sep 27, four days EARLY — nearer Oct 1 than Sep 1 — pays it early (⚖️ his decision 76, 2026-10-14): a row four
   * days off its day pays it. So the page names its own 3 days where nothing has — and Sep 27 is early by those 3,
   * never on time by the 5 lent.
   */
  test("a rent not posted says so within its own 3 days — not 5; paid four days early, Oct 1 is paid EARLY", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, UTIL)).run();
    importedThrough("2026-10-07");
    const unpaid = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-01"]!;
    expect(unpaid.find((e) => e.seriesId === RENT)!.state).toBe("missed");
    const rent = seriesDetail(bundle.db, RENT, TODAY).overdue!;
    expect(
      alreadyDueWords(overdueReading(rent), rent.graceDays, rent.occurrenceCount, rent.carriedGrace).body,
    ).toContain(
      "the statements reach 3 days past it with no posting within 3 days of it",
    );
    bundle.db.insert(transactions).values(row("t-sep27", "2026-09-27", -229121, RENT, "FLAMINGO SOUTH BEACH")).run();
    const october = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay;
    expect(october["2026-10-01"]!.map((e) => [e.seriesId, e.state, e.paidWith])).toEqual([
      [RENT, "paid", { carrier: null, postedOn: "2026-09-27", early: true }],
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-27", early: true }],
    ]);
    expect(arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series).toEqual([]);
  });

  /*
   * 🔴 THE MIRROR, ON WHAT IT CARRIES (review of 44eb3e7): with the rent's 5 days lent to the utilities, whose own are
   * 3, a posting of their own four days off Oct 1 paid them nothing — and their page read "the imports, which reach 5
   * days past it, hold no posting within 5 days of it" beside it. A bill billed inside another's payment is paid within
   * two windows, each payment by its own series' tolerance (`paymentFor`): its page names each (above, where nothing
   * pays them). ⚖️ Four days early, nearer Oct 1 than Sep 1, their own Sep 27 pays their Oct 1 early (his decision 76,
   * 2026-10-14) — early by their own 3, never on time by the rent's 5 — and pays the rent nothing.
   */
  test("what the rent carries, paid on its own four days early: Oct 1 EARLY by its own 3 — the rent's owed", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, RENT)).run();
    bundle.db.insert(transactions).values(row("t-u-sep27", "2026-09-27", -18221, UTIL, "FLAMINGO UTILITIES")).run();
    bundle.db.update(recurringSeries).set({ lastMatchedOn: "2026-09-27" }).where(eq(recurringSeries.id, UTIL)).run();
    importedThrough("2026-10-06");
    const october = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay;
    expect(october["2026-10-01"]!.map((e) => [e.seriesId, e.state, e.paidWith])).toEqual([
      [RENT, "missed", null],
      [UTIL, "paid", { carrier: null, postedOn: "2026-09-27", early: true }],
    ]);
    expect(arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series.map((s) => s.id)).toEqual([RENT]);
    // …and the rent's own page, paid by its own payments alone, names its one window
    const rent = seriesDetail(bundle.db, RENT, TODAY).overdue!;
    expect(
      alreadyDueWords(overdueReading(rent), rent.graceDays, rent.occurrenceCount, rent.carriedGrace).body,
    ).toContain(
      "with no posting within 5 days of it.",
    );
  });

  /*
   * 🔴 A RENT PAID PAST ITS GRACE WAS COUNTED TWICE (review of 44eb3e7): paid Oct 5 — four days after Oct 1, past its
   * 3 — it paid no due day, so October drew Oct 1 a red ✕ for the rent and its utilities beside the Oct 5 row, the
   * runway read "A further $2,291.21 came due earlier this month and never posted.", the forecast "came due Oct 1 and
   * has not posted", and /budgets counted the $2,291.21 in what was spent AND in what came due — $4,599.86 projected
   * for one month's rent. His July rent posted Jul 8, a week after the 1st, and his own next date holds the rent's
   * walk at Sep 1, so a real import keeps Oct 1 on it. A payment past its grace pays the day it is late for
   * (`paymentFor`) — the rent's, and the utilities' inside it.
   */
  test("a rent paid four days late pays its Oct 1 late: drawn once, owed on no surface, counted once", () => {
    bundle.db.insert(transactions).values(row("t-oct5", "2026-10-05", -229121, RENT, "FLAMINGO SOUTH BEACH")).run();
    importedThrough("2026-10-07");
    const october = recurringCalendar(bundle.db, "2026-10", TODAY);
    // the Oct 5 row is the rent's Oct 1; the utilities are paid with it
    expect(october.entriesByDay["2026-10-01"]!.map((e) => [e.seriesId, e.state, e.paidWith])).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-05", early: false }],
    ]);
    expect(october.entriesByDay["2026-10-05"]!.map((e) => [e.seriesId, e.transactionId])).toEqual([[RENT, "t-oct5"]]);
    expect(october.missedCount).toBe(0);
    expect(arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    expect([RENT, UTIL].map((id) => seriesDetail(bundle.db, id, TODAY).overdue)).toEqual([null, null]);
    const [housing] = budgetPaceStatuses(bundle.db, TODAY);
    // the Oct 5 row and the Oct 7 coffee, spent — and nothing more came due
    expect([housing!.spentCents, housing!.overdueCents]).toEqual([229571, 0]);
    expect(forecastCurrentMonth(bundle.db, TODAY).components.map((c) => c.detail ?? "")).not.toContainEqual(
      expect.stringMatching(/came due/),
    );
  });

  /*
   * 🔴 THE PAIR'S GRACE ASKED NO DAY (review of 5557162): the widest tolerance among everything billed with the rent —
   * no status asked, no due day — so an annual item carried (14 days, `CADENCE_TOLERANCE_DAYS`) held every monthly rent
   * day 14 days, and an item ended in June held it 7: the rent's Oct 1 read "no import reaches 14 days past it yet … so
   * it may well have posted" in October, a month the item does not fall due in. Read on its own grace, it lends none.
   */
  test("an annual item billed with the rent, due Jan 1, lends the rent's Oct 1 none of its 14 days", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "renters",
        name: "Renters insurance",
        kind: "bill",
        cadence: "annual",
        intervalDaysAvg: 365,
        amountCentsAvg: -12000,
        nextExpectedAmountCents: -12000,
        nextExpectedOn: "2027-01-01",
        anchorDay: 1,
        toleranceDays: 14,
        status: "confirmed",
        userBilledWithSeriesId: RENT,
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    importedThrough("2026-10-04");
    expect(surfaces()).toEqual(NOT_POSTED);
  });

  test("a quarterly item once billed with the rent, ended Jun 30, lends it none of its 7 days", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "parking",
        name: "Parking permit",
        kind: "bill",
        cadence: "quarterly",
        intervalDaysAvg: 91,
        amountCentsAvg: -9000,
        nextExpectedAmountCents: -9000,
        nextExpectedOn: "2026-07-01",
        anchorDay: 1,
        toleranceDays: 7,
        status: "ended",
        userEndsOn: "2026-06-30",
        userBilledWithSeriesId: RENT,
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    importedThrough("2026-10-04");
    expect(surfaces()).toEqual(NOT_POSTED);
  });

  /*
   * ⚖️ …and on its own accounts: his decision 62 (2026-10-12) reads a bill where its last two payments posted — the
   * rent's checking account — never where what it carries once posted on its own. What it carries is read on both
   * (`landingAccountsBySeries`): a payment of its own may still sit on the card no statement has reached since Sep 20.
   * 🔴 (review of 5557162) Its commit said the pair now says "not posted" on the same day; here it cannot, and must not:
   * read on the card too, the rent's Oct 1 would wait on an account it never paid from — decision 62's own 🔴.
   */
  test("utilities once paid on a card of their own wait for that card; the rent reads its own account", () => {
    const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
    bundle.db
      .insert(accounts)
      .values({
        id: "card",
        institutionId,
        name: "Card",
        type: "credit",
        currency: "USD",
        isActive: true,
        displayOrder: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    bundle.db
      .insert(transactions)
      .values([
        { ...row("t-u-jul", "2026-07-01", -18221, UTIL, "FLAMINGO UTILITIES"), accountId: "card" },
        { ...row("t-u-aug", "2026-08-01", -18221, UTIL, "FLAMINGO UTILITIES"), accountId: "card" },
      ])
      .run();
    bundle.db.update(recurringSeries).set({ lastMatchedOn: "2026-08-01" }).where(eq(recurringSeries.id, UTIL)).run();
    checkedThrough(bundle.db, "card", "2026-09-20");
    importedThrough("2026-10-07");
    expect(surfaces().calendar).toEqual([NOT_POSTED.calendar[0], QUIET.calendar[1]]);
    const late = arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series;
    expect(late.map((s) => [s.id, s.unreadCents])).toEqual([
      [RENT, 0],
      [UTIL, 18221],
    ]);
  });

  test("a bill billed on its own waits its own grace: one day's grace is read the day after", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 1 }).where(eq(recurringSeries.id, RENT)).run();
    importedThrough("2026-10-01");
    expect(surfaces([RENT]).calendar).toEqual([["unsettled", "not_imported"]]);
    importedThrough("2026-10-02");
    expect(surfaces([RENT]).calendar).toEqual([["missed", null]]);
    expect(surfaces([RENT]).runway[0]).toMatch(/: \$2,109\.00 has not posted, and no statement has covered the other/);
  });
});

describe("a bill read part of the way is split by which due days' grace the checked statements reach", () => {
  test("a weekly bill with 2 days' grace, imported through Oct 9: Oct 1 is read, Oct 8 and Oct 15 are not", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "laundry",
        name: "Laundry",
        kind: "bill",
        cadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: -1000,
        nextExpectedAmountCents: -1000,
        nextExpectedOn: "2026-10-01",
        toleranceDays: 2,
        status: "confirmed",
        accountId: "acct",
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    importedThrough("2026-10-09");
    const late = arrearsThisMonth(bundle.db, new Set(["laundry"]), "2026-10-20").series[0]!;
    // Oct 8 is imported, but not Oct 10, the last day a payment for it may post on — and a statement is what it waits for
    expect([late.amountCents, late.unreadCents, late.inGraceCents]).toEqual([3000, 2000, 0]);
  });

  /*
   * ⛔ …and the walk read only as far as the ledger has read sees the late payment the whole walk saw. Paid Oct 11 —
   * past Oct 8's 2 days, nearer it than Oct 15 (⚖️ his decision 76, 2026-10-14) — the laundry's Oct 8 is paid late; its
   * account is checked through Oct 10, so Oct 1 is read and owed, and Oct 15 is unread. Its postings read only to the
   * read day and its grace, the short walk owed Oct 8 too and called Oct 15's $10.00 "never posted". (Paid Oct 12, 3
   * days before Oct 15 and 4 after Oct 8, it would be Oct 15's, early.)
   */
  test("a weekly bill paid late past its account's checked day: the short walk counts the late payment too", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "laundry",
        name: "Laundry",
        kind: "bill",
        cadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: -1000,
        nextExpectedAmountCents: -1000,
        nextExpectedOn: "2026-10-01",
        toleranceDays: 2,
        status: "confirmed",
        accountId: "acct",
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    bundle.db.insert(transactions).values(row("t-laundry", "2026-10-11", -1000, "laundry", "LAUNDRY")).run();
    checkedThrough(bundle.db, "acct", "2026-10-10");
    const late = arrearsThisMonth(bundle.db, new Set(["laundry"]), "2026-10-20").series[0]!;
    // Oct 1 and Oct 15 owed; of them, Oct 15 is a day the checked balances do not reach with its grace
    expect([late.nextDate, late.occurrenceCount, late.amountCents, late.unreadCents]).toEqual([
      "2026-10-01",
      2,
      2000,
      1000,
    ]);
  });
});

describe("an account no statement will come for is read through today — and still waits for the grace", () => {
  /*
   * ⚖️ An archived account is read through the day of the question (`silenceReadThrough`, 2026-10-08), so its
   * bills' days are read as soon as their grace has passed — never waiting for a statement /imports will not ask for —
   * and not before: a bill due inside the last three days may still post (elsewhere, or late).
   */
  test("archived: Oct 1 + 3 days is read on Oct 8; a bill due Oct 6 is not yet", () => {
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, "acct")).run();
    expect(surfaces().calendar).toEqual(NOT_POSTED.calendar);
    bundle.db
      .update(recurringSeries)
      .set({ anchorDay: 6, nextExpectedOn: "2026-10-06", userNextExpectedOn: "2026-10-06" })
      .where(eq(recurringSeries.id, RENT))
      .run();
    const oct6 = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-06"]!.find(
      (e) => e.seriesId === RENT,
    )!;
    expect([oct6.state, oct6.unsettledReason]).toEqual(["unsettled", "in_grace"]);
  });

  /*
   * 🔴 …and it said "no import has covered it yet" while it waited (review of the 2026-10-08 batch): of an archived
   * card, an import /imports will never ask for. What it waits for is its 3 days to post — said in the words its own
   * page's body already uses, "the days a payment has to post", on every surface that said the other. ⚖️ No new
   * verdict: quiet, unsettled and unread exactly as before; the words only.
   */
  test("archived, due Oct 6: every surface says the days a payment has to post are not over — never 'no import'", () => {
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, "acct")).run();
    bundle.db
      .update(recurringSeries)
      .set({ anchorDay: 6, nextExpectedOn: "2026-10-06", userNextExpectedOn: "2026-10-06" })
      .run();
    expect(surfaces([RENT, UTIL], ["2026-10-06", "Oct 6"])).toEqual({
      calendar: [
        ["unsettled", "in_grace"],
        ["unsettled", "in_grace"],
      ],
      card: [
        ["Already due — the days a payment has to post are not over yet", false],
        ["Already due — the days a payment has to post are not over yet", false],
      ],
      endDialog: [
        "Already due this month, the days a payment has to post are not over yet",
        "Already due this month, the days a payment has to post are not over yet",
      ],
      runway: [
        "A further $2,291.21 came due earlier this month and the days a payment has to post are not over yet.",
        false,
      ],
      budgets: [[229121, 229121, 229121]],
      forecast: [
        " and the days a payment has to post are not over yet",
        " and the days a payment has to post are not over yet",
      ],
    });
  });

  test("a weekly bill on it, read part of the way: what is read is not posted, the rest waits for its days", () => {
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, "acct")).run();
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "laundry",
        name: "Laundry",
        kind: "bill",
        cadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: -1000,
        nextExpectedAmountCents: -1000,
        nextExpectedOn: "2026-10-01",
        toleranceDays: 6,
        status: "confirmed",
        accountId: "acct",
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    // read through Oct 20: Oct 1 and Oct 8 are past their 6 days, Oct 15 has until Oct 21
    const late = arrearsThisMonth(bundle.db, new Set(["laundry"]), "2026-10-20").series[0]!;
    expect([late.amountCents, late.unreadCents, late.inGraceCents]).toEqual([3000, 1000, 1000]);
  });

  test("a live account checked through today says the same: what it waits for is days still to come", () => {
    bundle.db
      .update(recurringSeries)
      .set({ anchorDay: 6, nextExpectedOn: "2026-10-06", userNextExpectedOn: "2026-10-06" })
      .where(eq(recurringSeries.id, RENT))
      .run();
    // one day short of today, a statement is what it waits for
    importedThrough("2026-10-07");
    expect(surfaces([RENT], ["2026-10-06", "Oct 6"]).calendar).toEqual([["unsettled", "not_imported"]]);
    importedThrough(TODAY);
    expect(surfaces([RENT], ["2026-10-06", "Oct 6"]).calendar).toEqual([["unsettled", "in_grace"]]);
  });
});
