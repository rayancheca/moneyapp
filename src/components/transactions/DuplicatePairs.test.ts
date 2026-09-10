import { describe, expect, test } from "vitest";
import { undoLabel } from "./DuplicatePairs";

const sides = [
  { id: "t1", postedOn: "2024-07-11", amountCents: -15_000, sourceLabel: "chase-2024-07.pdf" },
  { id: "t2", postedOn: "2024-07-11", amountCents: -15_000, sourceLabel: "chase-2024-07 (1).pdf" },
];

/**
 * 🔴 71 of these render on `/transactions?view=duplicates` and "Undo" was the
 * whole accessible name of every one. The sibling on the same card was fixed
 * for exactly this — "both rows carry this button, and 'Retire this one' twice
 * tells a screen-reader user nothing about which one" — and each Undo restores
 * a superseded transaction into every total, a different amount per pair.
 */
describe("undoLabel", () => {
  test("names the money, the source and the day of the copy coming back", () => {
    expect(
      undoLabel({
        resolution: "confirmed_duplicate",
        accountName: "Chase Checking",
        retiredTransactionId: "t2",
        sides,
      }),
    ).toBe("Restore the retired $150.00 copy from chase-2024-07 (1).pdf on 2024-07-11");
  });

  test("it is the RETIRED side that comes back, not the first one listed", () => {
    const first = undoLabel({
      resolution: "confirmed_duplicate",
      accountName: "Chase Checking",
      retiredTransactionId: "t1",
      sides,
    });
    expect(first).toContain("chase-2024-07.pdf");
    expect(first).not.toContain("(1).pdf");
  });

  test("a pair kept as two real charges retired nothing, so it reopens", () => {
    expect(
      undoLabel({
        resolution: "dismissed",
        accountName: "Discover",
        retiredTransactionId: null,
        sides,
      }),
    ).toBe("Reopen the Discover pair kept as two real charges");
  });

  test("a confirmed pair whose retired row is unknown still names the account", () => {
    expect(
      undoLabel({
        resolution: "confirmed_duplicate",
        accountName: "Discover",
        retiredTransactionId: null,
        sides: [],
      }),
    ).toBe("Restore the retired copy on Discover");
  });

  test("no two settled pairs on one page share a name", () => {
    const a = undoLabel({ resolution: "confirmed_duplicate", accountName: "Chase Checking", retiredTransactionId: "t2", sides });
    const b = undoLabel({
      resolution: "confirmed_duplicate",
      accountName: "Chase Checking",
      retiredTransactionId: "t3",
      sides: [{ id: "t3", postedOn: "2024-08-11", amountCents: -4_000, sourceLabel: "chase-2024-08.pdf" }],
    });
    expect(a).not.toBe(b);
  });
});
