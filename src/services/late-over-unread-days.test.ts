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
import { committedBook } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { listSeries, upcomingOccurrences } from "./recurring";
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
    expect(evidence.get(PAY)).toBe("not-looked-for");
    expect(evidence.get(ROCKET)).toBe("not-looked-for");
    expect(evidence.get(UTILITY)).toBe("not-looked-for");
    expect(evidence.get(LATE)).toBe("running-late");
  });

  test("the series page's badge: seriesDetail's evidence", () => {
    expect(seriesDetail(bundle.db, PAY, TODAY).evidence).toBe("not-looked-for");
    expect(seriesDetail(bundle.db, ROCKET, TODAY).evidence).toBe("not-looked-for");
    expect(seriesDetail(bundle.db, LATE, TODAY).evidence).toBe("running-late");
  });

  test("the Upcoming list's chips and its footer count: upcomingOccurrences' staleness", () => {
    const bySeries = new Map(upcomingOccurrences(bundle.db, TODAY, 30).map((o) => [o.seriesId, o.staleness]));
    // the pay is looked for where it lands NOW — Wells Fargo's Sep 24, not Chase's Aug 12
    expect(bySeries.get(PAY)).toMatchObject({ isStale: false, notLookedFor: true, checkedThrough: "2026-09-24" });
    expect(bySeries.get(ROCKET)).toMatchObject({ isStale: false, notLookedFor: true, checkedThrough: "2026-08-12" });
    expect(bySeries.get(LATE)).toMatchObject({ isStale: true, notLookedFor: false, checkedThrough: "2026-09-13" });
  });

  test("the forecast card's chips, MONEY IN/OUT band and footer: both legs' components", () => {
    const f = forecastCurrentMonth(bundle.db, TODAY);
    const byLabel = (label: string) => f.components.filter((c) => c.label === label).map((c) => c.staleness);
    expect(byLabel("It America LLC (weekly pay)")).not.toHaveLength(0);
    for (const s of byLabel("It America LLC (weekly pay)")) expect(s).toMatchObject({ isStale: false, notLookedFor: true });
    // forward AND arrears: Oct 3 came due and has not posted, on a day Chase has not been checked through
    const utility = f.components.filter((c) => c.label === "Utility");
    expect(utility.some((c) => c.detail.includes("came due"))).toBe(true);
    for (const c of utility) expect(c.staleness).toMatchObject({ isStale: false, notLookedFor: true });
    for (const s of byLabel("Streaming")) expect(s).toMatchObject({ isStale: true, notLookedFor: false });
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
