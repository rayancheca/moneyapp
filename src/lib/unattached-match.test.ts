import { describe, expect, it } from "vitest";
import { formatDayShort } from "@/lib/format-date";
import { unattachedCents, unattachedMatches, unattachedRowsWords, type UnattachedRow } from "./unattached-match";

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
});
