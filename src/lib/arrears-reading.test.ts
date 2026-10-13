import { describe, expect, test } from "vitest";
import {
  arrearsAlarms,
  arrearsClause,
  arrearsSplit,
  arrearsTail,
  DAYS_TO_POST_NOT_OVER,
  NO_IMPORT_YET,
  overdueReading,
  splitClause,
} from "./arrears-reading";

/**
 * 🔴 The rent's own page read "Already due, and not posted" of an Oct 1 no import had reached (his ledger,
 * 2026-10-08), while the runway on the same ledger said the same $2,291.21 "came due earlier this month and no import
 * has covered it yet". One split, every surface: the part of the arrears on days the ledger has read may be called
 * unposted; the rest may not.
 */
describe("arrearsSplit", () => {
  test("nothing unread is all read", () => {
    expect(arrearsSplit({ owedCents: 210900, unreadCents: 0 })).toEqual({
      readCents: 210900,
      unreadCents: 0,
      inGraceCents: 0,
      kind: "read",
    });
  });

  test("all of it unread is unread", () => {
    expect(arrearsSplit({ owedCents: 210900, unreadCents: 210900 })).toEqual({
      readCents: 0,
      unreadCents: 210900,
      inGraceCents: 0,
      kind: "unread",
    });
  });

  test("part of it unread is mixed", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000 })).toEqual({
      readCents: 2000,
      unreadCents: 1000,
      inGraceCents: 0,
      kind: "mixed",
    });
  });

  test("never more unread than is owed, and never less than nothing", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 9000 })).toMatchObject({ readCents: 0, unreadCents: 3000 });
    expect(arrearsSplit({ owedCents: 3000, unreadCents: -5 })).toMatchObject({ readCents: 3000, unreadCents: 0 });
  });
});

describe("arrearsTail — the words after a lead, in the runway's voice", () => {
  test("read: the surface's own word for unposted", () => {
    expect(arrearsTail({ owedCents: 210900, unreadCents: 0 }, "has not posted")).toBe(" and has not posted");
  });

  test("unread: never 'not posted' — no import has covered it yet", () => {
    const tail = arrearsTail({ owedCents: 210900, unreadCents: 210900 }, "has not posted");
    expect(tail).toBe(` and ${NO_IMPORT_YET}`);
    expect(tail).not.toMatch(/not posted/);
  });

  test("mixed: both halves, each named by its amount", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 1000 }, "never posted")).toBe(
      ": $20.00 never posted, and no import has covered the other $10.00 yet",
    );
    expect(splitClause(arrearsSplit({ owedCents: 3000, unreadCents: 1000 }), "not posted")).toBe(
      "$20.00 not posted, and no import has covered the other $10.00 yet",
    );
  });
});

/*
 * 🔴 An archived card's bill due Oct 6 read "no import has covered it yet" on Oct 8, on every arrears surface (review of
 * the 2026-10-08 batch) — an import /imports will never ask for. Its account is read through today; what it waits for
 * is its days to post (`inGraceCents`). ⚖️ No new verdict: unread and quiet as before — the words only.
 */
describe("an unread half no import is keeping unread — its days to post", () => {
  test("never more of it than is unread, and never less than nothing", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000, inGraceCents: 9000 }).inGraceCents).toBe(1000);
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000, inGraceCents: -5 }).inGraceCents).toBe(0);
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 0, inGraceCents: 3000 }).inGraceCents).toBe(0);
  });

  test("all of the unread waits on its days to post: says so — for one bill or several — and stays quiet", () => {
    const reading = { owedCents: 4500, unreadCents: 4500, inGraceCents: 4500 };
    expect(arrearsTail(reading, "never posted")).toBe(` and ${DAYS_TO_POST_NOT_OVER}`);
    expect(arrearsClause(reading, "not posted", "them")).toBe("the days a payment has to post are not over yet");
    expect(arrearsAlarms(reading)).toBe(false);
  });

  test("beside a read half, both by amount", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 1000, inGraceCents: 1000 }, "never posted")).toBe(
      ": $20.00 never posted, and the days a payment has to post for the other $10.00 are not over yet",
    );
  });

  /*
   * ⚠️ Only a sum of several bills can hold both kinds of unread — one bill's accounts are read through today or not.
   * An import IS awaited for part of it, so the import's words stay: true of that part, and quiet like the rest.
   */
  test("an import awaited for any of it keeps the import's words", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 3000, inGraceCents: 1000 }, "never posted")).toBe(
      ` and ${NO_IMPORT_YET}`,
    );
    expect(arrearsTail({ owedCents: 3000, unreadCents: 2000, inGraceCents: 1000 }, "never posted")).toBe(
      ": $10.00 never posted, and no import has covered the other $20.00 yet",
    );
  });
});

describe("overdueReading — a bill's own arrears, as its page and its End dialog say them", () => {
  test("its amount is money out; the read split rides along", () => {
    expect(overdueReading({ amountCents: -4500, unreadCents: 4500, inGraceCents: 4500 })).toEqual({
      owedCents: 4500,
      unreadCents: 4500,
      inGraceCents: 4500,
    });
  });
});

/**
 * 🔴 The runway printed "A further $2,291.21 came due earlier this month and no import has covered it yet." in red on
 * a copy of his ledger 2026-10-08 — the one surface still sounding an alarm over money the rent's page, the Next
 * column and /categories said quietly. ⚖️ Staleness between uploads is normal, never a warning (his words 2026-08-05).
 */
describe("arrearsAlarms — the tone every arrears surface takes", () => {
  test("arrears on days the ledger has read sound it", () => {
    expect(arrearsAlarms({ owedCents: 210900, unreadCents: 0 })).toBe(true);
  });

  test("arrears no import has reached do not", () => {
    expect(arrearsAlarms({ owedCents: 229121, unreadCents: 229121 })).toBe(false);
  });

  test("a mix does, for the part that is late", () => {
    expect(arrearsAlarms({ owedCents: 3000, unreadCents: 1000 })).toBe(true);
  });

  test("nothing owed sounds nothing", () => {
    expect(arrearsAlarms({ owedCents: 0, unreadCents: 0 })).toBe(false);
  });
});
