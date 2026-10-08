import { describe, expect, test } from "vitest";
import { arrearsSplit, arrearsTail, NO_IMPORT_YET, splitClause } from "./arrears-reading";

/**
 * 🔴 The rent's own page read "Already due, and not posted" of an Oct 1 no import had reached (his ledger,
 * 2026-10-08), while the runway on the same ledger said the same $2,291.21 "came due earlier this month and no import
 * has covered it yet". One split, every surface: the part of the arrears on days the ledger has read may be called
 * unposted; the rest may not.
 */
describe("arrearsSplit", () => {
  test("nothing unread is all read", () => {
    expect(arrearsSplit({ owedCents: 210900, unreadCents: 0 })).toEqual({ readCents: 210900, unreadCents: 0, kind: "read" });
  });

  test("all of it unread is unread", () => {
    expect(arrearsSplit({ owedCents: 210900, unreadCents: 210900 })).toEqual({
      readCents: 0,
      unreadCents: 210900,
      kind: "unread",
    });
  });

  test("part of it unread is mixed", () => {
    expect(arrearsSplit({ owedCents: 3000, unreadCents: 1000 })).toEqual({ readCents: 2000, unreadCents: 1000, kind: "mixed" });
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
