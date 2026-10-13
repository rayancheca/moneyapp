import { describe, expect, test } from "vitest";
import { largestLead } from "./largest-lead";

/*
 * 🔴 One has no largest. "Since Dec 2022, 1 charge is filed on Fees itself … The largest is $0.15" on his dashboard (a
 * copy of his ledger, 2026-10-13) was fixed in the fees card alone, and the Subscriptions card kept "The largest is
 * Dead streaming" over ONE lapsed line, in a test that asked for it — and /spending's chart description "The largest
 * move is Rent" over "1 category moved". One rule, every sentence that names the largest of a count.
 */
describe("largestLead — the words that name the largest of a count", () => {
  test("two or more have a largest", () => {
    expect(largestLead(2)).toBe("The largest is");
    expect(largestLead(14)).toBe("The largest is");
    expect(largestLead(2, "move")).toBe("The largest move is");
  });

  test("one is 'it' — or, with a noun, 'the <noun>'", () => {
    expect(largestLead(1)).toBe("It is");
    expect(largestLead(1, "charge")).toBe("The charge is");
    expect(largestLead(1, "move")).toBe("The move is");
  });
});
