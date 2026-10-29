import { describe, expect, it } from "vitest";
import { formatDayShort } from "@/lib/format-date";
import {
  countedDepositWords,
  neverClauses,
  neverSplit,
  notCountedWords,
  unattachedCents,
  unattachedMatches,
  unattachedRowsWords,
  type UnattachedMatch,
  type UnattachedRow,
} from "./unattached-match";

const row = (id: string, postedOn: string, amountCents: number): UnattachedRow => ({ id, postedOn, amountCents });

describe("unattachedMatches — a row matching a payday or due day to the cent, within the series' own tolerance", () => {
  it("matches each of his four October paydays to its own payroll row (his ledger copy 2026-10-29)", () => {
    const days = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"].map((date) => ({ date, amountCents: 114192 }));
    const rows = [
      row("a", "2026-10-01", 114192),
      row("b", "2026-10-08", 114192),
      row("off", "2026-10-15", 20000),
      row("c", "2026-10-15", 114192),
      row("d", "2026-10-22", 114192),
    ];
    expect(unattachedMatches(days, rows, 3).map((m) => [m.date, m.row.id])).toEqual([
      ["2026-10-01", "a"],
      ["2026-10-08", "b"],
      ["2026-10-15", "c"],
      ["2026-10-22", "d"],
    ]);
  });

  it("is to the cent: a row a cent off, or of the other sign, matches nothing", () => {
    const days = [{ date: "2026-10-15", amountCents: -69504 }];
    expect(unattachedMatches(days, [row("x", "2026-10-15", -69503)], 3)).toEqual([]);
    expect(unattachedMatches(days, [row("x", "2026-10-15", 69504)], 3)).toEqual([]);
    expect(unattachedMatches(days, [row("x", "2026-10-15", -69504)], 3)).toHaveLength(1);
  });

  it("reaches exactly the tolerance either side of the day, and not a day past it", () => {
    const days = [{ date: "2026-10-15", amountCents: -69504 }];
    expect(unattachedMatches(days, [row("x", "2026-10-18", -69504)], 3)).toHaveLength(1);
    expect(unattachedMatches(days, [row("x", "2026-10-12", -69504)], 3)).toHaveLength(1);
    expect(unattachedMatches(days, [row("x", "2026-10-19", -69504)], 3)).toEqual([]);
    expect(unattachedMatches(days, [row("x", "2026-10-11", -69504)], 3)).toEqual([]);
    // a tolerance of 0 is the day itself
    expect(unattachedMatches(days, [row("x", "2026-10-16", -69504)], 0)).toEqual([]);
  });

  it("spends a row once: two days a row could answer take it once, the nearer day first", () => {
    const days = [
      { date: "2026-10-01", amountCents: 1000 },
      { date: "2026-10-04", amountCents: 1000 },
    ];
    const matches = unattachedMatches(days, [row("only", "2026-10-03", 1000)], 3);
    expect(matches.map((m) => [m.date, m.row.id])).toEqual([["2026-10-04", "only"]]);
  });

  it("gives a day its nearest row, the earlier on a tie", () => {
    const days = [{ date: "2026-10-15", amountCents: 1000 }];
    const rows = [row("late", "2026-10-17", 1000), row("near", "2026-10-14", 1000), row("tie", "2026-10-16", 1000)];
    expect(unattachedMatches(days, rows, 3)[0]!.row.id).toBe("near");
    expect(unattachedMatches(days, [row("b", "2026-10-16", 1000), row("a", "2026-10-14", 1000)], 3)[0]!.row.id).toBe(
      "a",
    );
  });

  it("sums the matched rows' money as a magnitude", () => {
    const matches = unattachedMatches([{ date: "2026-10-15", amountCents: -69504 }], [row("x", "2026-10-15", -69504)], 3);
    expect(unattachedCents(matches)).toBe(69504);
  });
});

describe("unattachedRowsWords — the row's day and amount, said where a surface would have claimed absence", () => {
  it("names one row by its amount and day", () => {
    const matches = unattachedMatches([{ date: "2026-10-15", amountCents: -69504 }], [row("x", "2026-10-15", -69504)], 3);
    expect(unattachedRowsWords(matches, formatDayShort)).toBe("a row of $695.04 on Oct 15 that is not attached to it");
  });

  it("names several rows of one amount once, and of several amounts each", () => {
    const same = unattachedMatches(
      ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"].map((date) => ({ date, amountCents: 114192 })),
      ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"].map((d, i) => row(String(i), d, 114192)),
      3,
    );
    expect(unattachedRowsWords(same, formatDayShort)).toBe(
      "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that are not attached to it",
    );
    const mixed = unattachedMatches(
      [
        { date: "2026-10-01", amountCents: -50000 },
        { date: "2026-10-15", amountCents: -25000 },
      ],
      [row("a", "2026-10-02", -50000), row("b", "2026-10-15", -25000)],
      3,
    );
    expect(unattachedRowsWords(mixed, formatDayShort)).toBe(
      "rows of $500.00 on Oct 2 and $250.00 on Oct 15 that are not attached to it",
    );
  });

  /*
   * 🔴 Review of de31d22 (HIGH): the next import ATTACHES his payroll rows and files none of them, so his pay's
   * settlement counts none — and a row attached is no row "not attached to it". ⚖️ Default built, not asked
   * (2026-10-29): it is said as what it is, attached and not filed as income.
   */
  it("says a row attached and not filed as income as what it is — alone, together, and beside one not attached", () => {
    const attached = (id: string, postedOn: string): UnattachedRow => ({ ...row(id, postedOn, 114192), notFiledAsIncome: true });
    const days = ["2026-10-01", "2026-10-08", "2026-10-15"].map((date) => ({ date, amountCents: 114192 }));
    const one = unattachedMatches(days.slice(0, 1), [attached("a", "2026-10-01")], 3);
    expect(unattachedRowsWords(one, formatDayShort)).toBe(
      "a row of $1,141.92 on Oct 1 that is attached to it but not filed as income",
    );
    const two = unattachedMatches(days.slice(0, 2), [attached("a", "2026-10-01"), attached("b", "2026-10-08")], 3);
    expect(unattachedRowsWords(two, formatDayShort)).toBe(
      "rows of $1,141.92 on Oct 1 and Oct 8 that are attached to it but not filed as income",
    );
    const both = unattachedMatches(
      days,
      [row("x", "2026-10-01", 114192), row("y", "2026-10-08", 114192), attached("z", "2026-10-15")],
      3,
    );
    expect(unattachedRowsWords(both, formatDayShort)).toBe(
      "rows of $1,141.92 on Oct 1 and Oct 8 that are not attached to it, and a row of $1,141.92 on Oct 15 that is " +
        "attached to it but not filed as income",
    );
  });
});

describe("what a deposit lacks, said where a surface would have said 'with no deposit'", () => {
  const plain: UnattachedMatch[] = [{ date: "2026-10-01", row: row("a", "2026-10-01", 114192) }];
  const filedNowhere: UnattachedMatch[] = [
    { date: "2026-10-08", row: { ...row("b", "2026-10-08", 114192), notFiledAsIncome: true } },
  ];

  it("names attachment alone while every row is unattached, and the filing too once one is attached", () => {
    expect(countedDepositWords(plain, "this schedule")).toBe("attached to this schedule");
    expect(countedDepositWords(filedNowhere, "it")).toBe("attached to it and filed as income");
    expect(countedDepositWords([...plain, ...filedNowhere], "it")).toBe("attached to it and filed as income");
  });

  it("says what the rows are not: attached, filed as income, or — some of each — one or the other", () => {
    expect(notCountedWords(plain, "the schedule")).toBe("not attached to the schedule");
    expect(notCountedWords(filedNowhere, "the schedule")).toBe("not filed as income");
    expect(notCountedWords([...plain, ...filedNowhere], "the schedule")).toBe(
      "not attached to the schedule or not filed as income",
    );
  });
});

/*
 * ⛔ ONE SPLIT of a "never reached a bank" figure by the rows the one rule matched — Earned vs banked's difference and
 * /spending's shortfall note (review of de31d22: the note said "none of it reached a bank" beside the card's rows).
 */
describe("neverSplit and neverClauses — the never figure, less what the rows answer, never more than it", () => {
  const four: UnattachedMatch[] = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"].map((d, i) => ({
    date: d,
    row: row(String(i), d, 114192),
  }));
  const fmt = formatDayShort;

  it("caps what the rows answer at the figure: a net $941.92 short is all the rows', never $1,141.92", () => {
    expect(neverSplit(94192, four.slice(3))).toEqual({ cents: 94192, matchedCents: 94192, matched: four.slice(3) });
    expect(neverSplit(0, four)).toEqual({ cents: 0, matchedCents: 0, matched: [] });
  });

  // ⛔ …and says so: the figure is the payday's, the row matches the PAYDAY — never "$941.92 is matched to the cent by a
  // row of $1,141.92" (a copy of his ledger read Nov 2, with Oct 15's $200.00 toward no payday netted into October)
  it("names a capped figure as its paydays', which the rows match to the cent", () => {
    expect(neverClauses(neverSplit(94192, four.slice(3)), fmt, { ofIt: false, bare: false })).toEqual([
      "$941.92 is for the payday of Oct 22, which a row of $1,141.92 on Oct 22 that is not attached to it matches to " +
        "the cent",
    ]);
    expect(neverClauses(neverSplit(200000, four.slice(0, 2)), fmt, { ofIt: true, bare: true })).toEqual([
      "all of it is for the paydays of Oct 1 and Oct 8, which rows of $1,141.92 on Oct 1 and Oct 8 that are not " +
        "attached to it match to the cent",
    ]);
  });

  it("says the figure as the card says it, of it, and as the note says it, plain", () => {
    const rows = "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that are not attached to it";
    expect(neverClauses(neverSplit(1111700, []), fmt, { ofIt: true, bare: true })).toEqual(["never reached a bank"]);
    expect(neverClauses(neverSplit(456768, four), fmt, { ofIt: true, bare: true })).toEqual([
      `all of it is matched to the cent by ${rows}`,
    ]);
    expect(neverClauses(neverSplit(1568468, four), fmt, { ofIt: true, bare: false })).toEqual([
      "$11,117.00 of it never reached a bank",
      `$4,567.68 is matched to the cent by ${rows}`,
    ]);
    expect(neverClauses(neverSplit(228384, four.slice(0, 1)), fmt, { ofIt: false, bare: false })).toEqual([
      "$1,141.92 never reached a bank",
      "$1,141.92 is matched to the cent by a row of $1,141.92 on Oct 1 that is not attached to it",
    ]);
    expect(neverClauses(neverSplit(114192, four.slice(0, 1)), fmt, { ofIt: false, bare: false })).toEqual([
      "$1,141.92 is matched to the cent by a row of $1,141.92 on Oct 1 that is not attached to it",
    ]);
  });
});
