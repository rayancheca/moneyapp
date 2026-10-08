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
import { forecastSplit } from "@/lib/forecast-split";
import { arrearsSentence } from "@/lib/committed";
import { stalePartLabel, staleSummaryLabel, upcomingEvidenceWord } from "@/components/recurring/labels";
import { arrearsThisMonth } from "./arrears";
import { billingCarriers } from "./billing-carriers";
import { budgetOverdue, budgetTail } from "./budgets";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { committedBook } from "./committed";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";
import { provenanceFor } from "./provenance";
import { hasStoppedForecasting, listSeries, seriesEvidence, upcomingOccurrences } from "./recurring";
import { recurringCalendar, type CalendarEntry } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";
import { recurringInsightInput } from "./recurring-insights";
import { mergeSeries } from "./recurring-links";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * ⚖️ His decision 59 (2026-10-08): `Rent utilities & fees` ($182.21 a month, registered by hand, never linked to a
 * posting) is paid INSIDE the rent payment — Sep 2 $2,291.21 = rent $2,109.00 + $182.21; earlier $2,285.70,
 * $2,237.11, $1,100 + $1,334.80. It reads BILLED WITH THE RENT ("billed with the rent, last seen Sep 2") and leaves
 * every never-billed figure; its amount, the forecast and the arrears stay as they are.
 *
 * The fixture is his shape: the rent (confirmed, $2,109.00 on the 1st, last posted Sep 2), the utilities (confirmed,
 * $182.21 on the 1st, never posted) and a gym that really has never been billed — the control.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const TODAY = "2026-10-08";
const RENT = "rent";
const UTIL = "util";
const GYM = "gym";

const now = () => new Date().toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-billed-with-"));
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
  categoryId = bundle.db.select().from(categories).all()[0]!.id;
  const series = (id: string, name: string, cents: number, nextOn: string, lastMatchedOn: string | null) => ({
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
      { ...series(RENT, "Flamingo South Beach (rent)", -210900, "2026-09-01", "2026-09-02"), accountId: "acct" },
      series(UTIL, "Rent utilities & fees", -18221, "2026-09-01", null),
      { ...series(GYM, "Gym", -10000, "2026-10-22", null), anchorDay: null },
    ])
    .run();
  const charge = (id: string, postedOn: string, cents: number) => ({
    id,
    accountId: "acct",
    postedOn,
    amountCents: cents,
    rawDescription: "FLAMINGO SOUTH BEACH",
    normalizedDescription: "FLAMINGO SOUTH BEACH",
    categoryId,
    recurringSeriesId: RENT,
    status: "active" as const,
    needsReview: false,
    occurrenceIndex: 0,
    dedupeHash: `h-${id}`,
    createdAt: now(),
    updatedAt: now(),
  });
  bundle.db
    .insert(transactions)
    .values([charge("t-aug", "2026-08-03", -228570), charge("t-sep", "2026-09-02", -229121)])
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** His one write: the utilities are billed with the rent. */
function link(): void {
  bundle.db.update(recurringSeries).set({ userBilledWithSeriesId: RENT }).where(eq(recurringSeries.id, UTIL)).run();
}

/**
 * The rent's account read through `to` — days the balance walk has read, what `accountCoverage` grades checked. Late
 * and lapsed are claims about READ days (§6A 57): with nothing read, the rent and what is billed inside it are both
 * only "Awaiting statements".
 */
function readRentAccountThrough(to: string): void {
  for (let day = "2026-08-01"; compareDates(day, to) <= 0; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: "acct", day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

describe("the link — one nullable column, one reader", () => {
  test("billingCarriers names each carried series' carrier, and nothing else", () => {
    expect(billingCarriers(bundle.db).size).toBe(0);
    link();
    const carriers = billingCarriers(bundle.db);
    expect([...carriers.keys()]).toEqual([UTIL]);
    expect(carriers.get(UTIL)).toEqual({ id: RENT, name: "Flamingo South Beach (rent)", lastMatchedOn: "2026-09-02" });
  });

  test("the column refuses a carrier that does not exist", () => {
    expect(() =>
      bundle.db.update(recurringSeries).set({ userBilledWithSeriesId: "nope" }).where(eq(recurringSeries.id, UTIL)).run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("the Subscriptions card", () => {
  test("his line reads billed with the rent, last seen Sep 2 — not never billed", () => {
    const before = subscriptionsCard(bundle.db, TODAY)!.live.find((l) => l.seriesId === UTIL)!;
    expect(before.neverBilled).toBe(true);
    expect(before.billedWithLabel).toBeNull();

    link();
    const line = subscriptionsCard(bundle.db, TODAY)!.live.find((l) => l.seriesId === UTIL)!;
    expect(line.neverBilled).toBe(false);
    expect(line.billedWithLabel).toBe("billed with the rent, last seen Sep 2");
    expect(line.lastMatchedLabel).toBe("Sep 2");
    // ⛔ its amount stays: still $182.21 a month, still forecast
    expect(line.monthlyCents).toBe(18221);
  });

  test("the never-billed footnote leaves it out — the gym alone stays", () => {
    const before = subscriptionsCard(bundle.db, TODAY)!;
    expect(before.neverBilledMonthlyCents).toBe(18221 + 10000);
    link();
    const after = subscriptionsCard(bundle.db, TODAY)!;
    expect(after.neverBilledMonthlyCents).toBe(10000);
    // the headline is the same money: the figure is what is forecast, not what is evidenced
    expect(after.liveMonthlyCents).toBe(before.liveMonthlyCents);
  });
});

describe("/recurring — the All tab, the bands and footers, the calendar", () => {
  test("the All tab files it under Active and carries its carrier; the gym stays Never billed", () => {
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === UTIL)!.evidence).toBe("never-billed");
    link();
    const rows = listSeries(bundle.db, TODAY);
    const util = rows.find((s) => s.id === UTIL)!;
    expect(util.evidence).toBe("active");
    expect(util.billedWith).toEqual({ id: RENT, name: "Flamingo South Beach (rent)", lastMatchedOn: "2026-09-02" });
    // ⛔ its own column is untouched — the link lends evidence, it writes no posting
    expect(util.lastMatchedOn).toBeNull();
    expect(util.matchedCount).toBe(0);
    expect(rows.find((s) => s.id === GYM)!.evidence).toBe("never-billed");
    expect(rows.find((s) => s.id === GYM)!.billedWith).toBeNull();
  });

  test("the money-out band and the footer stop counting it never billed — the gym alone", () => {
    const band = () => {
      const f = forecastCurrentMonth(bundle.db, TODAY);
      const split = forecastSplit(
        f.components.map((c) => ({
          kind: c.kind,
          cents: c.cents,
          isStale: c.staleness?.isStale,
          neverCharged: c.staleness?.daysSinceLastMatch === null,
        })),
      );
      return { f, part: stalePartLabel(split.spending) };
    };
    const before = band();
    expect(before.part).toBe("$282.21 of it never billed");
    link();
    const after = band();
    expect(after.part).toBe("$100.00 of it never billed");

    const up = upcomingOccurrences(bundle.db, TODAY, 30);
    const stale = up.filter((o) => o.staleness?.isStale).map((o) => ({ key: o.seriesId, name: o.name, staleness: o.staleness! }));
    expect(staleSummaryLabel(stale, "In the next 30 days")).toBe("In the next 30 days, 1 series has never been billed — still projected");
  });

  test("⛔ the forecast is unchanged to the cent — every line, every total", () => {
    const shape = () => {
      const f = forecastCurrentMonth(bundle.db, TODAY);
      return {
        lines: f.components.map((c) => [c.label, c.kind, c.cents, c.detail]),
        spend: f.projectedSpendCents,
        income: f.projectedIncomeCents,
      };
    };
    const upcoming = () => upcomingOccurrences(bundle.db, TODAY, 60).map((o) => [o.seriesId, o.date, o.amountCents]);
    const before = { forecast: shape(), upcoming: upcoming() };
    link();
    expect({ forecast: shape(), upcoming: upcoming() }).toEqual(before);
  });

  /*
   * ⚖️ The arrears' AMOUNTS are unchanged by the link; whether an occurrence is settled follows the carrier (§6A 59 as
   * implied 2026-10-08 — see "settlement follows the carrier" below). The rent has not posted Oct 1, so its Oct 1 is
   * still owed — at its own $182.21 — and on the same reading as the rent's: nothing has read the rent's account past
   * Sep 2, so both are unread. Where the rent HAS paid, the utilities leave the arrears with it (below).
   */
  test("⛔ the arrears' money is unchanged — the rent has not posted Oct 1, so neither has what is billed inside it", () => {
    const ids = new Set([RENT, UTIL, GYM]);
    const before = arrearsThisMonth(bundle.db, ids, TODAY);
    expect(before.series.map((s) => s.id)).toContain(UTIL);
    link();
    const after = arrearsThisMonth(bundle.db, ids, TODAY);
    expect(after.totalCents).toBe(before.totalCents);
    expect(after.series.map((s) => [s.id, s.nextDate, s.amountCents, s.occurrenceCents])).toEqual(
      before.series.map((s) => [s.id, s.nextDate, s.amountCents, s.occurrenceCents]),
    );
    // read exactly as far as the rent is: the rent's account, never "no account at all"
    const unread = (id: string) => after.series.find((s) => s.id === id)!.unreadCents;
    expect(unread(UTIL)).toBe(18221);
    expect(unread(RENT)).toBe(210900);
  });

  test("the calendar's upcoming entry says billed with the rent, not never billed; its past entry follows the rent's", () => {
    const entries = (month: string) =>
      Object.values(recurringCalendar(bundle.db, month, TODAY).entriesByDay)
        .flat()
        .filter((e) => e.seriesId === UTIL);
    const octBefore = entries("2026-10");
    expect(entries("2026-11")[0]!.neverBilled).toBe(true);
    link();
    const nov = entries("2026-11")[0]!;
    expect(nov.neverBilled).toBe(false);
    expect(nov.isStale).toBe(false);
    expect(nov.billedWith).toBe("billed with the rent");
    expect(upcomingEvidenceWord(nov)).toBe("billed with the rent");
    expect(nov.amountCents).toBe(-18221);
    // the past follows the rent: no payment of its has posted for Oct 1 and nothing has read past Sep 2 — not yet known
    expect(entries("2026-10").map((e) => [e.state, e.amountCents, e.unsettledReason, e.billedWith, e.paidWith])).toEqual(
      octBefore.map((e) => [e.state, e.amountCents, e.unsettledReason, null, null]),
    );
  });
});

describe("its page, and the committed lines", () => {
  test("the series page carries the carrier and reads active", () => {
    expect(seriesDetail(bundle.db, UTIL, TODAY).evidence).toBe("never-billed");
    link();
    const d = seriesDetail(bundle.db, UTIL, TODAY);
    expect(d.evidence).toBe("active");
    expect(d.billedWith).toEqual({ id: RENT, name: "Flamingo South Beach (rent)", lastMatchedOn: "2026-09-02" });
    expect(seriesDetail(bundle.db, RENT, TODAY).billedWith).toBeNull();
  });

  /*
   * ⛔ "Never billed" in other words is still never billed. 🔴 On a copy of his ledger with the link set (2026-10-08)
   * his page's chip read "billed with the rent, last seen Sep 2" while its Per charge popover — and both insight
   * popovers, "3rd largest of your 13 scheduled commitments" and "5.3% of what your scheduled commitments cost", which
   * cite the same proof — read "Nothing tagged to it has ever posted, so there is no evidence behind it at all."
   */
  test("its amount popover and its insights' proof say billed with the rent — never 'no evidence behind it'", () => {
    const amountProof = () => provenanceFor(bundle.db, { kind: "recurringSeries", id: UTIL, today: TODAY })!;
    expect(amountProof().headline).toContain("no evidence behind it at all");
    link();
    const headline = amountProof().headline;
    expect(headline).not.toContain("no evidence");
    expect(headline).not.toContain("ever posted");
    expect(headline).toContain("billed with the rent, last seen Sep 2");
    // ⛔ his amount, still his: the verdict and the source he set
    expect(amountProof().verdict).toBe("manual");
    expect(amountProof().sources.map((s) => s.label)).toContain("you set this to -$182.21");
    // the insights cite this same proof
    const input = recurringInsightInput(bundle.db, UTIL, TODAY)!;
    expect(input.candidates.length).toBeGreaterThan(0);
    for (const c of input.candidates) expect(c.prove()!.headline).toBe(headline);
    // the gym, never billed, still says so
    const gym = provenanceFor(bundle.db, { kind: "recurringSeries", id: GYM, today: TODAY })!.headline;
    expect(gym).toContain("no evidence behind it at all");
  });

  /* a carrier the bank has never billed lends nothing — the sentence says that, as the card's label does */
  test("billed with a rent that has never been billed: its popover says so, and that nothing stands behind it", () => {
    bundle.db.update(recurringSeries).set({ lastMatchedOn: null }).where(eq(recurringSeries.id, RENT)).run();
    link();
    const headline = provenanceFor(bundle.db, { kind: "recurringSeries", id: UTIL, today: TODAY })!.headline;
    expect(headline).toContain("billed with the rent, which has never been billed");
    expect(headline).toContain("no evidence behind it at all");
  });

  test("the committed book's line is evidenced, and leaves the unevidenced figure", () => {
    const util = () => committedBook(bundle.db, TODAY).lines.find((l) => l.seriesId === UTIL)!;
    const before = committedBook(bundle.db, TODAY);
    expect(util().neverPosted).toBe(true);
    link();
    const after = committedBook(bundle.db, TODAY);
    expect(util().neverPosted).toBe(false);
    expect(after.unevidencedCents).toBe(before.unevidencedCents - util().totalCents);
    // ⛔ the money is the same money
    expect(after.totalCents).toBe(before.totalCents);
    expect(after.lines.map((l) => [l.seriesId, l.totalCents, l.overdueCents])).toEqual(
      before.lines.map((l) => [l.seriesId, l.totalCents, l.overdueCents]),
    );
  });
});

describe("the evidence is the carrier's — whatever the carrier's is", () => {
  test("a carrier the bank has never billed lends nothing: still never billed", () => {
    bundle.db.update(recurringSeries).set({ lastMatchedOn: null }).where(eq(recurringSeries.id, RENT)).run();
    link();
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === UTIL)!.evidence).toBe("never-billed");
    const line = subscriptionsCard(bundle.db, TODAY)!.live.find((l) => l.seriesId === UTIL)!;
    expect(line.neverBilled).toBe(true);
    expect(line.billedWithLabel).toBe("billed with the rent, which has never been billed");
  });

  test("a rent running late makes it late too — and when the rent lapses, so does what is billed inside it", () => {
    link();
    const util = (today: string) => listSeries(bundle.db, today).find((s) => s.id === UTIL)!;
    const rent = (today: string) => listSeries(bundle.db, today).find((s) => s.id === RENT)!;
    // ⚖️ nothing read on the rent's account: past tolerance on unread days, both only await statements (§6A 57)
    expect(rent("2026-10-21").evidence).toBe("awaiting-statements");
    expect(util("2026-10-21").evidence).toBe("awaiting-statements");
    readRentAccountThrough("2026-12-05");
    // 30 × 1.5 + 3 = 48 days after Sep 2 is Oct 20: running late from Oct 21
    expect(util("2026-10-20").evidence).toBe("active");
    expect(util("2026-10-21").evidence).toBe("running-late");
    // 30 × 3 + 3 = 93 days after Sep 2 is Dec 4: lapsed — the forecast lets both go on one day
    const row = (today: string) => ({ ...bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, UTIL)).get()!, billedWith: billingCarriers(bundle.db).get(UTIL) ?? null, today });
    // …measured to the day its evidence is read through — the rent's accounts' (§6A 57 composed with §6A 59)
    const checked = (today: string) => silenceMeasuredThroughBySeries(bundle.db, today)(UTIL);
    expect(checked("2026-12-05")).toBe(silenceMeasuredThroughBySeries(bundle.db, "2026-12-05")(RENT));
    expect(seriesEvidence(row("2026-12-05"), "2026-12-05", checked("2026-12-05"))).toBe("lapsed");
    expect(hasStoppedForecasting(row("2026-12-05"), "2026-12-05", checked("2026-12-05"))).toBe(true);
    expect(hasStoppedForecasting(row("2026-12-04"), "2026-12-04", checked("2026-12-04"))).toBe(false);
  });
});

/*
 * 🔴 A merge of the carrier froze what is billed inside it (review of §6A 59, 2026-10-08). `mergeSeries` ends the
 * source and recomputes only the target, and the link still named the ended source — whose `last_matched_on` stays
 * at its last posting while every newer rent posts under the target. Detection makes a series of the Wells Fargo
 * rows, he merges the rent into it, the rent keeps posting — and 93 days after Sep 2 the utilities read "lapsed" and
 * left the forecast, the committed book, the arrears and the card's live figure, with nothing for him to see or do.
 */
describe("a merge of the carrier — the link follows the rent to the series it was merged into", () => {
  const WF = "wf-rent";
  const TODAY_DEC = "2026-12-05";

  /** detection's series of the Wells Fargo rows, Oct 2 → Dec 2, and his merge of the rent into it */
  function mergeRentIntoDetectedSeries(): void {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: WF,
        name: "Flamingo South Beach",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -229121,
        toleranceDays: 3,
        nextExpectedOn: "2027-01-02",
        nextExpectedAmountCents: -229121,
        anchorDay: 2,
        status: "detected",
        lastMatchedOn: "2026-12-02",
        accountId: "acct",
        userCategoryId: categoryId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const posted = (id: string, postedOn: string) => ({
      id,
      accountId: "acct",
      postedOn,
      amountCents: -229121,
      rawDescription: "FLAMINGO SOUTH BEACH",
      normalizedDescription: "FLAMINGO SOUTH BEACH",
      categoryId,
      recurringSeriesId: WF,
      status: "active" as const,
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    });
    bundle.db
      .insert(transactions)
      .values([posted("t-oct", "2026-10-02"), posted("t-nov", "2026-11-02"), posted("t-dec", "2026-12-02")])
      .run();
    mergeSeries(bundle.db, RENT, WF, TODAY_DEC);
  }

  test("its carrier is the series the rent was merged into — last seen Dec 2, not the ended rent's Sep 2", () => {
    link();
    mergeRentIntoDetectedSeries();
    expect(billingCarriers(bundle.db).get(UTIL)).toEqual({
      id: WF,
      name: "Flamingo South Beach",
      lastMatchedOn: "2026-12-02",
    });
    const line = subscriptionsCard(bundle.db, TODAY_DEC)!.live.find((l) => l.seriesId === UTIL)!;
    expect(line.billedWithLabel).toBe("billed with Flamingo South Beach, last seen Dec 2");
    // ⛔ the link column itself is his write, untouched — the reading follows the merge
    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, UTIL)).get()!.userBilledWithSeriesId).toBe(RENT);
  });

  test("Dec 5, 93 days after the ended rent's Sep 2: still forecast on every surface, because the rent still posts", () => {
    link();
    mergeRentIntoDetectedSeries();
    const where = () => ({
      upcoming: upcomingOccurrences(bundle.db, TODAY_DEC, 60).some((o) => o.seriesId === UTIL),
      arrears: arrearsThisMonth(bundle.db, new Set([UTIL]), TODAY_DEC).series.length > 0,
      december:
        recurringCalendar(bundle.db, "2026-12", TODAY_DEC).entriesByDay["2026-12-01"]?.find((e) => e.seriesId === UTIL)
          ?.paidWith ?? null,
      card: subscriptionsCard(bundle.db, TODAY_DEC)!.live.some((l) => l.seriesId === UTIL),
      evidence: listSeries(bundle.db, TODAY_DEC).find((s) => s.id === UTIL)!.evidence,
      january: forecastForMonth(bundle.db, "2027-01", TODAY_DEC)!.components.some((c) => c.label === "Rent utilities & fees"),
      tail: budgetTail(bundle.db, categoryId, "2027-01-31", TODAY_DEC).series.some((s) => s.id === UTIL),
      calendar: Object.values(recurringCalendar(bundle.db, "2027-01", TODAY_DEC).entriesByDay)
        .flat()
        .some((e) => e.seriesId === UTIL),
    });
    expect(where()).toEqual({
      upcoming: true,
      /*
       * ⚖️ Owed nothing, and still graded: the rent's Dec 2 payment — under the series it was merged into — paid its
       * Dec 1 (settlement follows the carrier). Its owed Dec 1 stood here as the proof it was still live; the December
       * mark naming that payment is the proof now, and a lapsed series would draw none.
       */
      arrears: false,
      december: { carrier: "Flamingo South Beach", postedOn: "2026-12-02" },
      card: true,
      evidence: "active",
      january: true,
      tail: true,
      calendar: true,
    });
    // its page links to the live series, not the ended one
    expect(seriesDetail(bundle.db, UTIL, TODAY_DEC).billedWith?.id).toBe(WF);
  });

  test("a rent merged INTO the utilities leaves nothing to borrow from: its own postings are its evidence", () => {
    link();
    mergeSeries(bundle.db, RENT, UTIL, TODAY);
    expect(billingCarriers(bundle.db).has(UTIL)).toBe(false);
    const util = listSeries(bundle.db, TODAY).find((s) => s.id === UTIL)!;
    expect(util.billedWith).toBeNull();
    expect(util.lastMatchedOn).toBe("2026-09-02");
  });
});

describe("one evidence, every surface — the forward legs read the carrier's postings too", () => {
  test("November's projected band leaves its Nov 1 out of never billed, the gym's Nov 22 in", () => {
    const novemberPart = () => {
      const f = forecastForMonth(bundle.db, "2026-11", TODAY)!;
      const split = forecastSplit(
        f.components.map((c) => ({
          kind: c.kind,
          cents: c.cents,
          isStale: c.staleness?.isStale,
          neverCharged: c.staleness?.daysSinceLastMatch === null,
        })),
      );
      return stalePartLabel(split.spending);
    };
    expect(novemberPart()).toBe("$282.21 of it never billed");
    link();
    expect(novemberPart()).toBe("$100.00 of it never billed");
  });

  /*
   * The rent posts nothing after Sep 2: 93 days later (Dec 4) the forecast lets it go — and what is paid inside it goes
   * with it, on the same day, on every surface that asks the one lapse predicate. Unlinked, the utilities have never
   * posted, which is not lapsing: they stay forecast everywhere (the control).
   */
  test("when the rent lapses, every surface lets what is billed inside it go on the same day", () => {
    const today = "2026-12-05";
    // the rent's quiet is read, not merely unimported (§6A 57) — so the rent itself lapses on Dec 4
    readRentAccountThrough(today);
    const where = () => ({
      upcoming: upcomingOccurrences(bundle.db, today, 60).some((o) => o.seriesId === UTIL),
      arrears: arrearsThisMonth(bundle.db, new Set([UTIL]), today).series.length > 0,
      card: subscriptionsCard(bundle.db, today)!.live.some((l) => l.seriesId === UTIL),
      evidence: listSeries(bundle.db, today).find((s) => s.id === UTIL)!.evidence,
      january: forecastForMonth(bundle.db, "2027-01", today)!.components.some((c) => c.label === "Rent utilities & fees"),
      tail: budgetTail(bundle.db, categoryId, "2027-01-31", today).series.some((s) => s.id === UTIL),
      calendar: Object.values(recurringCalendar(bundle.db, "2027-01", today).entriesByDay)
        .flat()
        .some((e) => e.seriesId === UTIL),
    });
    expect(where()).toEqual({
      upcoming: true,
      arrears: true,
      card: true,
      evidence: "never-billed",
      january: true,
      tail: true,
      calendar: true,
    });
    link();
    expect(where()).toEqual({
      upcoming: false,
      arrears: false,
      card: false,
      evidence: "lapsed",
      january: false,
      tail: false,
      calendar: false,
    });
  });
});

/*
 * ⚖️ SETTLEMENT FOLLOWS THE CARRIER — implied by his decision 59 (recorded by the orchestrator, 2026-10-08): the
 * utilities' money is INSIDE the rent's payment, so an occurrence of theirs is paid once the rent's payment for that
 * period has posted. 🔴 Without it, once each rent statement is imported, every surface that grades a past bill would
 * say "Rent utilities & fees came due Oct 1 and has not posted" every month — beside the rent's own payment that
 * paid it — which his answer contradicts. On a copy of his ledger with the link set, September drew Sep 1 "not yet
 * known" beside the rent's Sep 2 $2,291.21 ($2,109.00 + $182.21).
 *
 * …and it is READ where the rent is read: its Oct 1 is "not posted" exactly when the rent's is, and quiet exactly when
 * the rent's is — the rent's accounts, the ones its late and lapse are already measured on. Read here past Oct 1 AND
 * the rent's 3 days' grace, so the claim holds whether "read" means the due day or the due day with its grace (§6A 60).
 */
describe("settlement follows the carrier — paid once the rent's payment for that period has posted", () => {
  /** a payment of the rent, linked to it */
  function rentPaid(id: string, postedOn: string, cents = -229121): void {
    bundle.db
      .insert(transactions)
      .values({
        id,
        accountId: "acct",
        postedOn,
        amountCents: cents,
        rawDescription: "FLAMINGO SOUTH BEACH",
        normalizedDescription: "FLAMINGO SOUTH BEACH",
        categoryId,
        recurringSeriesId: RENT,
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `h-${id}`,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  /** an import of the rent's account has reached `day`: a row of no series on it (`observationFrontier`) */
  function rentAccountImportedThrough(day: string): void {
    bundle.db
      .insert(transactions)
      .values({
        id: `t-coffee-${day}`,
        accountId: "acct",
        postedOn: day,
        amountCents: -450,
        rawDescription: "COFFEE",
        normalizedDescription: "COFFEE",
        categoryId,
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `h-coffee-${day}`,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  const onDay = (month: string, day: string, id: string, today = TODAY) =>
    recurringCalendar(bundle.db, month, today).entriesByDay[day]?.find((e) => e.seriesId === id);
  const verdicts = (...entries: (CalendarEntry | undefined)[]) => entries.map((e) => [e!.state, e!.unsettledReason]);

  test("September: its Sep 1 reads paid with the rent's Sep 2 payment — and adds nothing the rent's row holds", () => {
    expect(onDay("2026-09", "2026-09-01", UTIL)).toMatchObject({ state: "unsettled", paidWith: null });
    const before = recurringCalendar(bundle.db, "2026-09", TODAY);
    link();
    expect(onDay("2026-09", "2026-09-01", UTIL)).toMatchObject({
      state: "paid",
      amountCents: -18221,
      expectedAmountCents: -18221,
      transactionId: null,
      unsettledReason: null,
      paidWith: { carrier: "the rent", postedOn: "2026-09-02" },
      // ⛔ its money is on the rent's Sep 2 row ($2,291.21 = $2,109.00 + $182.21): counted there, once
      settledCents: 0,
    });
    const after = recurringCalendar(bundle.db, "2026-09", TODAY);
    expect(after.postedNetCents).toBe(before.postedNetCents);
    expect(after.unsettledCount).toBe(before.unsettledCount - 1);
    expect(after.unsettledGrossCents).toBe(before.unsettledGrossCents - 18221);
    // the rent's own row is untouched
    expect(onDay("2026-09", "2026-09-02", RENT)).toMatchObject({ amountCents: -229121, settledCents: -229121 });
  });

  test("October, the rent paid Oct 2: its Oct 1 is paid too — owed on no surface", () => {
    rentPaid("t-oct", "2026-10-02");
    const owed = () => ({
      arrears: arrearsThisMonth(bundle.db, new Set([RENT, UTIL, GYM]), TODAY).series.map((s) => [s.id, s.amountCents]),
      budgets: budgetOverdue(bundle.db, categoryId, "2026-10-01", TODAY).series.map((s) => s.id),
      runway: arrearsSentence(committedBook(bundle.db, TODAY)),
      page: seriesDetail(bundle.db, UTIL, TODAY).overdue?.amountCents ?? null,
      forecast: forecastCurrentMonth(bundle.db, TODAY).components.some((c) => /came due/.test(c.detail ?? "")),
      calendar: onDay("2026-10", "2026-10-01", UTIL)?.state ?? null,
    });
    // unlinked, the rent's payment pays the rent alone: the utilities' Oct 1 is still owed
    expect(owed()).toMatchObject({ arrears: [[UTIL, 18221]], budgets: [UTIL], page: -18221, forecast: true });
    link();
    expect(owed()).toEqual({ arrears: [], budgets: [], runway: null, page: null, forecast: false, calendar: "paid" });
    expect(onDay("2026-10", "2026-10-01", UTIL)!.paidWith).toEqual({ carrier: "the rent", postedOn: "2026-10-02" });
  });

  test("its day is paid by the rent's own test — the rent's grace, never a shorter one of its own", () => {
    // a rent given 5 days' grace, paid Oct 5: the rent's Oct 1 is paid by it, and so is what the payment carries
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, RENT)).run();
    rentPaid("t-oct", "2026-10-05");
    link();
    const late = arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY);
    expect(late.series).toEqual([]);
    expect(onDay("2026-10", "2026-10-01", UTIL)!.paidWith).toEqual({ carrier: "the rent", postedOn: "2026-10-05" });
  });

  test("⛔ the money is unchanged: November still projects $2,109.00 + $182.21; October counts the rent's payment once", () => {
    rentPaid("t-oct", "2026-10-02");
    const november = () =>
      forecastForMonth(bundle.db, "2026-11", TODAY)!
        .components.filter((c) => c.label === "Rent utilities & fees" || c.label === "Flamingo South Beach (rent)")
        .map((c) => [c.label, c.cents]);
    const upcoming = () => upcomingOccurrences(bundle.db, TODAY, 60).map((o) => [o.seriesId, o.date, o.amountCents]);
    const spend = () => forecastCurrentMonth(bundle.db, TODAY).projectedSpendCents;
    const before = { november: november(), upcoming: upcoming(), spend: spend() };
    expect(before.november).toEqual([
      ["Flamingo South Beach (rent)", -210900],
      ["Rent utilities & fees", -18221],
    ]);
    link();
    expect({ november: november(), upcoming: upcoming() }).toEqual({ november: before.november, upcoming: before.upcoming });
    // the $182.21 is inside the rent's posted $2,291.21: owed again on top of it, it was counted twice (spend is signed
    // as net worth sees it, so the projection rises by it)
    expect(spend()).toBe(before.spend + 18221);
  });

  test("its Oct 1 is read on the rent's accounts: quiet while they are unread, not posted once read and the rent unpaid", () => {
    rentPaid("t-jul", "2026-07-08", -228570); // his third payment: the rent's schedule is measured (`scheduleIsProven`)
    link();
    const reading = () => {
      const late = arrearsThisMonth(bundle.db, new Set([RENT, UTIL]), TODAY).series;
      const unread = (id: string) => late.find((s) => s.id === id)!.unreadCents;
      const pageUnread = (id: string) => seriesDetail(bundle.db, id, TODAY).overdue!.unreadCents;
      return {
        unread: [unread(RENT), unread(UTIL)],
        page: [pageUnread(RENT), pageUnread(UTIL)],
        runway: arrearsSentence(committedBook(bundle.db, TODAY)),
        calendar: verdicts(onDay("2026-10", "2026-10-01", RENT), onDay("2026-10", "2026-10-01", UTIL)),
      };
    };
    // the rent's account read only through its Sep 2 payment: both only await an import
    expect(reading()).toEqual({
      unread: [210900, 18221],
      page: [210900, 18221],
      runway: "A further $2,291.21 came due earlier this month and no import has covered it yet.",
      calendar: [
        ["unsettled", "not_imported"],
        ["unsettled", "not_imported"],
      ],
    });
    // read past Oct 1 and its 3 days' grace, and the rent did not post: both are not posted
    rentAccountImportedThrough("2026-10-07");
    expect(reading()).toEqual({
      unread: [0, 0],
      page: [0, 0],
      runway: "A further $2,291.21 came due earlier this month and never posted.",
      calendar: [
        ["missed", null],
        ["missed", null],
      ],
    });
  });

  test("a rent with too few charges to grade: what is billed inside it waits with it, never missed alone", () => {
    link();
    rentAccountImportedThrough("2026-10-07");
    // two charges of the rent's: its date is not yet measured (`ScheduleProven`) — nor is the day it carries
    expect(verdicts(onDay("2026-10", "2026-10-01", RENT), onDay("2026-10", "2026-10-01", UTIL))).toEqual([
      ["unsettled", "schedule_unproven"],
      ["unsettled", "schedule_unproven"],
    ]);
  });

  test("the control: the gym, billed on its own and never charged, is graded exactly as before", () => {
    rentPaid("t-oct", "2026-10-02");
    rentAccountImportedThrough("2026-10-24");
    const gym = () => [
      onDay("2026-10", "2026-10-22", GYM, "2026-10-25"),
      arrearsThisMonth(bundle.db, new Set([GYM]), "2026-10-25"),
    ];
    const before = gym();
    expect(before[0]).toMatchObject({ state: "unsettled", unsettledReason: "not_imported", paidWith: null });
    link();
    expect(gym()).toEqual(before);
  });
});
