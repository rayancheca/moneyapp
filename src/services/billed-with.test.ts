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
import { forecastSplit } from "@/lib/forecast-split";
import { stalePartLabel, staleSummaryLabel, upcomingEvidenceWord } from "@/components/recurring/labels";
import { arrearsThisMonth } from "./arrears";
import { billingCarriers } from "./billing-carriers";
import { budgetTail } from "./budgets";
import { committedBook } from "./committed";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";
import { provenanceFor } from "./provenance";
import { hasStoppedForecasting, listSeries, seriesEvidence, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";
import { recurringInsightInput } from "./recurring-insights";
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

  test("⛔ the arrears are unchanged — its Oct 1 still came due and has not posted", () => {
    const ids = new Set([RENT, UTIL, GYM]);
    const before = arrearsThisMonth(bundle.db, ids, TODAY);
    expect(before.series.map((s) => s.id)).toContain(UTIL);
    link();
    expect(arrearsThisMonth(bundle.db, ids, TODAY)).toEqual(before);
  });

  test("the calendar's upcoming entry says billed with the rent, not never billed; its past entry is graded as before", () => {
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
    // the past is the arrears' question, and the arrears stay as they are
    expect(entries("2026-10").map((e) => [e.state, e.amountCents, e.unsettledReason, e.billedWith])).toEqual(
      octBefore.map((e) => [e.state, e.amountCents, e.unsettledReason, null]),
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
    // 30 × 1.5 + 3 = 48 days after Sep 2 is Oct 20: running late from Oct 21
    expect(util("2026-10-20").evidence).toBe("active");
    expect(util("2026-10-21").evidence).toBe("running-late");
    // 30 × 3 + 3 = 93 days after Sep 2 is Dec 4: lapsed — the forecast lets both go on one day
    const row = (today: string) => ({ ...bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, UTIL)).get()!, billedWith: billingCarriers(bundle.db).get(UTIL) ?? null, today });
    expect(seriesEvidence(row("2026-12-05"), "2026-12-05")).toBe("lapsed");
    expect(hasStoppedForecasting(row("2026-12-05"), "2026-12-05")).toBe(true);
    expect(hasStoppedForecasting(row("2026-12-04"), "2026-12-04")).toBe(false);
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
