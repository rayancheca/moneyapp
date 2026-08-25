import { describe, expect, test } from "vitest";
import {
  YEAR_SECTION_ORDER,
  YEAR_SECTION_TITLE,
  yearSummary,
  type YearLineInput,
} from "./year-summary";

/**
 * 2025 as the ledger actually holds it, measured 2026-08-24 before this module
 * existed. 2025 is the last complete calendar year.
 *
 * The grouping is NOT invented here — it is `docs/income-ground-truth.md`'s
 * rule, which the owner set:
 *
 *   "Earnings = Fordham work-study wages (biweekly ACH direct deposit)
 *             + Knack tutoring payouts
 *             + SoFi savings interest."
 *
 * and, explicitly not earnings: financial-aid refunds ("Papa money"), dad's
 * money, ATM cash of mixed origin, money moved into investing, and peer Zelle
 * reimbursements.
 *
 *   Fordham payroll        $16,912.74   26 rows
 *   Knack tutoring          $5,771.25   26 rows
 *   SoFi savings interest     $994.65   12 rows
 *   ── earned              $23,678.64
 *   Dividends                 $256.58   22 rows
 *   Brokerage cash interest   $419.29   16 rows
 *   Realized gains          $2,082.72   31 sales — PARTIAL, a trade had no close
 *   Financial aid refund   $10,100.00    1 row
 *   Refunds/reimbursements  $1,333.00    1 row
 *   Family pass-through     $3,412.75    3 rows — kept OUT
 */
const REAL: YearLineInput[] = [
  {
    id: "fordham",
    label: "Fordham work-study wages",
    section: "earned",
    amountCents: 1691274,
    rowCount: 26,
    sourcedRowCount: 26,
    sources: ["chase-2025-01.pdf", "chase-2025-02.pdf"],
    basis: "Biweekly ACH direct deposit from Fordham University payroll.",
  },
  {
    id: "knack",
    label: "Knack tutoring",
    section: "earned",
    amountCents: 577125,
    rowCount: 26,
    sourcedRowCount: 26,
    sources: ["chase-2025-02.pdf"],
    basis: "Payouts described KNACK PAYOUT.",
  },
  {
    id: "sofi-interest",
    label: "SoFi savings interest",
    section: "earned",
    amountCents: 99465,
    rowCount: 12,
    sourcedRowCount: 12,
    sources: ["sofi-2025.csv"],
    basis: "Interest credited to the SoFi savings account.",
  },
  {
    id: "dividends",
    label: "Dividends",
    section: "investment",
    amountCents: 25658,
    rowCount: 22,
    sourcedRowCount: 22,
    sources: ["robinhood-2025.csv"],
    basis: "Dividends credited to the brokerage cash account.",
  },
  {
    id: "realized",
    label: "Realized gains",
    section: "investment",
    amountCents: 208272,
    rowCount: 31,
    sourcedRowCount: 0,
    sources: [],
    basis: "An average-cost walk over every sale, valued at each day's close.",
    caveat: "Estimated — execution prices are not recorded, and one trade had no close.",
  },
  {
    id: "aid",
    label: "Financial aid refund",
    section: "notEarned",
    amountCents: 1010000,
    rowCount: 1,
    sourcedRowCount: 1,
    sources: ["chase-2025-01.pdf"],
    basis: "Tuition is paid from an account this ledger does not hold; the balance is refunded.",
  },
  {
    id: "family",
    label: "Family pass-through",
    section: "excluded",
    amountCents: 341275,
    rowCount: 3,
    sourcedRowCount: 3,
    sources: ["chase-2025-06.pdf"],
    basis: "Money sent from family and largely sent back; both legs net to about nothing.",
  },
];

describe("yearSummary — the real 2025 shape", () => {
  test("totals each section from its own lines", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    const total = (id: string) => s.sections.find((x) => x.id === id)?.totalCents;
    expect(total("earned")).toBe(1691274 + 577125 + 99465);
    expect(total("investment")).toBe(25658 + 208272);
    expect(total("notEarned")).toBe(1010000);
    expect(total("excluded")).toBe(341275);
  });

  test("the headline is EARNED only — nothing else is added to it", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    expect(s.earnedCents).toBe(2367864);
    // the three figures a reader most often conflates, kept apart
    expect(s.earnedCents).not.toBe(s.totalReceivedCents);
    expect(s.totalReceivedCents).toBe(2367864 + 233930 + 1010000);
  });

  test("money kept OUT is never in any total the page adds up", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    expect(s.excludedCents).toBe(341275);
    expect(s.earnedCents + s.investmentCents + s.notEarnedCents).toBe(s.totalReceivedCents);
    // and the load-bearing half: removing the excluded line moves NO total
    const without = yearSummary({ year: 2025, lines: REAL.filter((l) => l.section !== "excluded") });
    expect(without.totalReceivedCents).toBe(s.totalReceivedCents);
    expect(without.earnedCents).toBe(s.earnedCents);
    expect(without.excludedCents).toBe(0);
  });

  test("sections render in a fixed order, and each is titled", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    expect(s.sections.map((x) => x.id)).toEqual([...YEAR_SECTION_ORDER]);
    for (const sec of s.sections) expect(sec.title).toBe(YEAR_SECTION_TITLE[sec.id]);
  });

  test("two lines of equal size sort by label, so the order is stable", () => {
    const tie: YearLineInput[] = [
      { ...REAL[0]!, id: "z", label: "Zeta stipend", amountCents: 50000 },
      { ...REAL[0]!, id: "a", label: "Alpha stipend", amountCents: 50000 },
    ];
    expect(yearSummary({ year: 2025, lines: tie }).sections[0]!.lines.map((l) => l.label)).toEqual([
      "Alpha stipend",
      "Zeta stipend",
    ]);
  });

  test("lines sort largest first inside a section", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    const earned = s.sections.find((x) => x.id === "earned")!;
    expect(earned.lines.map((l) => l.id)).toEqual(["fordham", "knack", "sofi-interest"]);
  });
});

describe("yearSummary — provenance", () => {
  test("counts rows that trace to a source document, and rows that do not", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    // 31 realized "rows" are a derived walk, not imported rows
    expect(s.provenance).toMatchObject({ rowCount: 121, sourcedRowCount: 90, unsourcedRowCount: 31 });
  });

  test("a line with no source document is named, not silently averaged away", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    expect(s.provenance.unsourcedLines).toEqual(["Realized gains"]);
  });

  test("a fully sourced year says so", () => {
    const clean = REAL.filter((l) => l.id !== "realized");
    const s = yearSummary({ year: 2025, lines: clean });
    expect(s.provenance.unsourcedRowCount).toBe(0);
    expect(s.provenance.unsourcedLines).toEqual([]);
    expect(s.provenance.complete).toBe(true);
  });

  test("any unsourced row makes the year incomplete", () => {
    expect(yearSummary({ year: 2025, lines: REAL }).provenance.complete).toBe(false);
  });

  test("every distinct source document is listed once, sorted", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    expect(s.provenance.documents).toEqual([
      "chase-2025-01.pdf",
      "chase-2025-02.pdf",
      "chase-2025-06.pdf",
      "robinhood-2025.csv",
      "sofi-2025.csv",
    ]);
  });
});

describe("yearSummary — a pass-through's return leg", () => {
  const withCounter: YearLineInput[] = [
    { ...REAL.find((l) => l.id === "family")!, counterCents: 4880000, counterLabel: "sent back" },
  ];

  test("the returning leg is carried through to the reader", () => {
    const line = yearSummary({ year: 2025, lines: withCounter }).sections.find(
      (x) => x.id === "excluded",
    )!.lines[0]!;
    expect(line.counterCents).toBe(4880000);
    expect(line.counterLabel).toBe("sent back");
  });

  test("and is summed into nothing at all", () => {
    const s = yearSummary({ year: 2025, lines: withCounter });
    expect(s.sections.find((x) => x.id === "excluded")!.totalCents).toBe(341275);
    expect(s.excludedCents).toBe(341275);
    expect(s.totalReceivedCents).toBe(0);
  });

  test("a line with no return leg carries none", () => {
    const line = yearSummary({ year: 2025, lines: REAL }).sections
      .flatMap((x) => x.lines)
      .find((l) => l.id === "fordham")!;
    expect(line.counterCents).toBeUndefined();
  });
});

describe("yearSummary — caveats travel with their figure", () => {
  test("a caveated line keeps its caveat", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    const realized = s.sections
      .flatMap((x) => x.lines)
      .find((l) => l.id === "realized");
    expect(realized?.caveat).toMatch(/Estimated/);
  });

  test("the summary reports whether ANY figure is caveated", () => {
    expect(yearSummary({ year: 2025, lines: REAL }).hasCaveats).toBe(true);
    const clean = REAL.filter((l) => l.caveat === undefined);
    expect(yearSummary({ year: 2025, lines: clean }).hasCaveats).toBe(false);
  });
});

describe("yearSummary — what it refuses", () => {
  test("a duplicate line id is a caller bug, not a silent double-count", () => {
    expect(() =>
      yearSummary({ year: 2025, lines: [...REAL, REAL[0]!] }),
    ).toThrow(/duplicate/i);
  });

  test("more sourced rows than rows is impossible and is refused", () => {
    const bad = [{ ...REAL[0]!, sourcedRowCount: 99 }];
    expect(() => yearSummary({ year: 2025, lines: bad })).toThrow(/sourced/i);
  });

  test("a year outside the Gregorian range this ledger can hold is refused", () => {
    expect(() => yearSummary({ year: 0, lines: REAL })).toThrow(/year/i);
    expect(() => yearSummary({ year: 12345, lines: REAL })).toThrow(/year/i);
  });

  test("an empty year is empty, not an error", () => {
    const s = yearSummary({ year: 2019, lines: [] });
    expect(s.earnedCents).toBe(0);
    expect(s.totalReceivedCents).toBe(0);
    expect(s.isEmpty).toBe(true);
    expect(s.sections.every((x) => x.lines.length === 0)).toBe(true);
  });

  test("a year with any line at all is not empty", () => {
    expect(yearSummary({ year: 2025, lines: [REAL[0]!] }).isEmpty).toBe(false);
  });
});

/**
 * The partition is the whole point of the page: the owner separates these
 * families on every tab, and a summary that quietly added a financial-aid
 * refund to his wages would misstate what he earned by 43%.
 */
describe("yearSummary — the partition holds", () => {
  test("every line lands in exactly one section", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    const seen = s.sections.flatMap((x) => x.lines.map((l) => l.id));
    expect(seen.sort()).toEqual(REAL.map((l) => l.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the section totals sum to every line, kept-out money included", () => {
    const s = yearSummary({ year: 2025, lines: REAL });
    const all = REAL.reduce((t, l) => t + l.amountCents, 0);
    expect(s.sections.reduce((t, x) => t + x.totalCents, 0)).toBe(all);
  });
});
