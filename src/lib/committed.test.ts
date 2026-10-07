import { describe, expect, test } from "vitest";
import type { Cadence } from "@/db/schema/recurring";
import {
  arrearsSentence,
  baselineCaption,
  baselineSpan,
  monthCount,
  endingLead,
  endingOthersClause,
  heaviestMonth,
  heaviestMonthEnding,
  COMMITTED_ORIGIN_LABEL,
  monthHorizon,
  shrinkCaption,
  withinMonthHorizon,
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
  /** the series' own cadence and end day — what a FULL horizon would have billed */
  over: { cadence?: Cadence; endsOn?: string | null } = {},
): CommittedOccurrence[] {
  return dates.map((date) => ({
    seriesId: seriesIdOf(name),
    name,
    date,
    amountCents,
    lastMatchedOn,
    isStale: lastMatchedOn === null,
    cadence: over.cadence ?? "monthly",
    endsOn: over.endsOn ?? null,
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
    ...occ("Car insurance", -36149, monthly("11", 5), null, { endsOn: "2027-01-11" }),
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
    cadence: "monthly",
    endsOn: null,
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

/*
 * 🔴 Measured on the owner's ledger 2026-10-07: the runway card read "A further
 * $2,296.20 came due earlier this month and never posted." while October is
 * imported for none of the accounts those bills post from, and /budgets said
 * the same money is "due by today and no import has covered them yet". "Never
 * posted" is a claim the ledger can make only of days it has read.
 */
describe("arrears — never posted only of days the ledger has read", () => {
  const RENT_LATE: CommittedOccurrence = {
    seriesId: seriesIdOf("Rent"),
    name: "Rent",
    date: "2026-10-01",
    amountCents: -210900,
    lastMatchedOn: "2026-09-01",
    cadence: "monthly",
    endsOn: null,
    isStale: false,
  };

  test("the unread part of each arrears payment is summed beside the arrears", () => {
    const book = committedOutflows({
      ...REAL,
      overdue: [
        { ...RENT_LATE, unreadCents: 210900 },
        { ...RENT_LATE, seriesId: "fpl", name: "FPL", amountCents: -8720, unreadCents: 0 },
      ],
    });
    expect(book.overdueCents).toBe(219620);
    expect(book.overdueUnreadCents).toBe(210900);
  });

  test("an arrears payment that says nothing of coverage is counted unread, the cautious way", () => {
    const book = committedOutflows({ ...REAL, overdue: [RENT_LATE] });
    expect(book.overdueUnreadCents).toBe(210900);
  });

  test("nothing late, nothing said", () => {
    expect(arrearsSentence({ overdueCents: 0, overdueUnreadCents: 0 })).toBeNull();
  });

  test("days the ledger has read may say never posted", () => {
    expect(arrearsSentence({ overdueCents: 229620, overdueUnreadCents: 0 })).toBe(
      "A further $2,296.20 came due earlier this month and never posted.",
    );
  });

  test("days no import covers say so in /budgets' words, never 'never posted'", () => {
    const s = arrearsSentence({ overdueCents: 229620, overdueUnreadCents: 229620 })!;
    expect(s).toBe("A further $2,296.20 came due earlier this month and no import has covered it yet.");
    expect(s).not.toContain("never posted");
  });

  test("a mix names each part by what the ledger can say of it", () => {
    expect(arrearsSentence({ overdueCents: 229620, overdueUnreadCents: 210900 })).toBe(
      "A further $2,296.20 came due earlier this month: $187.20 never posted, and no import has covered the other $2,109.00 yet.",
    );
  });
});

describe("COMMITTED_ORIGIN_LABEL", () => {
  test("names both origins without repeating a reserved page phrase", () => {
    expect(COMMITTED_ORIGIN_LABEL.overdue).toBe("already late");
    expect(COMMITTED_ORIGIN_LABEL.upcoming).toBe("scheduled");
  });
});

describe("baselineCaption", () => {
  /*
   * 🔴 The raw month key, on the dashboard, beside two cards naming the SAME
   * window "Mar 2026 to Aug 2026". Found 2026-09-11 by rendering all 197 routes
   * and grepping their prose for machine values.
   */
  test("names the months it averaged, the way the cards beside it do", () => {
    expect(baselineCaption({ months: 6, fromMonth: "2026-03", toMonth: "2026-08" })).toBe(
      "Spending averaged over 6 complete months, Mar 2026 to Aug 2026. This month is still running and is not counted.",
    );
  });

  /** ⚖️ §6A 51: an average that leaves the car's up-front money out says so; one with none says nothing new. */
  test("names the car's up-front money it left out, and only when there is some", () => {
    expect(baselineCaption({ months: 6, fromMonth: "2026-04", toMonth: "2026-09", upfrontCarCents: 610_000 })).toBe(
      "Spending averaged over 6 complete months, Apr 2026 to Sep 2026, leaving out the $6,100.00 paid up front for the " +
        "car, which the car card spreads over the lease. This month is still running and is not counted.",
    );
    expect(baselineCaption({ months: 6, fromMonth: "2026-04", toMonth: "2026-09", upfrontCarCents: 0 })).toBe(
      "Spending averaged over 6 complete months, Apr 2026 to Sep 2026. This month is still running and is not counted.",
    );
  });

  test("a one-month window is singular, and is not a range", () => {
    const c = baselineCaption({ months: 1, fromMonth: "2022-09", toMonth: "2022-09" });
    expect(c).toContain("1 complete month,");
    expect(c).not.toContain("months");
    expect(c).toContain("Sep 2022.");
    expect(c).not.toContain("Sep 2022 to Sep 2022");
  });

  /**
   * 🔴 The caption `baselineWindow`'s own fallback would have produced: "0
   * complete months, 2022-09 to 2022-09. This month is still running and is
   * not counted" — a range made of the single month the same sentence says was
   * excluded. It cannot be a range because there is nothing in it.
   */
  test("an empty window names no months at all", () => {
    const c = baselineCaption({ months: 0, fromMonth: "2022-09", toMonth: "2022-09" });
    expect(c).toBe("No complete month has been imported yet, so there is no spending average to stand on.");
    expect(c).not.toContain("2022-09");
    expect(c).not.toContain("Sep 2022");
    expect(c).not.toContain("0 complete");
  });
});

describe("monthHorizon", () => {
  test("spans whole calendar months from the day it opens", () => {
    const h = monthHorizon("2026-09-15", 6);
    expect(h).toEqual({
      from: "2026-09-15",
      months: 6,
      endMonth: "2027-03",
      endDay: 15,
      projectThrough: "2027-03-31",
      nominalEnd: "2027-03-15",
    });
  });

  /** 🔴 The clamp: 29 August + 6 months has no 29 February to land on. */
  test("records the end MONTH even when the calendar cannot hold the end DAY", () => {
    const h = monthHorizon("2026-08-29", 6);
    expect(h.nominalEnd).toBe("2027-02-28"); // clamped, and a day short of six months
    expect(h.endMonth).toBe("2027-02");
    expect(h.endDay).toBe(29); // …but the window still ends before the 29th of it
    expect(h.projectThrough).toBe("2027-02-28");
  });

  test("refuses a window that is not a positive whole number of months", () => {
    expect(() => monthHorizon("2026-09-15", 0)).toThrow(RangeError);
    expect(() => monthHorizon("2026-09-15", 1.5)).toThrow(RangeError);
  });
});

describe("withinMonthHorizon", () => {
  const h = monthHorizon("2026-08-29", 6); // endMonth 2027-02, endDay 29

  test("every month before the last one is inside, and every month after is not", () => {
    expect(withinMonthHorizon(h, "2026-09-28", 28)).toBe(true);
    expect(withinMonthHorizon(h, "2027-01-31", 31)).toBe(true);
    expect(withinMonthHorizon(h, "2027-03-01", 1)).toBe(false);
    // and nothing before the day it opened
    expect(withinMonthHorizon(h, "2026-08-28", 28)).toBe(false);
  });

  /**
   * 🔴 THE FOUR ANCHORS THAT SHARE ONE DATE. February 2027 clamps the 28th,
   * 29th, 30th and 31st all onto 2027-02-28 — and they need different answers,
   * which is the whole reason this is not a date comparison. The 28th's sixth
   * payment is inside a six-month window opened on 29 August; the 29th's,
   * 30th's and 31st's would be a SEVENTH.
   */
  test("separates four series that the calendar put on the same day", () => {
    expect(withinMonthHorizon(h, "2027-02-28", 28)).toBe(true);
    expect(withinMonthHorizon(h, "2027-02-28", 29)).toBe(false);
    expect(withinMonthHorizon(h, "2027-02-28", 30)).toBe(false);
    expect(withinMonthHorizon(h, "2027-02-28", 31)).toBe(false);
  });

  /** A day-stepped cadence never clamps, so its own day IS its anchor day. */
  test("with no anchor day it falls back to the date's own day", () => {
    expect(withinMonthHorizon(h, "2027-02-28", null)).toBe(true); // 28 < 29
    expect(withinMonthHorizon(monthHorizon("2026-08-15", 6), "2027-02-20", null)).toBe(false);
  });

  /**
   * ⛔ WHY `projectThrough` REACHES THE END OF THE MONTH and admitting nothing
   * new is not an accident worth deleting.
   *
   * Occurrences are projected through the whole end month and then filtered, so
   * a clamped one cannot be missed. This proves the over-fetch is SAFE rather
   * than load-bearing: over every asking day of two years, three horizon
   * lengths and all 31 anchor days — 67,890 gradings — nothing admitted by the
   * horizon ever falls after `nominalEnd`. A mutation that projected only to
   * `nominalEnd` therefore survives the service sweep, and is equivalent for
   * exactly this reason. If the engine's clamping ever changes, this fails
   * first and the over-fetch starts earning its keep.
   */
  test("over-fetching past the nominal end admits nothing new, on any day of two years", () => {
    const daysInMonth = (m: string): number => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
    let graded = 0;
    const late: string[] = [];
    for (let d = 0; d < 730; d++) {
      const today = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      for (const months of [1, 6, 12]) {
        const win = monthHorizon(today, months);
        for (let anchor = 1; anchor <= 31; anchor++) {
          // the engine's own clamp: an occurrence lands on the anchor day, or on
          // the month's last day when the month is too short to hold it
          const day = `${win.endMonth}-${String(Math.min(anchor, daysInMonth(win.endMonth))).padStart(2, "0")}`;
          graded += 1;
          if (withinMonthHorizon(win, day, anchor) && day > win.nominalEnd) late.push(`${today}/${months}/${anchor}`);
        }
      }
    }
    expect(graded).toBe(730 * 3 * 31);
    expect(late).toEqual([]);
  });
});

/*
 * ⭐ WHAT SHRANK THE RATE — the owner's call on 2026-09-02.
 *
 * Two cards on his dashboard state the monthly cost of the SAME thirteen series
 * and differ by $210.87: the runway card publishes a RATE over a twelve-month
 * horizon, the subscriptions card LEVELS each bill to a month. Both are right,
 * and the whole difference is one series that stops inside the horizon — car
 * insurance is evidenced through 2027-01-11 with no renewal in the ledger, so
 * it is billed five times out of twelve. He asked the runway card to say so.
 *
 * ⛔ The predicate is the CAUSE (a series that ends inside the horizon), never
 * an arithmetic comparison. `levelledMonthlyCents` rounds, so a full-horizon
 * annual line can miss its rate by a cent, and a threshold on that difference
 * would be a magic number standing where a fact belongs.
 */
describe("committedOutflows — the series that shrink the rate", () => {
  test("a line that runs the whole horizon has no shortfall at all", () => {
    const book = committedOutflows(REAL);
    for (const l of book.lines.filter((x) => x.name !== "Car insurance")) {
      expect(l.shortfallPerMonthCents, `${l.name} claims a shortfall`).toBe(0);
      expect(l.endsInHorizon, `${l.name} claims to end`).toBe(false);
    }
  });

  test("a line that ends inside the horizon carries the whole difference", () => {
    const book = committedOutflows(REAL);
    const ins = book.lines.find((l) => l.name === "Car insurance")!;
    expect(ins.endsInHorizon).toBe(true);
    expect(ins.endsOn).toBe("2027-01-11");
    expect(ins.occurrences).toBe(5);
    expect(ins.perOccurrenceCents).toBe(36149);
    // five payments over a SIX month horizon
    expect(ins.perMonthCents).toBe(Math.round((36149 * 5) / 6));
    expect(ins.levelledPerMonthCents).toBe(36149);
    expect(ins.shortfallPerMonthCents).toBe(36149 - Math.round((36149 * 5) / 6));
    // and it is the only one, so it IS the book's shortfall
    expect(book.shortfallPerMonthCents).toBe(ins.shortfallPerMonthCents);
  });

  /* ⚠️ An ending series with a NON-monthly cadence must level by its cadence,
     not by its occurrence count — the trap `levelledMonthlyCents` exists for. */
  test("a quarterly bill that ends is levelled by its cadence", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: occ("Parking", -36886, ["2026-09-20", "2026-12-20"], "2026-06-20", {
        cadence: "quarterly",
        endsOn: "2027-01-01",
      }),
    });
    const line = book.lines[0]!;
    expect(line.occurrences).toBe(2);
    // a quarterly $368.86 is $122.95 a month levelled; two payments over six
    // months is $122.95 a month too — an ending series is not automatically short
    expect(line.levelledPerMonthCents).toBe(12295);
    expect(line.shortfallPerMonthCents).toBe(0);
  });

  /*
   * ⛔ THE MUTANT THAT SURVIVED THE FIRST PASS, and the whole reason the gate is
   * on the CAUSE. A quarterly bill whose payments happen to land only once in a
   * six-month window is NOT ending — it bills every three months for ever — but
   * its levelled monthly ($122.95) is twice what a single payment spread over
   * six months comes to ($61.48). Ungated, that arithmetic would report a
   * $61.47-a-month "shrink" and the caption would name a series with no end
   * date at all, as the reason a rate is lower.
   */
  test("a line that is merely SPARSE in the window is not short", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: occ("Parking", -36886, ["2027-02-20"], "2026-11-20", { cadence: "quarterly" }),
    });
    const line = book.lines[0]!;
    expect(line.endsOn).toBeNull();
    expect(line.endsInHorizon).toBe(false);
    expect(line.levelledPerMonthCents).toBeGreaterThan(line.perMonthCents);
    expect(line.shortfallPerMonthCents).toBe(0);
    expect(book.shortfallPerMonthCents).toBe(0);
    expect(shrinkCaption(book)).toBeNull();
  });

  test("a series ending exactly at the horizon's end is not short", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: occ("Gym", -10000, monthly("05"), "2026-08-05", { endsOn: "2027-02-24" }),
    });
    // `to` is EXCLUSIVE, so an end ON it is outside the horizon
    expect(book.lines[0]!.endsInHorizon).toBe(false);
    expect(book.shortfallPerMonthCents).toBe(0);
  });
});

describe("shrinkCaption", () => {
  test("a book with nothing ending says nothing", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: occ("Rent", -228570, monthly("01"), "2026-07-08"),
    });
    expect(shrinkCaption(book)).toBeNull();
  });

  test("it names the series, its end, the count and BOTH per-month figures", () => {
    const caption = shrinkCaption(committedOutflows(REAL))!;
    expect(caption).toContain("Car insurance");
    // the day in a SENTENCE, not the key the column stores — `dayWindowLabel`
    expect(caption).toContain("Jan 11, 2027");
    expect(caption).not.toContain("2027-01-11");
    expect(caption).toContain("billed 5 times");
    expect(caption).toContain("$301.24"); // its contribution to the rate
    expect(caption).toContain("$361.49"); // what it actually charges
    expect(caption).toContain("$60.25"); // how much lower the rate is for it
  });

  /* A commitment with one payment left is billed "once", not "1 times" — the
     branch a horizon with a single remaining charge takes, and the one the
     coverage gate on src/lib refused to let ship unstated. */
  test("a series with one payment left is billed once", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: occ("Storage unit", -9000, ["2026-09-03"], "2026-08-03", { endsOn: "2026-10-01" }),
    });
    const caption = shrinkCaption(book)!;
    expect(caption).toContain("billed once rather than throughout");
    expect(caption).not.toContain("1 times");
  });

  /* ⛔ It must not say "the rate is $X lower" when a SECOND series is also
     short — the named one would then be credited with the whole difference. */
  test("more than one ending series is counted, and the rest are not silently dropped", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: [
        ...occ("Car insurance", -36149, monthly("11", 5), null, { endsOn: "2027-01-11" }),
        ...occ("Storage unit", -9000, monthly("03", 3), "2026-08-03", { endsOn: "2026-12-01" }),
      ],
    });
    const caption = shrinkCaption(book)!;
    expect(caption).toContain("Car insurance");
    expect(caption).toContain("one other");
    expect(book.shortfallPerMonthCents).toBeGreaterThan(
      book.lines.find((l) => l.name === "Car insurance")!.shortfallPerMonthCents,
    );
  });

  test("three or more ending series are counted in the plural", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: [
        ...occ("Car insurance", -36149, monthly("11", 5), null, { endsOn: "2027-01-11" }),
        ...occ("Storage unit", -9000, monthly("03", 3), "2026-08-03", { endsOn: "2026-12-01" }),
        ...occ("Locker", -1000, monthly("04", 2), "2026-08-04", { endsOn: "2026-11-01" }),
      ],
    });
    expect(shrinkCaption(book)!).toContain("2 others");
  });
});

/**
 * The line `shrinkCaption` leads with, as a value — so a second surface can name
 * the same commitment rather than pick its own. The car card picked the
 * EARLIEST end date of any car series instead, and on 2026-09-15 printed the
 * one-payment Nov 11 balance under the word "Insurance" beside a runway card
 * leading with the premium's Jan 11, 2027.
 */
describe("endingLead", () => {
  test("nothing ending is no lead", () => {
    expect(endingLead(committedOutflows({ ...REAL, occurrences: occ("Rent", -228570, monthly("01"), null) }))).toBeNull();
  });

  test("the lead is the line that shrinks the rate most, not the one that ends first", () => {
    const book = committedOutflows({
      ...REAL,
      occurrences: [
        ...occ("Car insurance", -35758, ["2026-12-11", "2027-01-11"], null, { endsOn: "2027-01-11" }),
        ...occ("Nov 11 balance", -7274, ["2026-11-11"], null, { endsOn: "2026-11-11" }),
      ],
    });
    const lead = endingLead(book)!;
    expect(lead.lead.name).toBe("Car insurance");
    expect(lead.endsOn).toBe("2027-01-11");
    expect(lead.others).toBe(1);
  });

  test("the others are counted in the words shrinkCaption uses", () => {
    expect(endingOthersClause(0)).toBe("");
    expect(endingOthersClause(1)).toBe(", and one other does too");
    expect(endingOthersClause(2)).toBe(", and 2 others do too");
  });
});

/**
 * 🔴 The car card's "a month, while both are billed" summed the first
 * occurrence of every series — $1,125.36 on the owner's ledger, a month no
 * calendar holds. What a month bills is read off the months themselves.
 */
describe("heaviestMonth", () => {
  test("no payments is no month", () => {
    expect(heaviestMonth([])).toEqual({ cents: 0, month: null, seriesIds: [] });
  });

  test("the month that bills the most, summed by calendar month, and who bills in it", () => {
    const occurrences = [
      ...occ("Lease", -69504, ["2026-09-15", "2026-10-15", "2026-11-15", "2026-12-15"], null),
      ...occ("Insurance", -35758, ["2026-12-11"], null),
      ...occ("Balance", -7274, ["2026-11-11"], null),
    ];
    const heaviest = heaviestMonth(occurrences);
    expect(heaviest.cents).toBe(69504 + 35758);
    expect(heaviest.month).toBe("2026-12");
    expect([...heaviest.seriesIds].sort()).toEqual(["insurance", "lease"]);
  });

  /* the figure is dated by when it STOPS being paid, so a tie keeps the later month */
  test("a tie keeps the later month", () => {
    const occurrences = [
      ...occ("Lease", -69504, ["2026-12-15", "2027-01-15", "2027-02-15"], null),
      ...occ("Insurance", -35758, ["2026-12-11", "2027-01-11"], null),
    ];
    expect(heaviestMonth(occurrences).month).toBe("2027-01");
  });

  /* ⛔ money in is never netted against money out — the rule this module owns */
  test("money in does not lower a month", () => {
    const occurrences = [...occ("Lease", -69504, ["2026-09-15"], null), ...occ("Refund", 50000, ["2026-09-20"], null)];
    expect(heaviestMonth(occurrences).cents).toBe(69504);
  });

  /**
   * 🔴 A review measured this on 2026-09-15: the lease plus $20 weekly on
   * October 2026's five Fridays read $795.04 — and the month with four would
   * have read $775.04 — so which month had the extra Friday chose "a month".
   */
  test("a series billed more often than monthly counts at its levelled rate, whichever month has the extra Friday", () => {
    const fridays = ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"];
    const occurrences = [
      ...occ("Lease", -69504, ["2026-10-15", "2026-11-15"], null),
      ...occ("Parking", -2000, fridays, null, { cadence: "weekly" }),
    ];
    const heaviest = heaviestMonth(occurrences);
    // $20 × 52 ÷ 12 = $86.67 — October (five Fridays) and November (four) alike, so the later is kept
    expect(heaviest.cents).toBe(69504 + 8667);
    expect(heaviest.month).toBe("2026-11");
    expect(heaviest.cents).not.toBe(69504 + 5 * 2000);
  });

  /* a monthly-or-longer series bills at most once a calendar month: its month holds the bill */
  test("a quarterly bill counts in full in the month it bills", () => {
    const occurrences = [
      ...occ("Lease", -69504, ["2026-10-15", "2026-11-15"], null),
      ...occ("Registration", -30000, ["2026-11-02"], null, { cadence: "quarterly" }),
    ];
    expect(heaviestMonth(occurrences).cents).toBe(69504 + 30000);
  });

  /**
   * ⚠️ THE LIMIT, PINNED. A one-payment REMAINDER in a month the bill it remains
   * of also bills is summed in beside it — a review demonstrated $1,125.36 again
   * with the owner's $72.74 moved from Nov 11 to Dec 11 (2026-09-15). It cannot
   * be dropped: its occurrences are the same as a second policy paid ahead to
   * its last payment, which does bill that month. On the owner's ledger the
   * balance falls in November, which the premium does not bill.
   */
  test("a one-payment remainder beside its own bill counts, because a last payment paid ahead looks the same", () => {
    const lease = occ("Lease", -69504, ["2026-12-15"], null);
    const premium = occ("Car insurance", -35758, ["2026-12-11"], "2026-08-12", { endsOn: "2027-01-11" });
    const remainder = [...lease, ...premium, ...occ("Dec 11 balance", -7274, ["2026-12-11"], null, { endsOn: "2026-12-11" })];
    const lastPaymentPaidAhead = [...lease, ...premium, ...occ("Roadside cover", -7274, ["2026-12-11"], null, { endsOn: "2026-12-11" })];
    expect(heaviestMonth(lastPaymentPaidAhead).cents).toBe(69504 + 35758 + 7274);
    expect(heaviestMonth(remainder).cents).toBe(heaviestMonth(lastPaymentPaidAhead).cents);
  });
});

/**
 * 🔴 The car card's date came from `endingLead`, the runway's answer to "which
 * ending line lowers the RATE most". The card asks when its MONTHLY figure
 * stops being what he pays — and a review built the book where those are two
 * different lines (2026-09-15).
 */
describe("heaviestMonthEnding", () => {
  const TWELVE = { from: "2026-09-15", to: "2027-09-15", months: 12, overdue: [] };
  const LEASE_YEAR = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08"];
  const endingOf = (occurrences: CommittedOccurrence[]) =>
    heaviestMonthEnding(committedOutflows({ ...TWELVE, occurrences }), heaviestMonth(occurrences));

  test("a lease that ends after the policy: the policy stops the figure first, though the lease lowers the rate more", () => {
    const occurrences = [
      ...occ("Car lease", -69504, LEASE_YEAR.slice(0, 6).map((m) => `${m}-15`), null, { endsOn: "2027-02-15" }),
      ...occ("Car insurance", -35758, ["2026-10-11", "2026-11-11"], null, { endsOn: "2026-11-11" }),
    ];
    const ending = endingOf(occurrences)!;
    expect([ending.lead.name, ending.endsOn, ending.others]).toEqual(["Car insurance", "2026-11-11", 1]);
    // the runway's rate sentence leads with the lease, and is right to
    expect(endingLead(committedOutflows({ ...TWELVE, occurrences }))!.lead.name).toBe("Car lease");
  });

  test("the owner's car on 2026-09-15: the premium through Jan 11, 2027 — the line the runway names too", () => {
    const occurrences = [
      ...occ("Car lease", -69504, LEASE_YEAR.map((m) => `${m}-15`), null, { endsOn: "2028-08-15" }),
      ...occ("Car insurance", -35758, ["2026-12-11", "2027-01-11"], "2026-08-12", { endsOn: "2027-01-11" }),
      ...occ("Nov 11 balance", -7274, ["2026-11-11"], null, { endsOn: "2026-11-11" }),
    ];
    const ending = endingOf(occurrences)!;
    expect([ending.lead.name, ending.endsOn, ending.others]).toEqual(["Car insurance", "2027-01-11", 1]);
    expect(endingLead(committedOutflows({ ...TWELVE, occurrences }))!.lead.name).toBe("Car insurance");
  });

  /* the balance stops inside the horizon, but in a month lighter than the
     lease and a premium that runs on — so the figure does not stop with it;
     `endingLead` would have named it */
  test("a line that ends outside the heaviest month does not stop the figure", () => {
    const occurrences = [
      ...occ("Car lease", -69504, LEASE_YEAR.map((m) => `${m}-15`), null),
      ...occ("Car insurance", -35758, LEASE_YEAR.slice(3).map((m) => `${m}-11`), "2026-08-12"),
      ...occ("Nov 11 balance", -7274, ["2026-11-11"], null, { endsOn: "2026-11-11" }),
    ];
    expect(endingOf(occurrences)).toBeNull();
    expect(endingLead(committedOutflows({ ...TWELVE, occurrences }))!.lead.name).toBe("Nov 11 balance");
  });

  test("nothing ending is no lead", () => {
    expect(endingOf(occ("Car lease", -69504, LEASE_YEAR.map((m) => `${m}-15`), null))).toBeNull();
  });
});

describe("monthCount", () => {
  test("the noun agrees with the count", () => {
    expect(monthCount(6, "complete")).toBe("6 complete months");
    expect(monthCount(1, "complete")).toBe("1 complete month");
    expect(monthCount(4)).toBe("4 months");
    expect(monthCount(1)).toBe("1 month");
  });
});

/**
 * The window phrase every caption beside the runway card reads. Two of them
 * spelled it themselves and, replayed on the owner's ledger, printed "Averaged
 * over 0 complete months, Sep 2022" (today 2022-09-10) and "1 complete months"
 * (today 2022-10-15).
 */
describe("baselineSpan", () => {
  test("names the count and the months", () => {
    expect(baselineSpan({ months: 6, fromMonth: "2026-03", toMonth: "2026-08" })).toBe(
      "6 complete months, Mar 2026 to Aug 2026",
    );
    expect(baselineSpan({ months: 1, fromMonth: "2022-09", toMonth: "2022-09" })).toBe("1 complete month, Sep 2022");
  });

  test("zero months is not a range", () => {
    expect(baselineSpan({ months: 0, fromMonth: "2022-09", toMonth: "2022-09" })).toBeNull();
  });
});
