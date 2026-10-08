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
import { arrearsAlarms } from "@/lib/arrears-reading";
import { arrearsReadingOf, arrearsSentence } from "@/lib/committed";
import { formatCents } from "@/lib/money";
import { alreadyDueWords } from "@/components/recurring/labels";
import { seriesEndInput, seriesEndLines } from "@/components/recurring/end-radius";
import { arrearsThisMonth } from "./arrears";
import { budgetPaceStatuses, createBudget } from "./budgets";
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 60 (2026-10-08): a bill reads "not posted" (warning) — and the calendar's red ✕ — only once
 * statements cover the due day PLUS the bill's tolerance, the grace days a payment may still post on; until then "no
 * import has covered it yet", quiet. ONE rule on the calendar (`settledVerdict`), the bill's page, the runway,
 * /budgets, the End dialog and the forecast's arrears line.
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

/** An import of the checking account has reached `day` — a row of no series on it (`observationFrontier`). */
function importedThrough(day: string): void {
  bundle.db.insert(transactions).values(row(`t-coffee-${day}`, day, -450, null, "COFFEE")).run();
}

/** What every surface that says a bill came due says of these series' Oct 1, at TODAY. */
function surfaces(ids: readonly string[] = [RENT, UTIL]) {
  const calendar = recurringCalendar(bundle.db, "2026-10", TODAY).entriesByDay["2026-10-01"] ?? [];
  const book = committedBook(bundle.db, TODAY);
  const components = forecastCurrentMonth(bundle.db, TODAY).components;
  return {
    calendar: ids.map((id) => {
      const e = calendar.find((c) => c.seriesId === id)!;
      return [e.state, e.unsettledReason];
    }),
    card: ids.map((id) => {
      const d = seriesDetail(bundle.db, id, TODAY);
      // the page's own grace (`overdue.graceDays`), as `AlreadyDueCard` passes it
      const w = alreadyDueWords(
        { owedCents: -d.overdue!.amountCents, unreadCents: d.overdue!.unreadCents },
        d.overdue!.graceDays,
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
    budgets: budgetPaceStatuses(bundle.db, TODAY).map((s) => [s.overdueCents, s.overdueUnreadCents]),
    forecast: ids.map((id) => {
      const name = id === RENT ? "Flamingo South Beach (rent)" : "Rent utilities & fees";
      return /came due Oct 1(.*)$/.exec(components.find((c) => c.label === name)!.detail ?? "")![1];
    }),
  };
}

const QUIET = {
  calendar: [
    ["unsettled", "not_imported"],
    ["unsettled", "not_imported"],
  ],
  card: [
    ["Already due — no import has covered it yet", false],
    ["Already due — no import has covered it yet", false],
  ],
  endDialog: [
    "Already due this month, no import has covered it yet",
    "Already due this month, no import has covered it yet",
  ],
  runway: ["A further $2,291.21 came due earlier this month and no import has covered it yet.", false],
  budgets: [[229121, 229121]],
  forecast: [" and no import has covered it yet", " and no import has covered it yet"],
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
  runway: ["A further $2,291.21 came due earlier this month and never posted.", true],
  budgets: [[229121, 0]],
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
  test("imported through Oct 3 — due + grace − 1 — every surface still says no import has covered it yet", () => {
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
    // that waited for 5 (`seriesDetail.overdue.graceDays`, the card's words)
    const utilities = seriesDetail(bundle.db, UTIL, TODAY).overdue!;
    expect(utilities.graceDays).toBe(5);
    expect(alreadyDueWords({ owedCents: -utilities.amountCents, unreadCents: 0 }, utilities.graceDays).body).toContain(
      "the imports, which reach 5 days past it, hold no posting within 5 days of it",
    );
  });

  test("a bill billed on its own waits its own grace: one day's grace is read the day after", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 1 }).where(eq(recurringSeries.id, RENT)).run();
    importedThrough("2026-10-01");
    expect(surfaces([RENT]).calendar).toEqual([["unsettled", "not_imported"]]);
    importedThrough("2026-10-02");
    expect(surfaces([RENT]).calendar).toEqual([["missed", null]]);
    expect(surfaces([RENT]).runway[0]).toMatch(/: \$2,109\.00 never posted, and no import has covered the other/);
  });
});

describe("a bill read part of the way is split by which due days' grace the imports reach", () => {
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
    // Oct 8 is imported, but not Oct 10, the last day a payment for it may post on
    expect([late.amountCents, late.unreadCents]).toEqual([3000, 2000]);
  });
});

describe("an account no statement will come for is read through today — and still waits for the grace", () => {
  /*
   * ⚖️ An archived account is read through the day of the question (`silenceObservedThrough`, 2026-10-08), so its
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
    expect([oct6.state, oct6.unsettledReason]).toEqual(["unsettled", "not_imported"]);
  });
});
