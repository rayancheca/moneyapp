import { describe, expect, test } from "vitest";
import {
  COMMITTED_ORIGIN_LABEL,
  committedOutflows,
  type CommittedInput,
  type CommittedOccurrence,
} from "./committed";

/**
 * The real committed book, measured on the live ledger 2026-08-24 over the six
 * months to 2027-02-24 before a line of this module existed. Five confirmed
 * money-out series and nothing else — every other series the detector holds is
 * either income, or lapsed and therefore not a commitment:
 *
 *   Flamingo South Beach (rent)   $2,285.70 × 6  = $13,714.20   last paid 2026-07-08
 *   Car lease                       $559.89 × 6  =  $3,359.34   never posted, ends 2028-08-11
 *   Car insurance                   $361.49 × 5  =  $1,807.45   never posted, ends 2027-01-11
 *   Breezeline (internet)            $50.00 × 6  =    $300.00   last paid 2026-07-10
 *   FPL (electricity)                $14.21 × 6  =     $85.26   last paid 2026-07-10
 *                                                  ──────────
 *                                                  $19,266.25   = $3,211.04/month
 *
 * The insurance line is the one worth having in a fixture: it stops inside the
 * horizon, so it contributes FIVE payments where every other monthly series
 * contributes six. A fixture where every series ran the full window could not
 * tell a correct occurrence count from `months × 1`.
 */
const seriesIdOf = (name: string): string => name.toLowerCase().replace(/\W+/g, "-");

function occ(
  name: string,
  amountCents: number,
  dates: readonly string[],
  lastMatchedOn: string | null,
): CommittedOccurrence[] {
  return dates.map((date) => ({
    seriesId: seriesIdOf(name),
    name,
    date,
    amountCents,
    lastMatchedOn,
    isStale: lastMatchedOn === null,
  }));
}

const SIX_MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"];
const monthly = (day: string, n = 6): string[] => SIX_MONTHS.slice(0, n).map((m) => `${m}-${day}`);

const REAL: CommittedInput = {
  from: "2026-08-24",
  to: "2027-02-24",
  months: 6,
  occurrences: [
    ...occ("Flamingo South Beach (rent)", -228570, monthly("01"), "2026-07-08"),
    ...occ("Car lease", -55989, monthly("11"), null),
    ...occ("Car insurance", -36149, monthly("11", 5), null),
    ...occ("Breezeline (internet)", -5000, monthly("10"), "2026-07-10"),
    ...occ("FPL (electricity)", -1421, monthly("10"), "2026-07-10"),
  ],
  overdue: [],
};

describe("committedOutflows — the real book", () => {
  test("totals the measured six-month commitment", () => {
    const result = committedOutflows(REAL);
    expect(result.totalCents).toBe(1926625);
    expect(result.perMonthCents).toBe(321104);
  });

  test("names every series, largest commitment first", () => {
    const result = committedOutflows(REAL);
    expect(result.lines.map((l) => [l.name, l.totalCents, l.occurrences])).toEqual([
      ["Flamingo South Beach (rent)", 1371420, 6],
      ["Car lease", 335934, 6],
      ["Car insurance", 180745, 5],
      ["Breezeline (internet)", 30000, 6],
      ["FPL (electricity)", 8526, 6],
    ]);
  });

  test("a series that stops inside the horizon contributes fewer payments", () => {
    const insurance = committedOutflows(REAL).lines.find((l) => l.name === "Car insurance");
    // five payments, not six — 361.49 × 5, and the count says so out loud
    expect(insurance).toMatchObject({ occurrences: 5, totalCents: 180745 });
    expect(insurance?.perMonthCents).toBe(30124); // 180745 / 6, NOT 180745 / 5
  });

  test("discloses which commitments have never been evidenced", () => {
    const result = committedOutflows(REAL);
    // the car is registered and real, but nothing has posted against it yet
    expect(result.unevidencedCents).toBe(335934 + 180745);
    expect(result.lines.filter((l) => l.neverPosted).map((l) => l.name)).toEqual([
      "Car lease",
      "Car insurance",
    ]);
  });
});

describe("committedOutflows — arithmetic that must not drift", () => {
  test("the lines sum to the total", () => {
    const result = committedOutflows(REAL);
    expect(result.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(result.totalCents);
  });

  test("two commitments of equal size sort by name, so the order is stable", () => {
    // Without a tiebreak the render order would depend on Map insertion, and a
    // list that reshuffles between renders is a list nobody can read twice.
    const result = committedOutflows({
      ...REAL,
      occurrences: [
        ...occ("Zeta storage", -5000, ["2026-09-03"], null),
        ...occ("Alpha storage", -5000, ["2026-09-04"], null),
      ],
    });
    expect(result.lines.map((l) => l.name)).toEqual(["Alpha storage", "Zeta storage"]);
  });

  test("an empty book is zero, not a division by zero", () => {
    const result = committedOutflows({ ...REAL, occurrences: [] });
    expect(result).toMatchObject({ totalCents: 0, perMonthCents: 0, unevidencedCents: 0 });
    expect(result.lines).toEqual([]);
  });

  test("rejects a horizon of zero months rather than dividing by it", () => {
    expect(() => committedOutflows({ ...REAL, months: 0 })).toThrow(/months/i);
    expect(() => committedOutflows({ ...REAL, months: -1 })).toThrow(/months/i);
  });

  test("a fractional month count is refused — a commitment book is billed, not prorated", () => {
    expect(() => committedOutflows({ ...REAL, months: 1.5 })).toThrow(/months/i);
  });
});

/**
 * The failure this module exists to make unrepresentable.
 *
 * `upcomingOccurrences` returns income AND bills from one call. A caller that
 * forgets to filter would hand this an income series, and netting $4,188 of
 * salary against $3,211 of rent would publish a committed book of roughly zero
 * — the same shape as pass 62's "$0.14 expected income", where a figure with
 * defensible arithmetic was substantively false.
 *
 * Throwing would move the crash into a render path (pass 62 shipped one of
 * those too). So money-in is PARTITIONED and reported, never netted and never
 * fatal — `attribution.ts`'s rule, that a disagreement is disclosed rather than
 * clamped away.
 */
describe("committedOutflows — money in is never netted against money out", () => {
  const withSalary: CommittedInput = {
    ...REAL,
    occurrences: [...REAL.occurrences, ...occ("Cash job (weekly pay)", 104700, monthly("07"), "2026-06-05")],
  };

  test("the total is unchanged by an inflow that should never have been passed", () => {
    expect(committedOutflows(withSalary).totalCents).toBe(committedOutflows(REAL).totalCents);
  });

  test("the inflow is reported so the caller's mistake is visible, not silent", () => {
    const result = committedOutflows(withSalary);
    expect(result.inflowCents).toBe(628200);
    expect(result.inflowCount).toBe(6);
  });

  test("a clean book reports no inflow", () => {
    expect(committedOutflows(REAL)).toMatchObject({ inflowCents: 0, inflowCount: 0 });
  });

  test("a zero-amount occurrence is neither an outflow nor an inflow", () => {
    const result = committedOutflows({
      ...REAL,
      occurrences: [...REAL.occurrences, ...occ("Placeholder", 0, ["2026-09-01"], null)],
    });
    expect(result.totalCents).toBe(1926625);
    expect(result.inflowCount).toBe(0);
    expect(result.lines.some((l) => l.name === "Placeholder")).toBe(false);
  });
});

/**
 * An overdue bill is money that came due and never posted. It is COMMITTED in
 * the strongest sense — more certain than any projection, because the date has
 * already passed — so it joins the total, and it is labelled by ORIGIN so the
 * reader can tell "already late" from "coming up".
 */
describe("committedOutflows — overdue bills", () => {
  const RENT_LATE: CommittedOccurrence = {
    seriesId: seriesIdOf("Flamingo South Beach (rent)"),
    name: "Flamingo South Beach (rent)",
    date: "2026-08-01",
    amountCents: -228570,
    lastMatchedOn: "2026-07-08",
    isStale: false,
  };
  const overdue: CommittedInput = { ...REAL, overdue: [RENT_LATE] };

  /*
   * ⛔ ARREARS ARE COUNTED, REPORTED, AND LEFT OUT — the same treatment an
   * inflow gets, and for the same reason.
   *
   * 🔴 They used to join `totalCents`. The horizon is `[from, to)`, exactly
   * `months` calendar months, and a payment that came due BEFORE `from` is not
   * inside it — the input type has always said so ("payments that came due
   * before `from`"). Adding it to the numerator while `months` stayed the
   * denominator is how a $2,109.00 rent came to publish $2,284.75 as its
   * monthly cost on the owner's dashboard, every day of the month but the 1st.
   */
  test("arrears are reported beside the total, never inside it", () => {
    const book = committedOutflows(overdue);
    expect(book.totalCents).toBe(1926625);
    expect(book.overdueCents).toBe(228570);
    expect(book.overdueCount).toBe(1);
    // and a caller that wants "everything still owed" adds the two itself
    expect(book.totalCents + book.overdueCents).toBe(1926625 + 228570);
  });

  test("a per-month figure divides only what the months actually contain", () => {
    const book = committedOutflows(overdue);
    expect(book.perMonthCents).toBe(Math.round(1926625 / book.months));
  });

  test("an overdue bill folds into its own series' line, not a second row", () => {
    const rent = committedOutflows(overdue).lines.filter(
      (l) => l.name === "Flamingo South Beach (rent)",
    );
    expect(rent).toHaveLength(1);
    // one row, and the arrears sit BESIDE its horizon total rather than in it —
    // so the occurrence count still counts only payments inside the horizon
    expect(rent[0]).toMatchObject({ occurrences: 6, totalCents: 1371420, overdueCents: 228570 });
  });

  test("a line carries no overdue when nothing is late", () => {
    expect(committedOutflows(REAL).lines.every((l) => l.overdueCents === 0)).toBe(true);
    expect(committedOutflows(REAL).overdueCents).toBe(0);
  });

  test("an overdue bill for a series with no upcoming occurrence still gets a line", () => {
    const gone: CommittedInput = {
      ...REAL,
      occurrences: [],
      overdue: [RENT_LATE],
    };
    const result = committedOutflows(gone);
    expect(result.lines).toHaveLength(1);
    // the debt is real and named, but nothing of it falls inside the horizon, so
    // the horizon total is zero — the line exists to carry the arrears
    expect(result.lines[0]).toMatchObject({ occurrences: 0, totalCents: 0, overdueCents: 228570 });
    expect(result.totalCents).toBe(0);
    expect(result.overdueCents).toBe(228570);
  });

  test("an overdue inflow is partitioned exactly like an upcoming one", () => {
    const result = committedOutflows({
      ...REAL,
      overdue: [{ ...RENT_LATE, name: "A refund", amountCents: 5000 }],
    });
    expect(result.totalCents).toBe(1926625);
    expect(result.inflowCents).toBe(5000);
  });
});

describe("COMMITTED_ORIGIN_LABEL", () => {
  test("names both origins without repeating a reserved page phrase", () => {
    expect(COMMITTED_ORIGIN_LABEL.overdue).toBe("already late");
    expect(COMMITTED_ORIGIN_LABEL.upcoming).toBe("scheduled");
  });
});
