import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UpcomingList } from "@/components/recurring/UpcomingList";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dayTotalCents } from "@/lib/calendar-day-weight";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { forecastForMonth } from "./forecast";
import { upcomingOccurrences } from "./recurring";
import { calendarMonthFlow, recurringCalendar } from "./recurring-calendar";

/**
 * ⚖️ A TRANSFER SERIES IS DRAWN, AND COUNTED IN NO NET. It moves his money between his own accounts, so it is
 * never income or spending — the rule the forecast card's net has always applied (`fixedComponents`), and the
 * dashboard's Upcoming with it.
 *
 * 🔴 The /recurring strip printed directly under that card summed every mark the grid draws, and the Upcoming tab's
 * 30-day net every row it lists: a one-legged transfer series — the card autopay out of checking, the card's own
 * statements never imported, so no PAYMENT THANK YOU leg to cancel it — moved "as scheduled", the footer and the
 * 30-day net by its whole amount while the card above them left it out.
 *
 * The figures are the synthetic Chase fixture's (tests/fixtures/synthetic/chase): its monthly
 * "CHASE CREDIT CRD AUTOPAY" on the 24th, and the e2e seed's $1,800.00 rent on the 9th. His own ledger holds no
 * transfer series (measured on a copy 2026-10-01), so no figure of his moves.
 */

const TODAY = "2026-07-08";
const AUG = "2026-08";
const AUTOPAY = "CHASE CREDIT CRD AUTOPAY";
const AUTOPAY_CENTS = -99_302;
const RENT_CENTS = -180_000;

let dir: string;
let bundle: DbBundle;
let checking: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-transfer-series-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checking = createAccount(bundle.db, { institutionId: chase.id, name: "Chase Total Checking", type: "checking" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function monthly(name: string, kind: SeriesKind, day: string, cents: number): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name,
      kind,
      accountId: checking,
      cadence: "monthly",
      intervalDaysAvg: 30,
      toleranceDays: 3,
      amountCentsAvg: cents,
      nextExpectedOn: `2026-07-${day}`,
      nextExpectedAmountCents: cents,
      lastMatchedOn: `2026-06-${day}`,
      status: "confirmed",
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

/** his month as the card and the calendar under it each print it */
function august() {
  const month = recurringCalendar(bundle.db, AUG, TODAY);
  const strip = calendarMonthFlow(month, TODAY);
  return {
    cardNet: forecastForMonth(bundle.db, AUG, TODAY)!.committed.netCents,
    asScheduled: strip.endCents,
    footerExpected: month.upcomingNetCents,
    aug24: dayTotalCents(month.entriesByDay["2026-08-24"] ?? []),
    drawn: Object.entries(month.entriesByDay)
      .flatMap(([day, entries]) => entries.map((e) => `${day} ${e.name}`))
      .sort(),
  };
}

/** the Upcoming tab as it renders, as text */
function upcomingTab(): string {
  return renderToStaticMarkup(createElement(UpcomingList, { occurrences: upcomingOccurrences(bundle.db, TODAY, 30) }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("a transfer series is drawn on /recurring and counted in no net, as the forecast card counts it", () => {
  test("⛔ the strip's \"as scheduled\", the footer and the day's figure are the card's net, and the mark stays", () => {
    monthly("Rent", "bill", "09", RENT_CENTS);
    monthly(AUTOPAY, "transfer", "24", AUTOPAY_CENTS);

    expect(august()).toEqual({
      cardNet: RENT_CENTS,
      asScheduled: RENT_CENTS,
      footerExpected: RENT_CENTS,
      aug24: 0,
      drawn: ["2026-08-09 Rent", `2026-08-24 ${AUTOPAY}`],
    });
  });

  test("the rule's own edge: a bill of the same schedule is in the card AND under it", () => {
    monthly("Rent", "bill", "09", RENT_CENTS);
    const autopay = monthly(AUTOPAY, "transfer", "24", AUTOPAY_CENTS);
    bundle.db.update(recurringSeries).set({ kind: "bill" }).where(eq(recurringSeries.id, autopay)).run();

    expect(august()).toEqual({
      cardNet: RENT_CENTS + AUTOPAY_CENTS,
      asScheduled: RENT_CENTS + AUTOPAY_CENTS,
      footerExpected: RENT_CENTS + AUTOPAY_CENTS,
      aug24: AUTOPAY_CENTS,
      drawn: ["2026-08-09 Rent", `2026-08-24 ${AUTOPAY}`],
    });
  });

  test("⛔ a POSTED transfer is drawn paid and adds nothing to the posted line or the Settled figure", () => {
    const rent = monthly("Rent", "bill", "09", RENT_CENTS);
    const autopay = monthly(AUTOPAY, "transfer", "24", AUTOPAY_CENTS);
    for (const [seriesId, postedOn, amountCents, raw] of [
      [rent, "2026-06-09", RENT_CENTS, "RENT PAYMENT"],
      [autopay, "2026-06-24", AUTOPAY_CENTS, AUTOPAY],
    ] as const) {
      bundle.db
        .insert(transactions)
        .values({
          accountId: checking,
          postedOn,
          amountCents,
          rawDescription: raw,
          normalizedDescription: raw,
          status: "active",
          recurringSeriesId: seriesId,
          dedupeHash: dedupeHash({ accountId: checking, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
        })
        .run();
    }

    const june = recurringCalendar(bundle.db, "2026-06", TODAY);
    const strip = calendarMonthFlow(june, TODAY);
    expect({
      settled: june.postedNetCents,
      posted: strip.settledCents,
      asScheduled: strip.endCents,
      jun24: dayTotalCents(june.entriesByDay["2026-06-24"]!),
      drawn: june.entriesByDay["2026-06-24"]!.map((e) => `${e.name} ${e.state} ${e.amountCents}`),
    }).toEqual({
      settled: RENT_CENTS,
      posted: RENT_CENTS,
      asScheduled: RENT_CENTS,
      jun24: 0,
      drawn: [`${AUTOPAY} paid ${AUTOPAY_CENTS}`],
    });
  });

  test("⛔ the Upcoming tab lists the transfer, nets it out, and names what it left out", () => {
    monthly("Rent", "bill", "09", RENT_CENTS);
    monthly(AUTOPAY, "transfer", "24", AUTOPAY_CENTS);

    const tab = upcomingTab();
    // both rows are listed — Jul 9 and Jul 24 fall inside Jul 8 – Aug 6
    expect(tab).toContain("Jul 9 Rent Bill -$1,800.00");
    expect(tab).toContain(`Jul 24 ${AUTOPAY} Transfer -$993.02`);
    expect(/30-day net (\S+)/.exec(tab)?.[1]).toBe("-$1,800.00");
    expect(tab).toContain("leaves out the -$993.02 of transfers");
  });

  test("a transfer pair cancels in the net either way, so nothing is named", () => {
    monthly("Rent", "bill", "09", RENT_CENTS);
    monthly(AUTOPAY, "transfer", "24", AUTOPAY_CENTS);
    monthly("PAYMENT THANK YOU-MOBILE", "transfer", "24", -AUTOPAY_CENTS);

    const tab = upcomingTab();
    expect(/30-day net (\S+)/.exec(tab)?.[1]).toBe("-$1,800.00");
    expect(tab).not.toContain("leaves out");
  });
});
