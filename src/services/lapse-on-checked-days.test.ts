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
import { addDays, compareDates } from "@/lib/dates";
import { updateAccount } from "./accounts";
import { arrearsThisMonth } from "./arrears";
import { budgetPaceStatuses, createBudget } from "./budgets";
import { checkedThroughBySeries } from "./cash-earnings";
import { accountsAwaitingStatements } from "./cash-wallet-rule";
import { predictCategory } from "./category-forecast";
import { committedBook, runwayCard } from "./committed";
import { forecastCurrentMonth } from "./forecast";
import { listSeries, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";
import { recurringInsightInput } from "./recurring-insights";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * ⚖️ A series LAPSES — drops out of the forecast — only on days its accounts' statements have COVERED: measured to its
 * checked-through day, like running late, never to today across unread days (owner, 2026-10-08, §6A 57).
 *
 * 🔴 Measured on a copy of his ledger 2026-10-08, asking about 2026-12-07 with no new imports: the subscriptions card
 * filed the rent ($2,109.00), car lease ($695.04), car insurance ($357.58), Breezeline ($50.00), FPL and Rocket Money
 * under "stopped being forecast" ($3,281.48 a month), the 30-day Upcoming list kept three series, the runway's
 * committed bills fell from $3,452.25 to $467.69 a month, and /recurring's December forecast spent $282.21 where they
 * make $3,563.69. Nothing had stopped: Wells Fargo was read through Sep 24, Venture X through Sep 13, Chase Checking
 * through Aug 12.
 *
 * ⛔ The fixture is that shape — the same accounts read through the same days — and beside it a subscription whose card
 * IS read past three missed cycles (Venture X, quiet since Apr 25), which must lapse exactly as before, so no
 * assertion here can pass by nothing ever lapsing.
 */

let dir: string;
let bundle: DbBundle;
const OCT = "2026-10-08";
const DEC = "2026-12-07";
const WF = "acct-wf";
const VX = "acct-vx";
const CHASE = "acct-chase";
const RENT = "series-rent";
const LEASE = "series-lease";
const INSURANCE = "series-insurance";
const BREEZELINE = "series-breezeline";
const FPL = "series-fpl";
const ROCKET = "series-rocket";
const DEAD = "series-dead";
const GYM = "series-gym";
const PAY = "series-pay";
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

function categoryId(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

function addSeries(o: {
  id: string;
  name: string;
  kind: "income" | "bill" | "subscription";
  amountCents: number;
  lastMatchedOn: string | null;
  nextExpectedOn: string;
  categoryName?: string;
}): void {
  const weekly = o.kind === "income";
  bundle.db
    .insert(recurringSeries)
    .values({
      id: o.id,
      name: o.name,
      kind: o.kind,
      cadence: weekly ? "weekly" : "monthly",
      userCadence: weekly ? "weekly" : null,
      intervalDaysAvg: weekly ? 7 : 30,
      toleranceDays: 3,
      amountCentsAvg: o.amountCents,
      nextExpectedOn: o.nextExpectedOn,
      nextExpectedAmountCents: o.amountCents,
      lastMatchedOn: o.lastMatchedOn,
      userCategoryId: o.categoryName ? categoryId(o.categoryName) : null,
      status: "confirmed",
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-lapse-checked-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  for (const id of [WF, VX, CHASE]) addAccount(id);
  checkedThrough(WF, "2026-03-01", "2026-09-24");
  checkedThrough(VX, "2026-03-01", "2026-09-13");
  checkedThrough(CHASE, "2026-03-01", "2026-08-12");

  // Wells Fargo, read through Sep 24: the rent and the lease, last paid Sep 2
  addSeries({ id: RENT, name: "Rent", kind: "bill", amountCents: -210_900, lastMatchedOn: "2026-09-02", nextExpectedOn: "2026-10-01", categoryName: "Housing" });
  posted(WF, RENT, "2026-08-04", -210_900);
  posted(WF, RENT, "2026-09-02", -210_900);
  addSeries({ id: LEASE, name: "Car lease", kind: "bill", amountCents: -69_504, lastMatchedOn: "2026-09-02", nextExpectedOn: "2026-10-15", categoryName: "Transport" });
  posted(WF, LEASE, "2026-09-02", -69_504);

  // Venture X, read through Sep 13: the insurance and the internet
  addSeries({ id: INSURANCE, name: "Car insurance", kind: "bill", amountCents: -35_758, lastMatchedOn: "2026-09-03", nextExpectedOn: "2026-10-03" });
  posted(VX, INSURANCE, "2026-08-03", -35_758);
  posted(VX, INSURANCE, "2026-09-03", -35_758);
  addSeries({ id: BREEZELINE, name: "Breezeline", kind: "bill", amountCents: -5_000, lastMatchedOn: "2026-09-10", nextExpectedOn: "2026-10-10", categoryName: "Utilities" });
  posted(VX, BREEZELINE, "2026-08-10", -5_000);
  posted(VX, BREEZELINE, "2026-09-10", -5_000);

  // Chase Checking, read through Aug 12: electricity and Rocket Money
  addSeries({ id: FPL, name: "FPL", kind: "bill", amountCents: -5_887, lastMatchedOn: "2026-07-28", nextExpectedOn: "2026-08-28" });
  posted(CHASE, FPL, "2026-06-28", -5_887);
  posted(CHASE, FPL, "2026-07-28", -5_887);
  addSeries({ id: ROCKET, name: "Rocket Money", kind: "subscription", amountCents: -600, lastMatchedOn: "2026-07-15", nextExpectedOn: "2026-08-15" });
  posted(CHASE, ROCKET, "2026-06-15", -600);
  posted(CHASE, ROCKET, "2026-07-15", -600);

  // TRULY stopped: Venture X is read through Sep 13, 141 days after Apr 25 against a 93-day lapse line
  addSeries({ id: DEAD, name: "Dead streaming", kind: "subscription", amountCents: -1_599, lastMatchedOn: "2026-04-25", nextExpectedOn: "2026-05-25" });
  posted(VX, DEAD, "2026-03-25", -1_599);
  posted(VX, DEAD, "2026-04-25", -1_599);

  // a commitment registered by hand, never billed; and his pay — neither can lapse
  addSeries({ id: GYM, name: "Gym", kind: "bill", amountCents: -10_000, lastMatchedOn: null, nextExpectedOn: "2026-10-22" });
  addSeries({ id: PAY, name: "Weekly pay", kind: "income", amountCents: 114_192, lastMatchedOn: "2026-06-04", nextExpectedOn: "2026-06-11" });
  posted(WF, PAY, "2026-05-28", 114_192);
  posted(WF, PAY, "2026-06-04", 114_192);

  for (const name of ["Housing", "Transport", "Utilities"]) {
    createBudget(bundle.db, { categoryId: categoryId(name), period: "monthly", amountCents: 300_000, startsOn: "2026-01-01" });
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const STILL_FORECAST = [RENT, LEASE, INSURANCE, BREEZELINE, FPL, ROCKET];

describe("a series lapses only on days the ledger has checked — every surface (§6A 57)", () => {
  test.each([OCT, DEC])("%s: the Upcoming list carries every bill its statements have not shown missing", (today) => {
    // 70 days reaches every monthly bill at least once, however far into the month the question is asked
    const ids = new Set(upcomingOccurrences(bundle.db, today, 70).map((o) => o.seriesId));
    for (const id of [...STILL_FORECAST, GYM, PAY]) expect(ids.has(id), `${today} · ${id}`).toBe(true);
    expect(ids.has(DEAD)).toBe(false);
  });

  test.each([OCT, DEC])("%s: the subscriptions card stops forecasting only what a read statement shows stopped", (today) => {
    const card = subscriptionsCard(bundle.db, today)!;
    expect(card.lapsed.map((l) => l.seriesId)).toEqual([DEAD]);
    const live = new Set(card.live.map((l) => l.seriesId));
    for (const id of [...STILL_FORECAST, GYM]) expect(live.has(id), `${today} · ${id}`).toBe(true);
  });

  test("the subscriptions card's days past tolerance count read days only — they cannot grow between uploads", () => {
    // Apr 25 → Sep 14 (the day after Venture X's checked Sep 13) is 142 days, against the 48-day tolerance
    for (const today of [OCT, DEC]) {
      expect(subscriptionsCard(bundle.db, today)!.lapsed[0]!.daysPastTolerance, today).toBe(142 - 48);
    }
  });

  test.each([OCT, DEC])("%s: the runway's committed book keeps every bill, and its arrears walk asks the same", (today) => {
    const book = committedBook(bundle.db, today);
    const lines = new Set(book.lines.map((l) => l.seriesId));
    for (const id of [RENT, LEASE, INSURANCE, BREEZELINE, FPL, ROCKET, GYM]) expect(lines.has(id), `${today} · ${id}`).toBe(true);
    expect(lines.has(DEAD)).toBe(false);
    expect(new Set(runwayCard(bundle.db, today).committed.lines.map((l) => l.seriesId))).toEqual(lines);
  });

  test("his December: the rent, lease, insurance and internet are still committed bills, $3,211.62 a month of them", () => {
    const book = committedBook(bundle.db, DEC);
    const horizon = new Map(book.lines.map((l) => [l.seriesId, l.totalCents]));
    // a bill a month each, every month of the horizon
    expect(horizon.get(RENT)).toBe(book.months * 210_900);
    expect(horizon.get(LEASE)).toBe(book.months * 69_504);
    expect(horizon.get(INSURANCE)).toBe(book.months * 35_758);
    expect(horizon.get(BREEZELINE)).toBe(book.months * 5_000);
    const perMonth = [RENT, LEASE, INSURANCE, BREEZELINE].reduce((sum, id) => sum + horizon.get(id)! / book.months, 0);
    expect(perMonth).toBe(321_162);
  });

  test.each([OCT, DEC])("%s: the All tab and the series page project them and name the wait, not the lapse", (today) => {
    const listed = new Map(listSeries(bundle.db, today).map((s) => [s.id, s]));
    for (const id of STILL_FORECAST) {
      expect(listed.get(id)!.evidence, `${today} · ${id}`).not.toBe("lapsed");
      expect(listed.get(id)!.nextExpectedOn, `${today} · ${id}`).not.toBeNull();
      const page = seriesDetail(bundle.db, id, today);
      expect(page.evidence, `${today} · ${id}`).not.toBe("lapsed");
      // its own page still projects it: "Next expected" and a year of it
      expect(page.nextExpected.length, `${today} · ${id}`).toBeGreaterThan(0);
      expect(page.annualizedCents, `${today} · ${id}`).not.toBeNull();
      expect(listed.get(id)!.annualizedCents, `${today} · ${id}`).not.toBeNull();
    }
    expect(listed.get(DEAD)!.evidence).toBe("lapsed");
    expect(listed.get(DEAD)!.nextExpectedOn).toBeNull();
    expect(seriesDetail(bundle.db, DEAD, today).nextExpected).toEqual([]);
  });

  test("December's month forecast, calendar, budgets and January's category forecast carry them too", () => {
    const fixed = new Set(forecastCurrentMonth(bundle.db, DEC).components.filter((c) => c.kind === "fixed").map((c) => c.label));
    for (const name of ["Car lease", "Car insurance", "Breezeline", "FPL", "Rocket Money"]) expect(fixed.has(name), name).toBe(true);
    expect(fixed.has("Dead streaming")).toBe(false);

    const drawn = new Set(
      Object.values(recurringCalendar(bundle.db, "2026-12", DEC).entriesByDay)
        .flat()
        .filter((e) => e.state === "upcoming")
        .map((e) => e.seriesId),
    );
    for (const id of [LEASE, BREEZELINE, FPL, ROCKET]) expect(drawn.has(id), id).toBe(true);
    expect(drawn.has(DEAD)).toBe(false);

    const tails = new Set(budgetPaceStatuses(bundle.db, DEC).flatMap((b) => b.tail.map((t) => t.id)));
    expect(tails.has(LEASE)).toBe(true);
    expect(tails.has(BREEZELINE)).toBe(true);

    expect(predictCategory(bundle.db, categoryId("Housing"), "Housing", DEC).forecast.recurringCents).toBe(210_900);
  });

  test("the series page's insights still rank the rent among his live commitments in December", () => {
    expect(recurringInsightInput(bundle.db, RENT, DEC)).not.toBeNull();
    expect(recurringInsightInput(bundle.db, DEAD, DEC)).toBeNull();
  });

  test("read past the missed days, the same bills DO lapse — the rule moved the measuring day, not the line", () => {
    // Wells Fargo read through Dec 6: the rent missed Oct 1 and Nov 1, the lease Oct 15 and Nov 15, on read statements
    checkedThrough(WF, "2026-09-25", "2026-12-06");
    const card = subscriptionsCard(bundle.db, DEC)!;
    expect(new Set(card.lapsed.map((l) => l.seriesId))).toEqual(new Set([RENT, LEASE, DEAD]));
    const ids = new Set(upcomingOccurrences(bundle.db, DEC, 70).map((o) => o.seriesId));
    expect(ids.has(RENT)).toBe(false);
    expect(ids.has(LEASE)).toBe(false);
  });
});

/**
 * ⚖️ An account NO STATEMENT WILL EVER COME FOR — archived, or a cash wallet (`accountsAwaitingStatements`) — does not
 * hold the lapse back: its series are measured to today, as every series was before §6A 57 (2026-10-08, review of
 * 98acbeb). His rule is that an upload arriving late can never make a bill vanish; for these none is coming.
 *
 * ⚠️ A LIVE account with no checked record still holds its series where nothing has been read: a statement can still
 * come for it, and the income card, the passed paydays and /spending's reading say so in words (their own tests).
 *
 * 🔴 Read to the archived card's frozen checked day (98acbeb), every series on it still inside its line was forecast
 * for good as "Awaiting statements": Breezeline (Venture X, last Sep 10) read so on 2026-12-07, and the car insurance
 * stayed a committed bill and $357.58 of the runway's arrears every month, a year on. …and a series that ALSO charged
 * on a live card was pinned to the archived card's day however far the live card was read.
 */
describe("an account no statement will ever come for does not hold the lapse back", () => {
  const NOV = "2026-11-08";
  const YEAR_ON = "2027-10-08";
  const ON_VX = [INSURANCE, BREEZELINE, DEAD];

  /** A cash wallet by the one rule (`cashWalletIds`): under the "Cash" institution, nothing imported. */
  function addWallet(id: string): void {
    bundle.db.insert(institutions).values({ name: "Cash" }).onConflictDoNothing().run();
    const cash = bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).get()!.id;
    addAccount(id);
    bundle.db.update(accounts).set({ institutionId: cash }).where(eq(accounts.id, id)).run();
  }

  /** What every lapse surface says of Venture X's series on `today`. */
  function readingOfVentureX(today: string) {
    const card = subscriptionsCard(bundle.db, today)!;
    const listed = new Map(listSeries(bundle.db, today).map((s) => [s.id, s]));
    const upcoming = new Set(upcomingOccurrences(bundle.db, today, 70).map((o) => o.seriesId));
    const book = new Set(committedBook(bundle.db, today).lines.map((l) => l.seriesId));
    return ON_VX.map((id) => ({
      id,
      evidence: listed.get(id)!.evidence,
      next: listed.get(id)!.nextExpectedOn,
      pastTolerance: card.lapsed.find((l) => l.seriesId === id)?.daysPastTolerance ?? null,
      upcoming: upcoming.has(id),
      committed: book.has(id),
    }));
  }

  test("an archived card's series lapse on the day they would with the card read through today", () => {
    updateAccount(bundle.db, VX, { isActive: false });
    const archived = [OCT, NOV, DEC].map(readingOfVentureX);

    updateAccount(bundle.db, VX, { isActive: true });
    let through = "2026-09-13";
    const readToToday = [OCT, NOV, DEC].map((today) => {
      checkedThrough(VX, addDays(through, 1), today);
      through = today;
      return readingOfVentureX(today);
    });

    expect(archived).toEqual(readToToday);
    // …and they do lapse: the insurance by December (Sep 3, 95 quiet days against its 93), the subscription all along
    const december = new Map(archived[2]!.map((r) => [r.id, r.evidence]));
    expect(december).toEqual(new Map([[INSURANCE, "lapsed"], [BREEZELINE, "running-late"], [DEAD, "lapsed"]]));
  });

  test.each([OCT, NOV, DEC, YEAR_ON])("%s: an archived card's series never read 'Awaiting statements'", (today) => {
    updateAccount(bundle.db, VX, { isActive: false });
    const listed = new Map(listSeries(bundle.db, today).map((s) => [s.id, s.evidence]));
    for (const id of ON_VX) expect(listed.get(id), id).not.toBe("awaiting-statements");
    expect(checkedThroughBySeries(bundle.db, today)(BREEZELINE)).toBe(today);
  });

  test("a series that charged on an archived card AND a live one is measured by the live card's checked day", () => {
    const MOVED = "series-moved";
    addSeries({ id: MOVED, name: "Moved streaming", kind: "subscription", amountCents: -2_000, lastMatchedOn: "2026-07-20", nextExpectedOn: "2026-08-20" });
    posted(VX, MOVED, "2026-06-20", -2_000);
    posted(WF, MOVED, "2026-07-20", -2_000);
    updateAccount(bundle.db, VX, { isActive: false });

    // Wells Fargo, read through Sep 24: 67 quiet read days — late, inside its 93-day line
    expect(checkedThroughBySeries(bundle.db, DEC)(MOVED)).toBe("2026-09-24");
    expect(listSeries(bundle.db, DEC).find((s) => s.id === MOVED)!.evidence).toBe("running-late");

    // read through Dec 6, it lapses — never pinned to the archived card's Sep 13
    checkedThrough(WF, "2026-09-25", "2026-12-06");
    expect(checkedThroughBySeries(bundle.db, DEC)(MOVED)).toBe("2026-12-06");
    expect(subscriptionsCard(bundle.db, DEC)!.lapsed.some((l) => l.seriesId === MOVED)).toBe(true);
    expect(upcomingOccurrences(bundle.db, DEC, 70).some((o) => o.seriesId === MOVED)).toBe(false);

    // …and with no card it posts to left to read, to today
    updateAccount(bundle.db, WF, { isActive: false });
    expect(checkedThroughBySeries(bundle.db, DEC)(MOVED)).toBe(DEC);
  });

  test("a series naming an account no statement will come for is measured to today", () => {
    bundle.db.update(recurringSeries).set({ accountId: VX }).where(eq(recurringSeries.id, RENT)).run();
    expect(checkedThroughBySeries(bundle.db, DEC)(RENT)).toBe("2026-09-13");
    updateAccount(bundle.db, VX, { isActive: false });
    // it names where it lands now, so its Wells Fargo history does not stand in for it
    expect(checkedThroughBySeries(bundle.db, DEC)(RENT)).toBe(DEC);
  });

  test("a cash wallet's series is measured to today — what he typed is all that will ever come", () => {
    // its days walked checked, so only the wallet rule can keep them from holding the series back
    const WALLET = "acct-wallet";
    addWallet(WALLET);
    checkedThrough(WALLET, "2026-03-01", "2026-07-31");
    const CASH_BILL = "series-cash-bill";
    addSeries({ id: CASH_BILL, name: "Parking, paid in cash", kind: "bill", amountCents: -10_000, lastMatchedOn: "2026-07-01", nextExpectedOn: "2026-08-01" });
    posted(WALLET, CASH_BILL, "2026-06-01", -10_000);
    posted(WALLET, CASH_BILL, "2026-07-01", -10_000);

    for (const today of [OCT, DEC]) expect(checkedThroughBySeries(bundle.db, today)(CASH_BILL), today).toBe(today);
    // read to today it lapses like any series: Jul 1 to Oct 8 is 99 quiet days, against its 93
    expect(listSeries(bundle.db, OCT).find((s) => s.id === CASH_BILL)!.evidence).toBe("lapsed");
    expect(listSeries(bundle.db, "2026-09-01").find((s) => s.id === CASH_BILL)!.evidence).toBe("running-late");
  });

  test("the runway's arrears stop owing an archived card's bill once it lapses — never every month for good", () => {
    updateAccount(bundle.db, VX, { isActive: false });
    // October: the insurance's Oct 3 is 35 days after its Sep 3, inside its line — owed, as read through today
    expect(arrearsThisMonth(bundle.db, new Set([INSURANCE]), OCT).totalCents).toBe(35_758);
    for (const today of [DEC, YEAR_ON]) {
      expect(arrearsThisMonth(bundle.db, new Set([INSURANCE]), today).totalCents, today).toBe(0);
      const book = runwayCard(bundle.db, today).committed;
      expect(book.lines.some((l) => l.seriesId === INSURANCE), today).toBe(false);
    }
  });

  test("the accounts a statement is still coming for: not archived, not a cash wallet", () => {
    addWallet("acct-wallet");
    updateAccount(bundle.db, CHASE, { isActive: false });
    expect(accountsAwaitingStatements(bundle.db)).toEqual(new Set([WF, VX]));
  });
});
