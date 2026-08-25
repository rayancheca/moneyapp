import { describe, expect, test } from "vitest";
import {
  MIN_SPAN_DAYS_FOR_RATE,
  MIN_VISITS_FOR_RATE,
  TICKET_SKEW_DISCLOSE,
  merchantProfile,
  type MerchantVisit,
} from "./merchant-profile";

const TODAY = "2026-08-25";

/**
 * New Best Gourmet Deli — the owner's most-visited merchant, measured on the
 * real ledger 2026-08-25: 217 rows, $2,179.01, 2023-12-02 to 2026-06-01. The
 * shape a merchant page exists to describe.
 *
 * Modelled here at a scale that can be reasoned about by hand rather than
 * copied in full: a steady $10 visit every week for a year.
 */
function weekly(count: number, amountCents: number, from = "2025-01-01"): MerchantVisit[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
    amountCents,
    categoryName: "Food",
  }));
}

describe("merchantProfile — the number a merchant page exists to give", () => {
  test("states a monthly rate across the span actually observed", () => {
    // 53 weekly $10 visits spans 364 days = 11.96 months → ~$44.34/month
    const p = merchantProfile(weekly(53, 1000), TODAY);
    expect(p.visitCount).toBe(53);
    expect(p.totalCents).toBe(53000);
    expect(p.spanDays).toBe(364);
    expect(p.monthlyCents).toBeCloseTo(4434, -1);
    expect(p.monthlyBasis).toMatch(/364 days/);
  });

  test("the rate is spread over the SPAN, not over a calendar year", () => {
    // the SAME total money, in half the elapsed time, is twice the monthly habit
    const sparse = merchantProfile(weekly(27, 1000), TODAY); // one visit a week
    const dense = merchantProfile(
      Array.from({ length: 27 }, (_, i) => ({
        day: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 3.5 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        amountCents: 1000,
        categoryName: "Food",
      })),
      TODAY,
    ); // two a week, same 27 visits and same $270
    expect(dense.totalCents).toBe(sparse.totalCents);
    expect(dense.spanDays).toBeCloseTo(sparse.spanDays / 2, -1);
    expect(dense.monthlyCents!).toBeCloseTo(sparse.monthlyCents! * 2, -2);
  });

  test("first and last seen bound the span", () => {
    const p = merchantProfile(weekly(10, 500), TODAY);
    expect(p.firstSeen).toBe("2025-01-01");
    expect(p.lastSeen).toBe("2025-03-05");
    expect(p.spanDays).toBe(63);
  });
});

/**
 * 454 of 702 merchants on the real ledger have exactly ONE visit. Inventing a
 * monthly rate for them is the single most likely way this page could lie, so
 * the refusals get more tests than the figure does.
 */
describe("merchantProfile — when it refuses to state a rate", () => {
  test("one visit is not a rate", () => {
    const p = merchantProfile([{ day: "2025-06-01", amountCents: 375843, categoryName: "Shopping" }], TODAY);
    expect(p.monthlyCents).toBeNull();
    expect(p.monthlyBasis).toMatch(/single purchase is not a rate/i);
    // …but the money is still reported
    expect(p.totalCents).toBe(375843);
  });

  test("two visits are not a rate either", () => {
    const p = merchantProfile(weekly(2, 1000), TODAY);
    expect(p.monthlyCents).toBeNull();
    expect(p.monthlyBasis).toMatch(/Too few/i);
  });

  test("enough visits inside too short a stretch is not a rate", () => {
    // 8 visits in 49 days: plenty of visits, not enough elapsed time
    const p = merchantProfile(weekly(8, 1000), TODAY);
    expect(p.spanDays).toBe(49);
    expect(p.monthlyCents).toBeNull();
    expect(p.monthlyBasis).toMatch(/too short a stretch/i);
  });

  test("the two thresholds are checkable, not magic", () => {
    expect(MIN_VISITS_FOR_RATE).toBe(3);
    expect(MIN_SPAN_DAYS_FOR_RATE).toBe(60);
    // exactly at both thresholds, a rate IS given
    const at = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 1000, categoryName: "Food" },
        { day: "2025-02-01", amountCents: 1000, categoryName: "Food" },
        { day: "2025-03-02", amountCents: 1000, categoryName: "Food" },
      ],
      TODAY,
    );
    expect(at.spanDays).toBe(60);
    expect(at.monthlyCents).not.toBeNull();
  });

  test("a merchant with no visits at all is empty, not an error", () => {
    const p = merchantProfile([], TODAY);
    expect(p).toMatchObject({ visitCount: 0, totalCents: 0, monthlyCents: null, firstSeen: null });
    expect(p.categoryMix).toEqual([]);
    expect(p.years).toEqual([]);
  });
});

/**
 * Target's mean ticket is $34.40 against a $16.75 median across 77 real rows.
 * Publishing the mean alone would describe a typical visit that mostly does not
 * happen.
 */
describe("merchantProfile — the typical visit", () => {
  const skewed: MerchantVisit[] = [
    ...Array.from({ length: 9 }, (_, i) => ({
      day: `2025-0${i + 1}-01`.slice(0, 10),
      amountCents: 1000,
      categoryName: "Shopping",
    })),
    { day: "2025-10-01", amountCents: 100000, categoryName: "Shopping" },
  ];

  test("the median leads and the mean is reported beside it", () => {
    const p = merchantProfile(skewed, TODAY);
    expect(p.medianTicketCents).toBe(1000);
    expect(p.meanTicketCents).toBe(10900);
    expect(p.ticketSkew).toBeCloseTo(10.9, 1);
  });

  test("a skewed merchant is flagged as such", () => {
    expect(merchantProfile(skewed, TODAY).ticketIsSkewed).toBe(true);
  });

  test("an even merchant is not flagged, so the flag means something", () => {
    const even = merchantProfile(weekly(20, 1000), TODAY);
    expect(even.medianTicketCents).toBe(1000);
    expect(even.meanTicketCents).toBe(1000);
    expect(even.ticketIsSkewed).toBe(false);
    expect(TICKET_SKEW_DISCLOSE).toBe(1.25);
  });

  test("an even number of visits medians between the middle two", () => {
    const p = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 1000, categoryName: "Food" },
        { day: "2025-02-01", amountCents: 2000, categoryName: "Food" },
        { day: "2025-03-01", amountCents: 3000, categoryName: "Food" },
        { day: "2025-04-01", amountCents: 5000, categoryName: "Food" },
      ],
      TODAY,
    );
    expect(p.medianTicketCents).toBe(2500);
  });

  test("a merchant of free visits has no skew rather than an infinite one", () => {
    const p = merchantProfile(weekly(5, 0, "2025-01-01"), TODAY);
    expect(p.medianTicketCents).toBe(0);
    expect(p.ticketSkew).toBe(0);
    expect(p.ticketIsSkewed).toBe(false);
    expect(Number.isNaN(p.ticketSkew)).toBe(false);
  });
});

describe("merchantProfile — category mix", () => {
  const mixed: MerchantVisit[] = [
    { day: "2025-01-01", amountCents: 7500, categoryName: "Food" },
    { day: "2025-02-01", amountCents: 2500, categoryName: "Shopping" },
  ];

  test("shares sum to a hundred, largest first", () => {
    const mix = merchantProfile(mixed, TODAY).categoryMix;
    expect(mix.map((m) => [m.name, m.pct])).toEqual([
      ["Food", 75],
      ["Shopping", 25],
    ]);
    expect(mix.reduce((t, m) => t + m.pct, 0)).toBe(100);
  });

  test("equal shares sort by name, so the order is stable", () => {
    const mix = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 1000, categoryName: "Zeta" },
        { day: "2025-02-01", amountCents: 1000, categoryName: "Alpha" },
      ],
      TODAY,
    ).categoryMix;
    expect(mix.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
  });

  test("a merchant of free visits has a mix without dividing by zero", () => {
    const mix = merchantProfile(weekly(3, 0), TODAY).categoryMix;
    expect(mix).toEqual([{ name: "Food", cents: 0, pct: 0 }]);
  });
});

/**
 * Year over year is where a partial year lies loudest: 2026 holds eight months
 * on this ledger, and setting it beside a full 2025 without a mark invites the
 * reader to call it a decline.
 */
describe("merchantProfile — year over year", () => {
  const acrossYears: MerchantVisit[] = [
    { day: "2024-06-01", amountCents: 1000, categoryName: "Food" },
    { day: "2025-06-01", amountCents: 3000, categoryName: "Food" },
    { day: "2026-06-01", amountCents: 2000, categoryName: "Food" },
  ];

  test("newest year first, each with its own spend and count", () => {
    expect(merchantProfile(acrossYears, TODAY).years).toEqual([
      { year: "2026", cents: 2000, visits: 1, partial: true },
      { year: "2025", cents: 3000, visits: 1, partial: false },
      { year: "2024", cents: 1000, visits: 1, partial: false },
    ]);
  });

  test("the current year is marked partial, and closed years are not", () => {
    const years = merchantProfile(acrossYears, TODAY).years;
    expect(years.filter((y) => y.partial).map((y) => y.year)).toEqual(["2026"]);
  });

  test("a year with no visits is absent rather than a zero row", () => {
    const gap = merchantProfile(
      [
        { day: "2023-06-01", amountCents: 1000, categoryName: "Food" },
        { day: "2026-06-01", amountCents: 1000, categoryName: "Food" },
      ],
      TODAY,
    );
    expect(gap.years.map((y) => y.year)).toEqual(["2026", "2023"]);
  });
});
