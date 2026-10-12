import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsSentence } from "@/lib/committed";
import { addDays, compareDates } from "@/lib/dates";
import { alreadyDueWords } from "@/components/recurring/labels";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { committedBook } from "./committed";
import { dueDayReadings } from "./observation-frontier";
import { upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 62 (2026-10-12): a bill's "not posted" test reads the accounts its LAST TWO PAYMENTS posted to — the
 * landing rule its "running late" chip and its lapse already use (`silenceMeasuredThroughBySeries`) — never every
 * account it ever paid from.
 *
 * 🔴 Measured on his ledger copy 2026-10-12: the rent's due days were read to Aug 12 (Chase Checking, which paid ONE
 * rent, in July) while its chip read Wells Fargo through Sep 24. Once Wells Fargo's next statement (~Oct 24) showed no
 * rent, the chip would say "running late" while the rent's page said "no import has covered it yet" — until Chase
 * Checking was imported past Oct 4, an account the rent no longer pays from.
 *
 * The fixture is his shape: the rent ($2,109.00 on the 1st, 3 days' grace, no account of its own) paid Jul 8 from
 * Chase Checking, then Aug 4 and Sep 2 from Wells Fargo; `Rent utilities & fees` billed with it (§6A 59); a parking
 * spot registered by hand that has never charged and names no account. Chase Checking is imported through Aug 12,
 * Wells Fargo through Sep 24 — both arbiters, rows and checked balances, reach the same day.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const TODAY = "2026-10-12";
const CHASE = "acct-chase";
const WF = "acct-wf";
const RENT = "rent";
const UTIL = "util";
const PARKING = "parking";

const now = () => new Date().toISOString();

let seq = 0;
function posted(accountId: string, postedOn: string, cents: number, seriesId: string | null): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      postedOn,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId,
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/**
 * An import of the account has reached `day`: a row of no series on it (`observationFrontier`) and its balance walk
 * checked through it (`accountCoverage`) — so the day both arbiters name is the same.
 */
function importedThrough(accountId: string, day: string): void {
  posted(accountId, day, -450, null);
  const walked = checkedTo.get(accountId);
  checkedTo.set(accountId, day);
  for (let d = walked === undefined ? "2026-06-01" : addDays(walked, 1); compareDates(d, day) <= 0; d = addDays(d, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day: d, balanceCents: 500_000, basis: "derived" }).run();
  }
}

/** accountId → the last day its balance walk has been written through */
const checkedTo = new Map<string, string>();

beforeEach(() => {
  checkedTo.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-not-posted-landing-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  for (const [id, name] of [
    [CHASE, "Chase Checking"],
    [WF, "Wells Fargo"],
  ] as const) {
    bundle.db
      .insert(accounts)
      .values({
        id,
        institutionId,
        name,
        type: "checking",
        currency: "USD",
        isActive: true,
        displayOrder: 0,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  categoryId = bundle.db.select().from(categories).all().find((c) => c.kind === "expense" && c.parentId === null)!.id;
  const bill = (id: string, name: string, cents: number, lastMatchedOn: string | null) => ({
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
    accountId: null,
    userCategoryId: categoryId,
    createdAt: now(),
    updatedAt: now(),
  });
  bundle.db
    .insert(recurringSeries)
    .values([
      bill(RENT, "Flamingo South Beach (rent)", -210_900, "2026-09-02"),
      { ...bill(UTIL, "Rent utilities & fees", -18_221, null), userBilledWithSeriesId: RENT },
      bill(PARKING, "Parking", -15_000, null),
    ])
    .run();
  // one rent from Chase Checking in July, then two in a row from Wells Fargo: it moved there
  posted(CHASE, "2026-07-08", -228_570, RENT);
  posted(WF, "2026-08-04", -223_711, RENT);
  posted(WF, "2026-09-02", -229_121, RENT);
  importedThrough(CHASE, "2026-08-12");
  importedThrough(WF, "2026-09-24");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What the calendar, the bill's page and the runway say of a series' Oct 1 at `today`. */
function oct1(seriesId: string, today = TODAY) {
  const e = recurringCalendar(bundle.db, "2026-10", today).entriesByDay["2026-10-01"]!.find(
    (c) => c.seriesId === seriesId,
  )!;
  const d = seriesDetail(bundle.db, seriesId, today);
  const { amountCents, unreadCents, graceDays } = d.overdue!;
  const words = alreadyDueWords({ owedCents: -amountCents, unreadCents }, graceDays);
  return { calendar: [e.state, e.unsettledReason], card: [words.heading, words.warning] };
}

const QUIET = {
  calendar: ["unsettled", "not_imported"],
  card: ["Already due — no import has covered it yet", false],
};
const NOT_POSTED = { calendar: ["missed", null], card: ["Already due, and not posted", true] };

/** The day the rent's chip measures its silence to — `upcomingOccurrences`' staleness, the "running late" chip. */
function chipOf(seriesId: string, today = TODAY) {
  return upcomingOccurrences(bundle.db, today, 30).find((o) => o.seriesId === seriesId)!.staleness!;
}

describe("a bill's due days are read where it posts NOW — its last two payments' accounts (decision 62)", () => {
  test("his ledger today: the rent is read through Wells Fargo's Sep 24, not Chase Checking's Aug 12", () => {
    expect(dueDayReadings(bundle.db, TODAY)(RENT)).toEqual({ observedThrough: "2026-09-24", graceDays: 3 });
    // the chip's accounts, and so the chip's day: both arbiters reach Sep 24 on Wells Fargo here
    expect(dueDayReadings(bundle.db, TODAY)(RENT).observedThrough).toBe(
      silenceMeasuredThroughBySeries(bundle.db, TODAY)(RENT),
    );
    // Sep 24 < Oct 1 + 3: still unread, so nothing visible changes today
    expect(oct1(RENT)).toEqual(QUIET);
  });

  test("Wells Fargo imported through Oct 3 is quiet; through Oct 4 — due + grace — the rent is not posted", () => {
    importedThrough(WF, "2026-10-03");
    expect(oct1(RENT)).toEqual(QUIET);
    importedThrough(WF, "2026-10-04");
    // Chase Checking still stops at Aug 12: an account the rent left cannot hold its day unread
    expect(oct1(RENT)).toEqual(NOT_POSTED);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toContain("never posted");
  });

  test("what is billed with the rent is read where the rent posts now — one payment, one answer", () => {
    expect(dueDayReadings(bundle.db, TODAY)(UTIL)).toEqual(dueDayReadings(bundle.db, TODAY)(RENT));
    importedThrough(WF, "2026-10-04");
    expect(oct1(UTIL)).toEqual(NOT_POSTED);
  });

  test("an account it LEFT, read past the due day, cannot vouch: quiet while Wells Fargo is unread", () => {
    importedThrough(CHASE, "2026-10-10");
    expect(dueDayReadings(bundle.db, TODAY)(RENT).observedThrough).toBe("2026-09-24");
    expect(oct1(RENT)).toEqual(QUIET);
  });
});

describe("the chip and the ✕ read the same accounts — one day", () => {
  /*
   * Sep 2 + 48 days' tolerance is Oct 20: Wells Fargo read empty through Oct 20 makes the rent late. On that same
   * reading its Oct 1 has long been past its grace — "running late" beside "not posted", never "no import has
   * covered it yet".
   */
  test("Wells Fargo read through Oct 21, no rent: the chip says running late, its Oct 1 not posted", () => {
    const today = "2026-10-25";
    importedThrough(WF, "2026-10-21");
    expect(chipOf(RENT, today)).toMatchObject({ checkedThrough: "2026-10-21", isStale: true });
    expect(seriesDetail(bundle.db, RENT, today).evidence).toBe("running-late");
    expect(dueDayReadings(bundle.db, today)(RENT).observedThrough).toBe(chipOf(RENT, today).checkedThrough);
    expect(oct1(RENT, today)).toEqual(NOT_POSTED);
  });
});

describe("a bill that has never charged and names no account has been read nowhere", () => {
  test("parking, registered by hand: no import has covered it yet, whatever is imported", () => {
    importedThrough(WF, "2026-10-10");
    importedThrough(CHASE, "2026-10-10");
    expect(dueDayReadings(bundle.db, TODAY)(PARKING).observedThrough).toBeNull();
    expect(oct1(PARKING)).toEqual(QUIET);
  });

  test("…while one that NAMES its account is read there before it ever charges", () => {
    bundle.db.update(recurringSeries).set({ accountId: WF }).where(eq(recurringSeries.id, PARKING)).run();
    expect(dueDayReadings(bundle.db, TODAY)(PARKING).observedThrough).toBe("2026-09-24");
    importedThrough(WF, "2026-10-04");
    expect(dueDayReadings(bundle.db, TODAY)(PARKING).observedThrough).toBe("2026-10-04");
  });
});
