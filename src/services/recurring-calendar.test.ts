import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { detectRecurringSeries, setSeriesStatus } from "./recurring";
import { MIN_OCCURRENCES } from "./recurring";
import { classifyPostedAmount, recurringCalendar, scheduleIsProven } from "./recurring-calendar";

const TODAY = "2026-07-08";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

let dir: string;
let bundle: DbBundle;
let cardId: string;
let netflixId: string;
let seq = 0;

function insertTxn(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId?: string | null;
}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      merchantId: opts.merchantId ?? null,
      dedupeHash: dedupeHash({
        accountId: cardId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** A monthly Netflix series charging on the 15th; the June charge can drift. */
function buildMonthlyNetflix(juneAmountCents = -1549): void {
  for (const m of MONTHS) {
    const amount = m === "2026-06" ? juneAmountCents : -1549;
    insertTxn({ postedOn: `${m}-15`, amountCents: amount, rawDescription: "NETFLIX.COM", merchantId: netflixId });
  }
}

function netflix() {
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, netflixId)).get()!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reccal-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("classifyPostedAmount", () => {
  test("within the $1 floor is paid", () => {
    // 50c drift, tolerance floor is 100c → paid
    expect(classifyPostedAmount(-1549, -1499, 0)).toBe("paid");
  });

  test("a cent of drift is paid (floor)", () => {
    expect(classifyPostedAmount(-1549, -1548, 0)).toBe("paid");
    expect(classifyPostedAmount(-1549, -1549, 0)).toBe("paid");
  });

  test("an UNMEASURED series never reports a change, however wide the gap", () => {
    // null ≠ 0. A σ of 0 is the measurement "this series never varies", which
    // makes a $10 swing meaningful; a null is the absence of any measurement,
    // which makes the same swing unclaimable. Reading them alike drew eight of
    // April 2026's nine marks amber on a variable tutoring income.
    expect(classifyPostedAmount(-1799, -1549, null)).toBe("paid");
    expect(classifyPostedAmount(91800, 16705, null)).toBe("paid");
    expect(classifyPostedAmount(-1799, -1549, 0)).toBe("paid_different");
  });

  test("a real price change beyond every band is paid_different", () => {
    // $2.50 hike on a $15.49 charge: > $1 floor, > 2% (31c), > 2σ (0)
    expect(classifyPostedAmount(-1799, -1549, 0)).toBe("paid_different");
  });

  test("2σ widens the band for a naturally noisy series", () => {
    // 250c drift but σ=200 → 2σ=400 tolerance → paid
    expect(classifyPostedAmount(-1799, -1549, 200)).toBe("paid");
  });

  test("2% of a large charge widens the band", () => {
    // $30 drift on a $1800 rent: 2% = $36 → within band → paid
    expect(classifyPostedAmount(-183000, -180000, 0)).toBe("paid");
    expect(classifyPostedAmount(-184000, -180000, 0)).toBe("paid_different");
  });

  /*
   * ⛔ The band's own EDGE, which every test above steps over or under. Found
   * by mutation: tightening `<= tolerance` to `<` changed nothing, because no
   * fixture sat exactly on it. A charge at exactly its tolerance would draw
   * with the `paid_different` glyph and tell the reader a fixed commitment
   * changed price when it did not.
   */
  test("a drift EXACTLY at the tolerance is paid, and one cent more is not", () => {
    // floor band: $1.00 on a $15.49 charge with σ=0
    expect(classifyPostedAmount(-1649, -1549, 0)).toBe("paid");
    expect(classifyPostedAmount(-1650, -1549, 0)).toBe("paid_different");
    // 2% band: $36.00 on $1,800.00
    expect(classifyPostedAmount(-183600, -180000, 0)).toBe("paid");
    expect(classifyPostedAmount(-183601, -180000, 0)).toBe("paid_different");
    // 2σ band: σ=200 → $4.00
    expect(classifyPostedAmount(-1949, -1549, 200)).toBe("paid");
    expect(classifyPostedAmount(-1950, -1549, 200)).toBe("paid_different");
  });
});

/*
 * ⛔ `scheduleIsProven` decides whether a past occurrence reads as `missed` —
 * a date worth holding a biller to — or as `unsettled` with a hedged reason.
 * Its threshold was never asserted AT the threshold, so `>= MIN_OCCURRENCES`
 * could be tightened to `>` and nothing went red: a series sitting exactly on
 * the measured-vs-extrapolated line would be graded, and worded, as the other
 * kind.
 */
describe("scheduleIsProven — the threshold, at the threshold", () => {
  test("zero postings is a human-authored schedule, which is proven by definition", () => {
    expect(scheduleIsProven(0)).toBe(true);
  });

  test("one short of the threshold is extrapolated, and the threshold itself is measured", () => {
    expect(scheduleIsProven(MIN_OCCURRENCES - 1)).toBe(false);
    expect(scheduleIsProven(MIN_OCCURRENCES)).toBe(true);
    expect(scheduleIsProven(MIN_OCCURRENCES + 1)).toBe(true);
  });

  test("the threshold is a checkable number, not a magic one", () => {
    expect(MIN_OCCURRENCES).toBe(3);
  });
});

describe("recurringCalendar", () => {
  test("a past month shows its posted charge as paid", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    const day = march.entriesByDay["2026-03-15"];
    expect(day).toHaveLength(1);
    expect(day![0]).toMatchObject({ state: "paid", amountCents: -1549, transactionId: expect.any(String) });
    expect(march.postedNetCents).toBe(-1549);
    expect(march.upcomingNetCents).toBe(0);
    expect(march.missedCount).toBe(0);
    expect(march.entryCount).toBe(1);
  });

  test("a series that has NEVER posted still projects — it has not stopped, it has not started", () => {
    // The car-lease shape. `isSeriesActive`, which this gate used to be, calls a
    // never-posted series inactive, and the owner's registered Car lease
    // ($559.89) and Car insurance ($361.49) were absent from every calendar
    // month because of it.
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    bundle.db
      .update(recurringSeries)
      .set({ lastMatchedOn: null, kind: "bill" })
      .where(eq(recurringSeries.name, "Netflix"))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(july.entriesByDay["2026-07-15"]?.[0]).toMatchObject({ state: "upcoming" });
  });

  /*
   * ⛔ AN OCCURRENCE DUE TODAY IS A FORECAST, NOT A PAST EVENT — and today is
   * the only day that can say so. Found by mutation: tightening
   * `compareDates(o.date, today) >= 0` to `> 0` changed no test, because no
   * fixture series was ever due on the reference day.
   *
   * The cost is the cell drawing as `unsettled` on the day the bill falls due,
   * losing its `scheduled` confidence badge and dropping out of the month's
   * upcoming total. `month-flow.ts` pins the same instant on its own side of
   * the seam ("upcoming means on or after today"); the grid did not.
   */
  test("a bill due TODAY is upcoming, not something the ledger has failed to settle", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // move the schedule onto today itself
    bundle.db
      .update(recurringSeries)
      .set({ nextExpectedOn: TODAY, userNextExpectedOn: TODAY })
      .where(eq(recurringSeries.name, "Netflix"))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    const cell = july.entriesByDay[TODAY]?.[0];
    expect(cell).toMatchObject({ state: "upcoming" });
    // …and it is counted as money still to come, not as a settled verdict
    expect(july.upcomingNetCents).toBeLessThan(0);
    expect(july.missedCount).toBe(0);
  });

  /*
   * The calendar's own "already posted" tolerance, at its edge. `budgets.ts`
   * states in writing that this rule must match `overdueForSeries`'; both were
   * untested AT the limit, and both are now pinned. A bill paid at the outer
   * edge of its own tolerance would otherwise be drawn as unpaid while the
   * charge for it sits in the ledger.
   */
  test("a posting EXACTLY toleranceDays from the due date settles the occurrence", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const s = netflix();
    expect(s.nextExpectedOn).toBe("2026-07-15");

    // the charge lands exactly `toleranceDays` after the scheduled day, and is
    // linked the way an import would link it
    const due = "2026-07-15";
    const paid = addDays(due, s.toleranceDays);
    const id = insertTxn({ postedOn: paid, amountCents: -1549, rawDescription: "NETFLIX.COM", merchantId: netflixId });
    bundle.db.update(transactions).set({ recurringSeriesId: s.id }).where(eq(transactions.id, id)).run();

    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    // settled: the projection on the 15th is gone, and only the posted row
    // remains on the day it actually landed
    expect(july.entriesByDay[due]).toBeUndefined();
    expect(july.entriesByDay[paid]?.[0]).toMatchObject({ state: "paid", transactionId: id });
  });

  test("a posting one day PAST the tolerance leaves the occurrence standing", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const s = netflix();
    const due = "2026-07-15";
    const id = insertTxn({
      postedOn: addDays(due, s.toleranceDays + 1),
      amountCents: -1549,
      rawDescription: "NETFLIX.COM",
      merchantId: netflixId,
    });
    bundle.db.update(transactions).set({ recurringSeriesId: s.id }).where(eq(transactions.id, id)).run();

    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(july.entriesByDay[due]?.[0]).toMatchObject({ state: "upcoming" });
  });

  test("a lapsed BILL drops off the calendar, a lapsed INCOME series does not", () => {
    // The two halves of the rule, on one fixture, because the difference IS the
    // feature: a dead subscription is cancelled; irregular cash pay is not.
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const lapse = (kind: "bill" | "income") =>
      bundle.db
        .update(recurringSeries)
        .set({ lastMatchedOn: "2025-05-25", kind })
        .where(eq(recurringSeries.name, "Netflix"))
        .run();

    lapse("bill");
    expect(recurringCalendar(bundle.db, "2026-07", TODAY).entriesByDay["2026-07-15"]).toBeUndefined();

    lapse("income");
    expect(recurringCalendar(bundle.db, "2026-07", TODAY).entriesByDay["2026-07-15"]?.[0]).toMatchObject({
      state: "upcoming",
    });
  });

  test("an amount that drifted past the band shows paid_different", () => {
    buildMonthlyNetflix(-1799); // June is a price hike
    detectRecurringSeries(bundle.db, TODAY);
    const june = recurringCalendar(bundle.db, "2026-06", TODAY);
    const day = june.entriesByDay["2026-06-15"];
    expect(day![0]!.state).toBe("paid_different");
    expect(day![0]!.amountCents).toBe(-1799);
  });

  test("a future expected occurrence in the current month is upcoming", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // charges on the 15th → next expected 2026-07-15 (≥ today)
    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    const day = july.entriesByDay["2026-07-15"];
    expect(day).toHaveLength(1);
    expect(day![0]).toMatchObject({ state: "upcoming", transactionId: null, amountCents: -1549 });
    expect(july.upcomingNetCents).toBe(-1549);
    expect(july.missedCount).toBe(0);
  });

  test("a schedule extrapolated from one or two postings cannot be missed", () => {
    // FPL on the real ledger: ONE posting, a due date extrapolated from it that
    // was wrong by thirteen days, and a red ✕ reporting the biller delinquent on
    // a date the app had invented.
    insertTxn({ postedOn: "2026-06-15", amountCents: -1421, rawDescription: "FPL ELEC PYMT" });
    insertTxn({ postedOn: "2026-07-18", amountCents: -2200, rawDescription: "GROCERY" });
    const id = bundle.db
      .insert(recurringSeries)
      .values({
        name: "FPL",
        accountId: cardId,
        kind: "bill",
        cadence: "monthly",
        nextExpectedOn: "2026-07-15",
        nextExpectedAmountCents: -1421,
        lastMatchedOn: "2026-06-15",
        status: "confirmed",
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: id })
      .where(eq(transactions.rawDescription, "FPL ELEC PYMT"))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const fpl = Object.values(july.entriesByDay)
      .flat()
      .find((e) => e.name === "FPL" && e.transactionId === null);
    expect(fpl).toMatchObject({ state: "unsettled", unsettledReason: "schedule_unproven" });
  });

  test("a hand-registered commitment that has NEVER posted stays missable", () => {
    // The car lease: registered by hand for a date the owner chose, with no
    // postings at all. Nothing could have been extrapolated, so the date is his
    // statement — and a payment that never arrives is a real miss.
    insertTxn({ postedOn: "2026-07-18", amountCents: -2200, rawDescription: "GROCERY" });
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Car lease",
        accountId: cardId,
        kind: "bill",
        cadence: "monthly",
        nextExpectedOn: "2026-07-11",
        nextExpectedAmountCents: -55989,
        userAmountCents: -55989,
        status: "confirmed",
      })
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const lease = Object.values(july.entriesByDay)
      .flat()
      .find((e) => e.name === "Car lease");
    expect(lease).toMatchObject({ state: "missed", unsettledReason: null });
  });

  test("an overdue occurrence on an UNIMPORTED day is unsettled, not missed", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // The card's newest row is 2026-06-15 and it has no statement periods, so
    // the ledger has never been shown 2026-07-15. Calling that a miss is the
    // defect this state exists to remove — it is how August 2026 came to draw
    // six red marks of which only two were real.
    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const day = july.entriesByDay["2026-07-15"];
    expect(day![0]).toMatchObject({ state: "unsettled", unsettledReason: "not_imported" });
    expect(july.missedCount).toBe(0);
    expect(july.unsettledCount).toBe(1);
    expect(july.unsettledGrossCents).toBe(1549);
    expect(july.upcomingNetCents).toBe(0);
  });

  test("an overdue occurrence on an IMPORTED day is still missed", () => {
    // The pass-45 guard: $2,285.70 of overdue rent once hid behind a budget that
    // read green, and narrowing `missed` must not resurrect that. A row on the
    // same account dated after the occurrence proves the import walked past it,
    // so the silence on the 15th is a real answer.
    buildMonthlyNetflix();
    insertTxn({ postedOn: "2026-07-18", amountCents: -2200, rawDescription: "GROCERY" });
    detectRecurringSeries(bundle.db, TODAY);
    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const day = july.entriesByDay["2026-07-15"];
    expect(day![0]).toMatchObject({ state: "missed", unsettledReason: null });
    expect(july.missedCount).toBe(1);
    expect(july.unsettledCount).toBe(0);
  });

  test("a payday the ledger cannot see is unbanked, never missed", () => {
    // Cash income is handed over in person and reaches the ledger only when it
    // is deposited; pass 60 measured eleven silent paydays against $12,552 of
    // implied earnings. A red ✕ on each would be the app calling him unpaid.
    // Note the day IS imported here — coverage is not what saves it.
    for (const day of ["2026-06-05", "2026-06-12", "2026-06-19", "2026-06-26", "2026-07-03"]) {
      insertTxn({ postedOn: day, amountCents: 104700, rawDescription: "CASH JOB WEEKLY PAY" });
    }
    insertTxn({ postedOn: "2026-07-19", amountCents: -2200, rawDescription: "GROCERY" });
    detectRecurringSeries(bundle.db, TODAY);
    bundle.db
      .update(recurringSeries)
      .set({ kind: "income" })
      .where(eq(recurringSeries.name, "CASH JOB WEEKLY PAY"))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const unpaid = Object.values(july.entriesByDay)
      .flat()
      .filter((e) => e.name === "CASH JOB WEEKLY PAY" && e.transactionId === null);
    expect(unpaid.length).toBeGreaterThan(0);
    for (const e of unpaid) {
      expect(e.state).not.toBe("missed");
      if (e.state === "unsettled") expect(e.unsettledReason).toBe("unbanked");
    }
  });

  test("an ENDED series keeps its history and loses its forecast", () => {
    // The headline defect: `status IN ('detected','confirmed')` erased 172 of
    // 274 tagged rows from the real ledger, which is why every month before
    // 2025-09 drew literally nothing. An ended series did not stop having
    // existed — Fordham work-study really did pay him 56 times.
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    setSeriesStatus(bundle.db, netflix().id, "ended");

    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    expect(march.entriesByDay["2026-03-15"]).toHaveLength(1);
    expect(march.entriesByDay["2026-03-15"]![0]).toMatchObject({ transactionId: expect.any(String) });
    expect(march.postedNetCents).toBe(-1549);

    // …and nothing is projected forward off it.
    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(july.entriesByDay["2026-07-15"]).toBeUndefined();
    expect(july.entryCount).toBe(0);
  });

  test("a DISMISSED series stays off the calendar entirely", () => {
    // Dismiss is labelled "Not recurring" in the UI — the owner saying the
    // detector was wrong. Its rows are real transactions that are not a series,
    // so drawing them here would re-assert the claim he rejected.
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    setSeriesStatus(bundle.db, netflix().id, "dismissed");

    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    expect(march.entryCount).toBe(0);
    expect(march.postedNetCents).toBe(0);
  });

  test("a future occurrence carries a confidence and a past one never does", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    // detection-owned and unconfirmed → the weakest claim the app can make
    expect(july.entriesByDay["2026-07-15"]![0]).toMatchObject({
      state: "upcoming",
      confidence: "predicted",
    });

    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    expect(march.entriesByDay["2026-03-15"]![0]!.confidence).toBeNull();
  });

  test("confirming a series and setting an amount promotes it to scheduled", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    setSeriesStatus(bundle.db, netflix().id, "confirmed");
    bundle.db
      .update(recurringSeries)
      .set({ userAmountCents: -1999 })
      .where(eq(recurringSeries.id, netflix().id))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(july.entriesByDay["2026-07-15"]![0]!.confidence).toBe("scheduled");
  });

  test("the unsettled total is GROSS, so opposed unknowns cannot cancel to zero", () => {
    // A net would publish "$0.00 not yet known (2)" for a month whose unknown
    // income happened to balance its unknown bills — a measured zero standing
    // over money nobody has measured, which is the reading the footer exists to
    // remove.
    // Through June, so the BILL has not lapsed by 2026-07-20 — money out stops
    // being forecast once its evidence runs out, and a lapsed bill would leave
    // the income side alone on the day and the test asserting nothing.
    for (const day of ["2026-03-06", "2026-04-06", "2026-05-06", "2026-06-06"]) {
      insertTxn({ postedOn: day, amountCents: 150_000, rawDescription: "PAYDAY" });
      insertTxn({ postedOn: day, amountCents: -150_000, rawDescription: "BIG BILL" });
    }
    detectRecurringSeries(bundle.db, TODAY);
    bundle.db
      .update(recurringSeries)
      .set({ kind: "income" })
      .where(eq(recurringSeries.name, "PAYDAY"))
      .run();

    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const unsettled = Object.values(july.entriesByDay)
      .flat()
      .filter((e) => e.state === "unsettled");
    expect(unsettled.map((e) => e.amountCents).reduce((a, b) => a + b, 0)).toBe(0);
    expect(july.unsettledCount).toBe(2);
    expect(july.unsettledGrossCents).toBe(300_000);
  });

  test("staleness is independent of confidence, and rides only on the future", () => {
    // The owner's cash job is the case that proves the two axes are separate: he
    // typed the amount himself, so it is `scheduled` and correctly the firmest
    // claim on the page, while it has not posted in 81 days. An income series
    // keeps projecting when it goes quiet (money in never lapses), so this is a
    // live combination, not a hypothetical.
    for (const day of ["2026-01-02", "2026-01-09", "2026-01-16", "2026-01-23"]) {
      insertTxn({ postedOn: day, amountCents: 104700, rawDescription: "CASH JOB WEEKLY PAY" });
    }
    detectRecurringSeries(bundle.db, "2026-01-30");
    bundle.db
      .update(recurringSeries)
      .set({ kind: "income", status: "confirmed", userAmountCents: 104700 })
      .where(eq(recurringSeries.name, "CASH JOB WEEKLY PAY"))
      .run();

    const future = recurringCalendar(bundle.db, "2026-07", TODAY);
    const ahead = Object.values(future.entriesByDay)
      .flat()
      .filter((e) => e.state === "upcoming");
    expect(ahead.length).toBeGreaterThan(0);
    for (const e of ahead) {
      expect(e.confidence).toBe("scheduled");
      expect(e.isStale).toBe(true);
    }

    // A POSTED row never carries it — a charge that actually happened is not
    // made doubtful by the series going quiet afterwards.
    const january = recurringCalendar(bundle.db, "2026-01", TODAY);
    const posted = january.entriesByDay["2026-01-09"]![0]!;
    expect(posted.transactionId).not.toBeNull();
    expect(posted.isStale).toBe(false);
    expect(posted.confidence).toBeNull();
  });

  test("a long-inactive series stops projecting upcoming/missed but keeps its postings", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // view July from a 'today' far past the last charge (2026-06-15): the series
    // is inactive, so no upcoming/missed clutter — but March still shows posted
    const farFuture = "2027-01-10";
    const july = recurringCalendar(bundle.db, "2026-07", farFuture);
    expect(july.entryCount).toBe(0);
    expect(july.missedCount).toBe(0);
    const march = recurringCalendar(bundle.db, "2026-03", farFuture);
    expect(march.entriesByDay["2026-03-15"]?.[0]?.state).toBe("paid");
  });

  test("dismissed series drop off the calendar entirely", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    setSeriesStatus(bundle.db, netflix().id, "dismissed");
    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    expect(march.entryCount).toBe(0);
    expect(Object.keys(march.entriesByDay)).toHaveLength(0);
  });

  test("no series → an empty month, not a throw", () => {
    const month = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(month).toMatchObject({ entryCount: 0, postedNetCents: 0, upcomingNetCents: 0, missedCount: 0 });
    expect(Object.keys(month.entriesByDay)).toHaveLength(0);
  });

  test("defaults the month and today to the wall clock without throwing", () => {
    expect(() => recurringCalendar(bundle.db)).not.toThrow();
  });
});
