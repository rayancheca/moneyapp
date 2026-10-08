import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays, compareDates } from "@/lib/dates";
import { stalenessSentence } from "@/components/recurring/labels";
import { unbankedIncomeForSeries } from "./arrears";
import { landingAccountsBySeries } from "./cash-earnings";
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { listSeries, seriesStaleness, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * 🔴 VISIBLE on his ledger 2026-10-08, and on every surface that says "running late":
 *
 *   /recurring   "1 payday worth $1,141.92 already passed this month … It falls after Thu, Sep 24, 2026, the last
 *                 day every account that pay lands in has been checked through — so the ledger has not looked for
 *                 its deposit."  and two lines on  "MONEY IN — all of it running late"
 *   Upcoming     "It America LLC (weekly pay) … last seen 14d ago" under "In October 2026, 4 series are running late"
 *   series page  a "Running late" badge
 *
 * The pay lands in Wells Fargo, checked through Sep 24; its Oct 1 payday is on a day nobody has read. Rocket Money
 * posts to Chase Checking, checked through Aug 12 — its Aug 15 charge is unread too. Late is a claim about days the
 * ledger has CHECKED, on the account the series posts to NOW (the 2026-10-07 frontier, `checkedThroughBySeries`).
 *
 * ⛔ The fixture is that ledger's shape: the pay names Wells Fargo but once landed in Chase (two June ATM deposits),
 * so a frontier over every account it ever touched would take Chase's Aug 12 — and a series that truly missed on
 * checked days (Venture X, checked through Sep 13, quiet since Jul 18) must STAY late.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-10-08";
const WF = "acct-wf";
const CHASE = "acct-chase";
const VX = "acct-vx";
const PAY = "series-pay";
const ROCKET = "series-rocket";
const UTILITY = "series-utility";
const LATE = "series-late";
const now = (): string => new Date().toISOString();

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function addSeries(o: {
  id: string;
  name: string;
  kind: "income" | "bill" | "subscription";
  cadence: "weekly" | "monthly";
  accountId: string | null;
  amountCents: number;
  lastMatchedOn: string;
  nextExpectedOn: string;
  status?: "confirmed" | "detected";
}): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      id: o.id,
      name: o.name,
      kind: o.kind,
      cadence: o.cadence,
      userCadence: o.cadence === "weekly" ? "weekly" : null,
      intervalDaysAvg: o.cadence === "weekly" ? 7 : 30,
      accountId: o.accountId,
      amountCentsAvg: o.amountCents,
      nextExpectedOn: o.nextExpectedOn,
      nextExpectedAmountCents: o.amountCents,
      lastMatchedOn: o.lastMatchedOn,
      status: o.status ?? "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
function posted(accountId: string, seriesId: string, postedOn: string, amountCents: number): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      postedOn,
      amountCents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
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

/** Days the balance walk has read — what `accountCoverage` grades checked. */
function checkedThrough(accountId: string, from: string, to: string): void {
  for (let day = from; compareDates(day, to) <= 0; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-late-unread-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  for (const id of [WF, CHASE, VX]) addAccount(id);
  checkedThrough(WF, "2026-06-01", "2026-09-24");
  checkedThrough(CHASE, "2026-06-01", "2026-08-12");
  checkedThrough(VX, "2026-06-01", "2026-09-13");

  // his pay: weekly on Thursdays into Wells Fargo — and two June ATM deposits in Chase
  addSeries({
    id: PAY,
    name: "It America LLC (weekly pay)",
    kind: "income",
    cadence: "weekly",
    accountId: WF,
    amountCents: 114_192,
    lastMatchedOn: "2026-09-24",
    nextExpectedOn: "2026-10-01",
  });
  posted(CHASE, PAY, "2026-06-04", 100_000);
  posted(CHASE, PAY, "2026-06-05", 40_000);
  posted(WF, PAY, "2026-09-17", 114_192);
  posted(WF, PAY, "2026-09-24", 114_192);

  // Rocket Money: Chase Checking, last Jul 15 — Aug 15 falls after Chase's Aug 12
  addSeries({
    id: ROCKET,
    name: "Rocket Money",
    kind: "subscription",
    cadence: "monthly",
    accountId: CHASE,
    amountCents: -600,
    lastMatchedOn: "2026-07-15",
    nextExpectedOn: "2026-08-15",
    status: "detected",
  });
  posted(CHASE, ROCKET, "2026-06-15", -600);
  posted(CHASE, ROCKET, "2026-07-15", -600);

  // a bill on Chase with no account of its own, whose Oct 3 came due unposted: the forecast's arrears leg
  addSeries({
    id: UTILITY,
    name: "Utility",
    kind: "bill",
    cadence: "monthly",
    accountId: null,
    amountCents: -9_000,
    lastMatchedOn: "2026-08-03",
    nextExpectedOn: "2026-09-03",
  });
  posted(CHASE, UTILITY, "2026-07-03", -9_000);
  posted(CHASE, UTILITY, "2026-08-03", -9_000);

  // TRULY late: Venture X is checked through Sep 13, 57 days after Jul 18 against 48
  addSeries({
    id: LATE,
    name: "Streaming",
    kind: "subscription",
    cadence: "monthly",
    accountId: VX,
    amountCents: -1_599,
    lastMatchedOn: "2026-07-18",
    nextExpectedOn: "2026-08-18",
  });
  posted(VX, LATE, "2026-06-18", -1_599);
  posted(VX, LATE, "2026-07-18", -1_599);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("running late is said only of days the ledger has checked — every surface", () => {
  test("the All tab and every row label: listSeries' evidence", () => {
    const evidence = new Map(listSeries(bundle.db, TODAY).map((s) => [s.id, s.evidence]));
    expect(evidence.get(PAY)).toBe("awaiting-statements");
    expect(evidence.get(ROCKET)).toBe("awaiting-statements");
    expect(evidence.get(UTILITY)).toBe("awaiting-statements");
    expect(evidence.get(LATE)).toBe("running-late");
  });

  test("the series page's badge: seriesDetail's evidence", () => {
    expect(seriesDetail(bundle.db, PAY, TODAY).evidence).toBe("awaiting-statements");
    expect(seriesDetail(bundle.db, ROCKET, TODAY).evidence).toBe("awaiting-statements");
    expect(seriesDetail(bundle.db, LATE, TODAY).evidence).toBe("running-late");
  });

  test("the Upcoming list's chips and its footer count: upcomingOccurrences' staleness", () => {
    const bySeries = new Map(upcomingOccurrences(bundle.db, TODAY, 30).map((o) => [o.seriesId, o.staleness]));
    // the pay is looked for where it lands NOW — Wells Fargo's Sep 24, not Chase's Aug 12
    expect(bySeries.get(PAY)).toMatchObject({ isStale: false, awaitingStatements: true, checkedThrough: "2026-09-24" });
    expect(bySeries.get(ROCKET)).toMatchObject({ isStale: false, awaitingStatements: true, checkedThrough: "2026-08-12" });
    expect(bySeries.get(LATE)).toMatchObject({ isStale: true, awaitingStatements: false, checkedThrough: "2026-09-13" });
  });

  test("the forecast card's chips, MONEY IN/OUT band and footer: both legs' components", () => {
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const byLabel = (label: string) => f.components.filter((c) => c.label === label).map((c) => c.staleness);
    expect(byLabel("It America LLC (weekly pay)")).not.toHaveLength(0);
    for (const s of byLabel("It America LLC (weekly pay)")) expect(s).toMatchObject({ isStale: false, awaitingStatements: true });
    // forward AND arrears: Oct 3 came due and has not posted, on a day Chase has not been checked through
    const utility = f.components.filter((c) => c.label === "Utility");
    expect(utility.some((c) => c.detail.includes("came due"))).toBe(true);
    for (const c of utility) expect(c.staleness).toMatchObject({ isStale: false, awaitingStatements: true });
    for (const s of byLabel("Streaming")) expect(s).toMatchObject({ isStale: true, awaitingStatements: false });
    expect(byLabel("Streaming")).not.toHaveLength(0);
  });

  test("the calendar's words on a future entry: isStale", () => {
    const month = recurringCalendar(bundle.db, "2026-10", TODAY);
    const future = Object.entries(month.entriesByDay)
      .filter(([day]) => compareDates(day, TODAY) >= 0)
      .flatMap(([, entries]) => entries);
    const stale = (id: string) => future.filter((e) => e.seriesId === id).map((e) => e.isStale);
    expect(stale(PAY)).not.toHaveLength(0);
    expect(stale(PAY).every((s) => s === false)).toBe(true);
    expect(stale(LATE)).not.toHaveLength(0);
    expect(stale(LATE).every((s) => s === true)).toBe(true);
  });

  test("the runway's committed book carries the same reading", () => {
    const lines = new Map(committedBook(bundle.db, TODAY).lines.map((l) => [l.seriesId, l.isStale]));
    expect(lines.get(UTILITY)).toBe(false);
    expect(lines.get(LATE)).toBe(true);
  });
});

/**
 * 🔴 A series that names no account was measured against EVERY account it ever posted to. On a copy of his ledger
 * (2026-10-08) Flamingo South Beach (rent) posted on Venture X (Jun 16), Chase Checking (Jul 8), then Wells Fargo
 * (Aug 4, Sep 2): Wells Fargo is checked through Sep 24, but the rent's frontier came out as Chase's Aug 12 — and at
 * today = Oct 21 the Upcoming footer said "nothing has matched since Sep 2, 2026 (49 days), but its account has been
 * checked only through Aug 12, 2026" — a day before its own last charge, on an account it left. Where it posts NOW
 * is where its newest charge posted; a rent that truly misses on Wells Fargo's checked days must read late while
 * Chase lags.
 */
describe("a series with no account of its own is looked for where its newest charge posted", () => {
  const RENT = "series-rent";

  function rentThatMoved(): void {
    addSeries({
      id: RENT,
      name: "Flamingo South Beach (rent)",
      kind: "bill",
      cadence: "monthly",
      accountId: null,
      amountCents: -229_121,
      lastMatchedOn: "2026-09-02",
      nextExpectedOn: "2026-10-02",
    });
    posted(VX, RENT, "2026-06-16", -233_480);
    posted(CHASE, RENT, "2026-07-08", -228_570);
    posted(WF, RENT, "2026-08-04", -223_711);
    posted(WF, RENT, "2026-09-02", -229_121);
  }

  test("its frontier is Wells Fargo's Sep 24, not Chase's Aug 12 — and it cannot be called late yet", () => {
    rentThatMoved();
    const rent = upcomingOccurrences(bundle.db, "2026-10-21", 30).find((o) => o.seriesId === RENT);
    expect(rent?.staleness).toMatchObject({ checkedThrough: "2026-09-24", isStale: false, awaitingStatements: true });
  });

  test("a rent that truly missed on Wells Fargo's checked days reads late while Chase lags", () => {
    rentThatMoved();
    checkedThrough(WF, "2026-09-25", "2026-10-25");
    const evidence = new Map(listSeries(bundle.db, "2026-10-25").map((s) => [s.id, s.evidence]));
    expect(evidence.get(RENT)).toBe("running-late");
    expect(seriesDetail(bundle.db, RENT, "2026-10-25").evidence).toBe("running-late");
  });

  test("the landing accounts: the account it names, else every account its last two posting days posted to", () => {
    rentThatMoved();
    // two charges in a row on Wells Fargo: it moved there — Venture X and Chase are left behind
    expect([...(landingAccountsBySeries(bundle.db).get(RENT) ?? [])]).toEqual([WF]);
    // a series naming its account keeps it, whatever its old rows say (the 2026-10-07 rule)
    expect([...(landingAccountsBySeries(bundle.db).get(PAY) ?? [])]).toEqual([WF]);
    // ONE charge elsewhere is not a move (his $1,000 early insurance payment from Wells Fargo, the bill on Venture X):
    // it could land in either, so both are looked at — and the earlier frontier stands
    posted(CHASE, RENT, "2026-10-01", -229_121);
    expect(new Set(landingAccountsBySeries(bundle.db).get(RENT))).toEqual(new Set([WF, CHASE]));
    // every row of a day counts: a split payment on the newest day names both accounts
    posted(VX, RENT, "2026-10-01", -1_000);
    expect(new Set(landingAccountsBySeries(bundle.db).get(RENT))).toEqual(new Set([WF, CHASE, VX]));
  });
});

/**
 * 🔴 The state was decided by when the TOLERANCE runs out, but its words said the next charge had never been read:
 * "…checked only through Oct 13, 2026, inside the 43-day tolerance — so the ledger has not looked for the next one
 * yet", of the real Breezeline row (next expected Oct 11, on a checked day). And of his pay with Wells Fargo checked
 * through Oct 2 it said the ledger had not looked — while the passed-payday rule, beside it on /recurring, counts
 * Oct 1 as read. The gap opens whenever a statement covers the due day but not the end of the grace, which is
 * exactly when a real miss first shows: the words must be true on both sides of the due day.
 */
describe("a due day the ledger has checked is never called unread — the series cannot be called late YET", () => {
  test("the real Breezeline row, checked through Oct 13 at today = Oct 25", () => {
    // monthly, about every 27.33 days, last Sep 10: next expected Oct 11, tolerance 43.99 days
    const breezeline = {
      cadence: "monthly" as const,
      userCadence: null,
      intervalDaysAvg: 27.33,
      nextExpectedOn: "2026-10-11",
      userNextExpectedOn: null,
      nextExpectedAmountCents: -5_000,
      userAmountCents: null,
      lastMatchedOn: "2026-09-10",
    };
    const s = seriesStaleness(breezeline, "2026-10-25", "2026-10-13");
    expect(s).toMatchObject({ isStale: false, awaitingStatements: true });
    const sentence = stalenessSentence(s);
    expect(sentence).not.toContain("not looked for");
    expect(sentence).toContain("Oct 13, 2026 is the last day every account it posts to has been checked through");
    expect(sentence).toContain("33 of the 43 days its tolerance allows");
    expect(sentence).toContain("so it cannot be called late yet");
  });

  test("his pay with Wells Fargo checked through Oct 2: Oct 1 is read on both surfaces", () => {
    checkedThrough(WF, "2026-09-25", "2026-10-02");
    const unbanked = unbankedIncomeForSeries(bundle.db, new Set([PAY]), "2026-10-01", TODAY);
    // the passed-payday rule: Oct 1 is on or before the checked day, so it was read
    expect(unbanked.series[0]).toMatchObject({
      checkedThrough: "2026-10-02",
      occurrenceCount: 1,
      checkedOccurrenceCount: 1,
    });
    const pay = upcomingOccurrences(bundle.db, TODAY, 30).find((o) => o.seriesId === PAY)!.staleness!;
    expect(pay).toMatchObject({ isStale: false, awaitingStatements: true, checkedThrough: "2026-10-02" });
    expect(stalenessSentence(pay)).not.toContain("not looked for");
    expect(stalenessSentence(pay)).toContain("8 of the 12 days its tolerance allows");
  });
});
