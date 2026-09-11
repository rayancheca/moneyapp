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
    // 53 weekly $10 visits, first 2025-01-01 and last 2025-12-31 — 365 days
    // observed, both ends included, = 12.0 months → ~$44.19/month
    const p = merchantProfile(weekly(53, 1000), [], TODAY);
    expect(p.visitCount).toBe(53);
    expect(p.totalCents).toBe(53000);
    expect(p.spanDays).toBe(365);
    expect(p.monthlyCents).toBeCloseTo(4419, -1);
    expect(p.monthlyBasis).toMatch(/365 days/);
  });

  test("the rate is spread over the SPAN, not over a calendar year", () => {
    // the SAME total money, in half the elapsed time, is twice the monthly habit
    const sparse = merchantProfile(weekly(27, 1000), [], TODAY); // one visit a week
    const dense = merchantProfile(
      Array.from({ length: 27 }, (_, i) => ({
        day: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 3.5 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        amountCents: 1000,
        categoryName: "Food",
      })), [],
      TODAY,
    ); // two a week, same 27 visits and same $270
    expect(dense.totalCents).toBe(sparse.totalCents);
    expect(dense.spanDays).toBeCloseTo(sparse.spanDays / 2, -1);
    expect(dense.monthlyCents!).toBeCloseTo(sparse.monthlyCents! * 2, -2);
  });

  test("first and last seen bound the span", () => {
    const p = merchantProfile(weekly(10, 500), [], TODAY);
    expect(p.firstSeen).toBe("2025-01-01");
    expect(p.lastSeen).toBe("2025-03-05");
    // Jan 1 through Mar 5 inclusive: 31 + 28 + 5
    expect(p.spanDays).toBe(64);
  });
});

/**
 * 454 of 702 merchants on the real ledger have exactly ONE visit. Inventing a
 * monthly rate for them is the single most likely way this page could lie, so
 * the refusals get more tests than the figure does.
 */
describe("merchantProfile — when it refuses to state a rate", () => {
  test("one visit is not a rate", () => {
    const p = merchantProfile([{ day: "2025-06-01", amountCents: 375843, categoryName: "Shopping" }], [], TODAY);
    expect(p.monthlyCents).toBeNull();
    expect(p.monthlyBasis).toMatch(/single purchase is not a rate/i);
    // …but the money is still reported
    expect(p.totalCents).toBe(375843);
  });

  test("two visits are not a rate either", () => {
    const p = merchantProfile(weekly(2, 1000), [], TODAY);
    expect(p.monthlyCents).toBeNull();
    expect(p.monthlyBasis).toMatch(/Too few/i);
  });

  test("enough visits inside too short a stretch is not a rate", () => {
    // 8 visits over 50 observed days: plenty of visits, not enough of a stretch
    const p = merchantProfile(weekly(8, 1000), [], TODAY);
    expect(p.spanDays).toBe(50);
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
        // Jan 1 through Mar 1 inclusive is exactly 60 observed days
        { day: "2025-03-01", amountCents: 1000, categoryName: "Food" },
      ], [],
      TODAY,
    );
    expect(at.spanDays).toBe(60);
    expect(at.monthlyCents).not.toBeNull();

    // …and one day less is one day short
    const under = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 1000, categoryName: "Food" },
        { day: "2025-02-01", amountCents: 1000, categoryName: "Food" },
        { day: "2025-02-28", amountCents: 1000, categoryName: "Food" },
      ], [],
      TODAY,
    );
    expect(under.spanDays).toBe(59);
    expect(under.monthlyCents).toBeNull();
  });

  /*
   * 🔴 `spanDays` was the EXCLUSIVE difference while both sentences it feeds
   * name a count of days from first to last with both ends included.
   *
   * Measured on the real ledger at today = 2026-09-01: all 152 merchants that
   * print one of those sentences printed a count exactly one short, and four
   * printed a sentence that refutes itself —
   *
   *     Kalshi              "5 visits inside 0 days — too short a stretch…"
   *     Fanatics Sportsbook "4 visits inside 0 days — …"
   *     Gotham Burger NYC   "3 visits inside 0 days — …"
   *     L Train Vintage     "3 visits inside 0 days — …"
   *
   * Every one of those merchants' purchases fell on a single day. Five visits
   * happened inside ONE day; zero days hold nothing at all.
   *
   * ⚠️ The figure and the divisor are the same number on purpose — the branch
   * above picks the rate and the sentence together so a figure can never sit
   * beside a description of a different figure. Fixing only the sentence would
   * break that.
   */
  /*
   * ⛔ THE MEASURED CASE. `Zelle` holds 140 active rows: 99 Reimbursements, 26
   * Internal Transfer, 13 Transfers — all transfer-kind — and exactly 2 Rent
   * charges. The page's heading counted 140, this card counted 2, and its own
   * explanation for having no rate read "2 visits. Too few to describe a
   * monthly habit." of a merchant seen 140 times over nine months.
   */
  test("rows this card does not count are named, and the basis says purchases", () => {
    const p = merchantProfile(
      [
        { day: "2026-02-17", amountCents: 149_500, categoryName: "Housing" },
        { day: "2026-05-29", amountCents: 83_000, categoryName: "Housing" },
      ], [],
      TODAY,
      140,
    );
    expect(p.visitCount).toBe(2);
    expect(p.uncountedRows).toBe(138);
    expect(p.countedNote).toContain("Measured from 2 purchases");
    expect(p.countedNote).toContain("138 other rows");
    // the word the Purchases tile uses, not the one that implies presence
    expect(p.monthlyBasis).toBe("2 purchases. Too few to describe a monthly habit.");
  });

  test("a merchant whose every row is a purchase says nothing extra", () => {
    const p = merchantProfile(
      [{ day: "2026-02-17", amountCents: 1_000, categoryName: "Food" }], [],
      TODAY,
      1,
    );
    expect(p.uncountedRows).toBe(0);
    expect(p.countedNote).toBeNull();
  });

  test("one uncounted row is singular", () => {
    const p = merchantProfile(
      [{ day: "2026-02-17", amountCents: 1_000, categoryName: "Food" }], [],
      TODAY,
      2,
    );
    expect(p.countedNote).toContain("The 1 other row here is money in");
    expect(p.countedNote).toContain("not a purchase, so nothing on this card counts it");
    expect(p.countedNote).not.toContain("1 other rows");
  });

  /* A merchant with nothing but refunds has no purchases at all, and the note
     is the only thing that can explain the empty card. */
  test("a merchant with no purchases at all still says what its rows are", () => {
    const p = merchantProfile([], [], TODAY, 5);
    expect(p.visitCount).toBe(0);
    expect(p.uncountedRows).toBe(5);
    expect(p.countedNote).toContain("Measured from 0 purchases");
  });

  test("visits on a single day span one day, not zero", () => {
    const p = merchantProfile(
      [
        { day: "2026-02-04", amountCents: 1000, categoryName: "Food" },
        { day: "2026-02-04", amountCents: 2000, categoryName: "Food" },
        { day: "2026-02-04", amountCents: 3000, categoryName: "Food" },
      ], [],
      TODAY,
    );
    expect(p.spanDays).toBe(1);
    // the whole sentence, so "1 days" cannot pass as "1 day" plus an s
    expect(p.monthlyBasis).toBe("3 purchases inside 1 day — too short a stretch to call it monthly.");
    expect(p.monthlyCents).toBeNull();
  });

  test("the sentence counts the same days the divisor does", () => {
    const p = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 3000, categoryName: "Food" },
        { day: "2025-03-01", amountCents: 3000, categoryName: "Food" },
        { day: "2025-04-30", amountCents: 3000, categoryName: "Food" },
      ], [],
      TODAY,
    );
    // 2025-01-01 through 2025-04-30 inclusive: 31 + 28 + 31 + 30
    expect(p.spanDays).toBe(120);
    /*
     * 🔴 It read "Spread across the 120 days from 2025-01-01 to 2025-04-30." —
     * raw ISO in a `max-w-prose` paragraph, while the insight a few lines below
     * spelled the IDENTICAL window "Jan 1 – Apr 30, 2025". One window, two
     * spellings, one screen, on 109 merchant pages. This assertion pinned it.
     */
    expect(p.monthlyBasis).toBe("Spread across the 120 days of Jan 1 – Apr 30, 2025.");
    expect(p.monthlyBasis).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(p.monthlyCents).toBe(Math.round(9000 / (120 / (365.2425 / 12))));
  });

  test("a merchant with no visits at all is empty, not an error", () => {
    const p = merchantProfile([], [], TODAY);
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
    const p = merchantProfile(skewed, [], TODAY);
    expect(p.medianTicketCents).toBe(1000);
    expect(p.meanTicketCents).toBe(10900);
    expect(p.ticketSkew).toBeCloseTo(10.9, 1);
  });

  test("a skewed merchant is flagged as such", () => {
    expect(merchantProfile(skewed, [], TODAY).ticketIsSkewed).toBe(true);
  });

  test("an even merchant is not flagged, so the flag means something", () => {
    const even = merchantProfile(weekly(20, 1000), [], TODAY);
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
      ], [],
      TODAY,
    );
    expect(p.medianTicketCents).toBe(2500);
  });

  test("a merchant of free visits has no skew rather than an infinite one", () => {
    const p = merchantProfile(weekly(5, 0, "2025-01-01"), [], TODAY);
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
    const mix = merchantProfile(mixed, [], TODAY).categoryMix;
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
      ], [],
      TODAY,
    ).categoryMix;
    expect(mix.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
  });

  test("a merchant of free visits has a mix without dividing by zero", () => {
    const mix = merchantProfile(weekly(3, 0), [], TODAY).categoryMix;
    expect(mix).toEqual([{ name: "Food", cents: 0, pct: 0, share: "0.0%" }]);
  });

  /**
   * 🔴 THE 100% DENIED THE ROW UNDERNEATH IT. The card printed
   * `pct.toFixed(0)`, so a split of $6.44 / $0.03 read "100 %" and "0 %" —
   * the first claiming the whole of a merchant whose very next line is real
   * money, the second asserting a measured zero about money that was spent.
   * /merchants/…63e7 (Metropolitan Museum of Art), real ledger 2026-09-11.
   */
  test("a lopsided split never reads 100% over a nonzero sibling", () => {
    const mix = merchantProfile(
      [
        { day: "2025-09-14", amountCents: 644, categoryName: "Entertainment" },
        { day: "2026-02-28", amountCents: 3, categoryName: "Gifts & Donations" },
      ],
      [],
      TODAY,
    ).categoryMix;
    expect(mix.map((m) => [m.name, m.share])).toEqual([
      ["Entertainment", "99.5%"],
      ["Gifts & Donations", "0.5%"],
    ]);
    // what the card used to print, and why it was wrong
    expect(mix.map((m) => `${m.pct.toFixed(0)}%`)).toEqual(["100%", "0%"]);
  });

  /** a share too small even for one decimal is floored, never rounded away */
  test("a sliver reads <0.1%, not 0.0%", () => {
    const mix = merchantProfile(
      [
        { day: "2025-01-01", amountCents: 1_000_000, categoryName: "Food" },
        { day: "2025-02-01", amountCents: 1, categoryName: "Shopping" },
      ],
      [],
      TODAY,
    ).categoryMix;
    expect(mix.find((m) => m.name === "Shopping")!.share).toBe("<0.1%");
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
    expect(merchantProfile(acrossYears, [], TODAY).years).toEqual([
      { year: "2026", cents: 2000, visits: 1, partial: true },
      { year: "2025", cents: 3000, visits: 1, partial: false },
      { year: "2024", cents: 1000, visits: 1, partial: false },
    ]);
  });

  test("the current year is marked partial, and closed years are not", () => {
    const years = merchantProfile(acrossYears, [], TODAY).years;
    expect(years.filter((y) => y.partial).map((y) => y.year)).toEqual(["2026"]);
  });

  test("a year with no visits is absent rather than a zero row", () => {
    const gap = merchantProfile(
      [
        { day: "2023-06-01", amountCents: 1000, categoryName: "Food" },
        { day: "2026-06-01", amountCents: 1000, categoryName: "Food" },
      ], [],
      TODAY,
    );
    expect(gap.years.map((y) => y.year)).toEqual(["2026", "2023"]);
  });
});

describe("the returns — what a merchant COST against what it charged", () => {
  const purchases: MerchantVisit[] = [
    { day: "2026-01-10", amountCents: 100_000, categoryName: "Shopping" },
    { day: "2026-02-10", amountCents: 20_000, categoryName: "Shopping" },
    { day: "2026-03-10", amountCents: 5_000, categoryName: "Shopping" },
  ];
  const returned: MerchantVisit[] = [
    { day: "2026-01-20", amountCents: 100_000, categoryName: "Shopping" },
  ];

  test("the Total is what it cost; the gross is kept beside it", () => {
    /*
     * 🔴 The live shape, 2026-09-10. `Best Buy` charged $3,758.43 and returned
     * $3,540.71 of it, and every figure on the card said $3,758.43 — including
     * "the largest of your 250 regular merchants". It cost $217.72.
     */
    const p = merchantProfile(purchases, returned, TODAY);
    expect(p.grossCents).toBe(125_000);
    expect(p.refundCents).toBe(100_000);
    expect(p.refundCount).toBe(1);
    expect(p.totalCents).toBe(25_000);
  });

  test("the rate is the COST spread over the span, so the two agree", () => {
    const p = merchantProfile(purchases, returned, TODAY);
    // $250.00 over 2026-01-10 → 2026-03-10, both ends included
    expect(p.spanDays).toBe(60);
    expect(p.monthlyCents).toBe(Math.round(25_000 / (60 / (365.2425 / 12))));
  });

  test("a return is not a visit: the count, the median and the mean stay gross", () => {
    const p = merchantProfile(purchases, returned, TODAY);
    expect(p.visitCount).toBe(3);
    expect(p.medianTicketCents).toBe(20_000);
    // the mean PURCHASE — 125_000 / 3, not the net over three
    expect(p.meanTicketCents).toBe(41_667);
  });

  test("the years are purchases, and they add up to the gross the note names", () => {
    /*
     * ⛔ Netted, they drew a bar of -$1,004.99 on `Best Buy` — 2024's returns
     * outran its purchases. The bar is measured from the largest year and drawn
     * from `left: 0`, so a negative width renders as no bar at all and the most
     * extreme year would have read as the emptiest.
     */
    const p = merchantProfile(purchases, returned, TODAY);
    expect(p.years.reduce((t, y) => t + y.cents, 0)).toBe(p.grossCents);
    expect(p.years.every((y) => y.cents >= 0)).toBe(true);
  });

  test("the note values the returns, because the Total counts them now", () => {
    const p = merchantProfile(purchases, returned, TODAY, 4);
    expect(p.countedNote).toBe(
      "3 purchases came to $1,250.00, less $1,000.00 returned across 1 row.",
    );
  });

  test("a merchant with returns AND other rows names both", () => {
    // a transfer or an uncategorized row is still not a purchase and still
    // counts for nothing — the two exclusions are different facts
    const p = merchantProfile(purchases, returned, TODAY, 6);
    expect(p.countedNote).toBe(
      "3 purchases came to $1,250.00, less $1,000.00 returned across 1 row. The 2 other rows " +
        "here are money in, transfers, or uncategorized — none of them a purchase, so nothing on " +
        "this card counts them.",
    );
  });

  test("no returns leaves the old sentence exactly as it was", () => {
    const p = merchantProfile(purchases, [], TODAY, 4);
    expect(p.countedNote).toBe(
      "Measured from 3 purchases. The 1 other row here is money in, a transfer, or uncategorized " +
        "— not a purchase, so nothing on this card counts it.",
    );
  });

  test("a merchant that returned everything costs nothing, and says so", () => {
    // `Apple Store` on the live ledger: $1,248.80 charged over three purchases,
    // all three returned. It sat 15th of 250.
    const p = merchantProfile(
      [
        { day: "2026-03-23", amountCents: 108_766, categoryName: "Shopping" },
        { day: "2026-03-24", amountCents: 10_779, categoryName: "Shopping" },
      ],
      [
        { day: "2026-03-31", amountCents: 108_766, categoryName: "Shopping" },
        { day: "2026-03-31", amountCents: 10_779, categoryName: "Shopping" },
      ],
      TODAY,
      4,
    );
    expect(p.totalCents).toBe(0);
    expect(p.grossCents).toBe(119_545);
  });
});
