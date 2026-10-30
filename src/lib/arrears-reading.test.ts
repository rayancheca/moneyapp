import { describe, expect, test } from "vitest";
import {
  arrearsAlarms,
  arrearsClause,
  arrearsSplit,
  arrearsTail,
  DAYS_TO_POST_NOT_OVER,
  HAS_NOT_POSTED,
  NO_STATEMENT_YET,
  NOT_POSTED,
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
      unattachedCents: 0,
      unattached: [],
      kind: "read",
    });
  });

  test("all of it unread is unread", () => {
    expect(arrearsSplit({ owedCents: 210900, unreadCents: 210900 })).toEqual({
      readCents: 0,
      unreadCents: 210900,
      inGraceCents: 0,
      unattachedCents: 0,
      unattached: [],
      kind: "unread",
    });
  });

  test("part of it unread is mixed", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000 })).toEqual({
      readCents: 2000,
      unreadCents: 1000,
      inGraceCents: 0,
      unattachedCents: 0,
      unattached: [],
      kind: "mixed",
    });
  });

  test("never more unread than is owed, and never less than nothing", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 9000 })).toMatchObject({ readCents: 0, unreadCents: 3000 });
    expect(arrearsSplit({ owedCents: 3000, unreadCents: -5 })).toMatchObject({ readCents: 3000, unreadCents: 0 });
  });
});

describe("arrearsTail — the words after a lead, in the runway's voice", () => {
  test("read: the surface's own form of the one word for unposted", () => {
    expect(arrearsTail({ owedCents: 210900, unreadCents: 0 }, HAS_NOT_POSTED)).toBe(" and has not posted");
  });

  test("unread: never 'not posted' — no statement has covered it yet", () => {
    const tail = arrearsTail({ owedCents: 210900, unreadCents: 210900 }, HAS_NOT_POSTED);
    expect(tail).toBe(` and ${NO_STATEMENT_YET}`);
    expect(tail).not.toMatch(/not posted/);
  });

  test("mixed: both halves, each named by its amount", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 1000 }, HAS_NOT_POSTED)).toBe(
      ": $20.00 has not posted, and no statement has covered the other $10.00 yet",
    );
    expect(splitClause(arrearsSplit({ owedCents: 3000, unreadCents: 1000 }), NOT_POSTED)).toBe(
      "$20.00 not posted, and no statement has covered the other $10.00 yet",
    );
  });

  /*
   * ⚖️ His decision 65 (2026-10-12): a due day is read to each account's last CHECKED statement balance
   * (`dueDayReadings`), so the unread half waits for a statement and says so — of one bill, of several, of a remainder.
   */
  test("the unread words name a statement, whatever they are said of", () => {
    expect(NO_STATEMENT_YET).toBe("no statement has covered it yet");
    const unread = { owedCents: 229121, unreadCents: 229121 };
    expect(arrearsClause(unread, "not posted", "them")).toBe("no statement has covered them yet");
    const mixed = arrearsClause({ owedCents: 3000, unreadCents: 1000 }, "not posted");
    for (const words of [NO_STATEMENT_YET, arrearsClause(unread, "not posted", "them"), mixed]) {
      expect(words).not.toMatch(/import/);
    }
  });
});

/*
 * 🔴 THE RUNWAY'S OWN WORD. Every other surface said the read half "has not posted" or "not posted" (his decisions 60
 * and 65) — the math table "came due Oct 1 and has not posted", /budgets' row "$X expected by now and not posted" —
 * while the runway alone said "$45.00 never posted" (pinned in e2e/decision-cards.spec.ts): its own word, passed in as
 * a free string. The words live here now, one per grammar — after a lead that has a subject, and in a fragment — and
 * no other can be passed.
 */
describe("the read half's words — one home, two grammars", () => {
  test("'has not posted' after a lead, 'not posted' in a fragment", () => {
    expect(HAS_NOT_POSTED).toBe("has not posted");
    expect(NOT_POSTED).toBe("not posted");
  });

  test("no surface may pass its own word for it", () => {
    // @ts-expect-error — "never posted" was the runway's own word; the type admits only the two above
    expect(arrearsTail({ owedCents: 4500, unreadCents: 0 }, "never posted")).toBe(" and never posted");
  });
});

/*
 * 🔴 An archived card's bill due Oct 6 read "no import has covered it yet" on Oct 8, on every arrears surface (review of
 * the 2026-10-08 batch) — an import /imports will never ask for. Its account is read through today; what it waits for
 * is its days to post (`inGraceCents`). ⚖️ No new verdict: unread and quiet as before — the words only.
 */
describe("an unread half no statement is keeping unread — its days to post", () => {
  test("never more of it than is unread, and never less than nothing", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000, inGraceCents: 9000 }).inGraceCents).toBe(1000);
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000, inGraceCents: -5 }).inGraceCents).toBe(0);
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 0, inGraceCents: 3000 }).inGraceCents).toBe(0);
  });

  test("all of the unread waits on its days to post: says so — for one bill or several — and stays quiet", () => {
    const reading = { owedCents: 4500, unreadCents: 4500, inGraceCents: 4500 };
    expect(arrearsTail(reading, HAS_NOT_POSTED)).toBe(` and ${DAYS_TO_POST_NOT_OVER}`);
    expect(arrearsClause(reading, "not posted")).toBe("the days a payment has to post are not over yet");
    // 🔴 of several bills (/budgets' page note) it said the one-bill words (review of 384917c): "them", as "no statement
    // has covered them yet" does
    expect(arrearsClause(reading, "not posted", "them")).toBe("the days their payments have to post are not over yet");
    expect(arrearsTail(reading, NOT_POSTED, "them")).toBe(" and the days their payments have to post are not over yet");
    expect(arrearsAlarms(reading)).toBe(false);
  });

  test("beside a read half, both by amount", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 1000, inGraceCents: 1000 }, HAS_NOT_POSTED)).toBe(
      ": $20.00 has not posted, and the days a payment has to post for the other $10.00 are not over yet",
    );
  });

  /*
   * ⚠️ Only a sum of several bills can hold both kinds of unread — one bill's accounts are read through today or not.
   * A statement IS awaited for part of it, so the statement's words stay (decision 65): true of that part, and quiet
   * like the rest.
   */
  test("a statement awaited for any of it keeps the statement's words", () => {
    expect(arrearsTail({ owedCents: 3000, unreadCents: 3000, inGraceCents: 1000 }, HAS_NOT_POSTED)).toBe(
      ` and ${NO_STATEMENT_YET}`,
    );
    expect(arrearsTail({ owedCents: 3000, unreadCents: 2000, inGraceCents: 1000 }, HAS_NOT_POSTED)).toBe(
      ": $10.00 has not posted, and no statement has covered the other $20.00 yet",
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

  test("arrears no checked statement has reached do not", () => {
    expect(arrearsAlarms({ owedCents: 229121, unreadCents: 229121 })).toBe(false);
  });

  test("a mix does, for the part that is late", () => {
    expect(arrearsAlarms({ owedCents: 3000, unreadCents: 1000 })).toBe(true);
  });

  test("nothing owed sounds nothing", () => {
    expect(arrearsAlarms({ owedCents: 0, unreadCents: 0 })).toBe(false);
  });
});
