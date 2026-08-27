import { describe, expect, test } from "vitest";
import {
  countFact,
  deltaFact,
  factSet,
  rankFact,
  scalarFact,
  shareFact,
  trendFact,
} from "./insight-facts";

describe("a fact renders itself, and the caller cannot disagree with it", () => {
  test("display comes from value, so the words and the number cannot drift", () => {
    expect(scalarFact("f1", "Dining", 196324, "money").display).toBe("$1,963.24");
    expect(scalarFact("f1", "Runway", 1.3, "months").display).toBe("1.3 months");
    expect(scalarFact("f1", "Runway", 1, "months").display).toBe("1 month");
    expect(scalarFact("f1", "Gap", 0, "days").display).toBe("0 days");
    expect(scalarFact("f1", "Accounts", 12, "plain").display).toBe("12");
    expect(shareFact("f1", "ETH", 0.323, "everything you own").display).toBe("32.3%");
  });

  test("a delta keeps its sign and a scalar never grows one", () => {
    expect(deltaFact("f1", "Travel", 99800, "money", "June", "July").display).toBe("+$998.00");
    expect(deltaFact("f1", "Travel", -99800, "money", "June", "July").display).toBe("-$998.00");
    expect(deltaFact("f1", "Travel", 0, "money", "June", "July").display).toBe("$0.00");
    expect(scalarFact("f1", "Travel", 99800, "money").display).toBe("$998.00");
  });

  test("zero is not an increase in any unit", () => {
    // "+0.0%" would claim a rise that did not happen; formatCentsSigned already
    // drops the sign at zero and every other unit follows it
    expect(deltaFact("f1", "Rent", 0, "percent", "June", "July").display).toBe("0.0%");
    expect(deltaFact("f1", "Rent", 0, "days", "June", "July").display).toBe("0 days");
    expect(deltaFact("f1", "Rent", 0, "plain", "June", "July").display).toBe("0");
    expect(deltaFact("f1", "Rent", -0.5, "plain", "June", "July").display).toBe("-0.5");
    expect(deltaFact("f1", "Rent", -2, "days", "June", "July").display).toBe("-2 days");
    expect(deltaFact("f1", "Rent", -0.05, "percent", "June", "July").display).toBe("-5.0%");
  });

  test("a count says what it counted, and pluralises it", () => {
    expect(countFact("f1", "Dining", 502, "purchase").display).toBe("502 purchases");
    expect(countFact("f1", "Dining", 1, "purchase").display).toBe("1 purchase");
    expect(countFact("f1", "Dining", 0, "purchase").display).toBe("0 purchases");
    expect(countFact("f1", "Rows", 10111, "row").display).toBe("10,111 rows");
  });

  test("a rank displays the ordinal alone — the set size is its frame, not its value", () => {
    // "3rd of 22" in the display AND "22 categories" in the frame produced
    // "sits 1st of 2 of your 2 spending categories" the first time one template
    // read both
    expect(rankFact("f1", "Dining", 1, 22, "categories").display).toBe("1st");
    expect(rankFact("f1", "Dining", 2, 22, "categories").display).toBe("2nd");
    expect(rankFact("f1", "Dining", 3, 22, "categories").display).toBe("3rd");
    expect(rankFact("f1", "Dining", 4, 22, "categories").display).toBe("4th");
    // the teens are the case an ordinal helper always gets wrong
    expect(rankFact("f1", "Dining", 11, 22, "categories").display).toBe("11th");
    expect(rankFact("f1", "Dining", 12, 22, "categories").display).toBe("12th");
    expect(rankFact("f1", "Dining", 13, 22, "categories").display).toBe("13th");
    expect(rankFact("f1", "Dining", 21, 22, "categories").display).toBe("21st");
    expect(rankFact("f1", "Dining", 111, 222, "categories").display).toBe("111th");
  });

  test("a trend states how many observations it read", () => {
    expect(trendFact("f1", "Dining", "rising", "March", 6).display).toBe("rising across 6 months since March");
    expect(trendFact("f1", "Rent", "flat", "March", 12).display).toBe("flat across 12 months since March");
  });
});

describe("what a fact refuses to be", () => {
  test("a slot id must look like a slot", () => {
    expect(() => scalarFact("total", "Dining", 1, "money")).toThrow(/must look like/);
    expect(() => scalarFact("f0", "Dining", 1, "money")).toThrow(/must look like/);
    expect(() => scalarFact("", "Dining", 1, "money")).toThrow(/must look like/);
    expect(scalarFact("f10", "Dining", 1, "money").id).toBe("f10");
  });

  test("a label cannot open a tag, a brace or an escape", () => {
    expect(() => scalarFact("f1", "<b>Dining</b>", 1, "money")).toThrow(/cannot contain/);
    expect(() => scalarFact("f1", "{{f2.value}}", 1, "money")).toThrow(/cannot contain/);
    expect(() => scalarFact("f1", "   ", 1, "money")).toThrow(/cannot be empty/);
    expect(() => countFact("f1", "Dining", 1, "<i>x")).toThrow(/cannot contain/);
    expect(() => shareFact("f1", "Dining", 0.5, "{x}")).toThrow(/cannot contain/);
    expect(() => rankFact("f1", "Dining", 1, 2, "a\\b")).toThrow(/cannot contain/);
    expect(() => deltaFact("f1", "D", 1, "money", "<a", "July")).toThrow(/cannot contain/);
    expect(() => deltaFact("f1", "D", 1, "money", "June", "<a")).toThrow(/cannot contain/);
    expect(() => trendFact("f1", "D", "rising", "<a", 3)).toThrow(/cannot contain/);
    // digits are fine — "Feb 2026" and "SoFi 9067" are real labels
    expect(scalarFact("f1", "SoFi 9067", 1, "money").subject).toBe("SoFi 9067");
  });

  test("a real share never rounds away to zero, or up to the whole", () => {
    // $4.24 of $10,240.85 is 0.041% — "0.0%" asserts a measured zero about
    // money that was really spent, and it was on a category page before this
    expect(shareFact("f1", "Health", 4.24 / 10_240.85, "everything").display).toBe("<0.1%");
    expect(shareFact("f1", "Health", 0.0004, "everything").display).toBe("<0.1%");
    // and the mirror: 99.96% is not the whole of anything
    expect(shareFact("f1", "Rent", 0.9996, "everything").display).toBe(">99.9%");
    // the boundaries themselves are exact and print normally
    expect(shareFact("f1", "X", 0, "everything").display).toBe("0.0%");
    expect(shareFact("f1", "X", 1, "everything").display).toBe("100.0%");
    expect(shareFact("f1", "X", 0.0005, "everything").display).toBe("0.1%");
    expect(shareFact("f1", "X", 0.9995, "everything").display).toBe(">99.9%");
  });

  test("a delta in percent obeys the same floor", () => {
    // "rose by 0.0%" is the same false sentence with a direction attached.
    // ⚠️ No surface renders a percent DELTA today — every delta in the app is
    // money — so this shape is PINNED rather than chosen. If one ever does,
    // "+<0.1%" is the thing to look at first.
    expect(deltaFact("f1", "Rent", 0.0002, "percent", "Jun", "Jul").display).toBe("+<0.1%");
    expect(deltaFact("f1", "Rent", -0.0002, "percent", "Jun", "Jul").display).toBe("-<0.1%");
  });

  test("a share outside 0–1 is refused, not clamped", () => {
    // 32.3 passed where 0.323 was meant would render 3230.0% and back a
    // "more than half" claim that is arithmetically impossible
    expect(() => shareFact("f1", "ETH", 32.3, "everything")).toThrow(/within 0–1/);
    expect(() => shareFact("f1", "ETH", -0.1, "everything")).toThrow(/within 0–1/);
    expect(shareFact("f1", "ETH", 1, "everything").display).toBe("100.0%");
    expect(shareFact("f1", "ETH", 0, "everything").display).toBe("0.0%");
  });

  test("a trend needs three observations — two points are a line, not a trend", () => {
    expect(() => trendFact("f1", "Dining", "rising", "July", 2)).toThrow(/at least 3/);
    expect(() => trendFact("f1", "Dining", "rising", "July", 0)).toThrow(/at least 3/);
    expect(() => trendFact("f1", "Dining", "rising", "July", 2.5)).toThrow(/at least 3/);
    expect(trendFact("f1", "Dining", "rising", "July", 3).points).toBe(3);
  });

  test("a rank cannot exceed its set, and does not start at zero", () => {
    expect(() => rankFact("f1", "Dining", 0, 22, "categories")).toThrow(/starts at 1/);
    expect(() => rankFact("f1", "Dining", 1.5, 22, "categories")).toThrow(/starts at 1/);
    expect(() => rankFact("f1", "Dining", 23, 22, "categories")).toThrow(/cannot exceed/);
    expect(() => rankFact("f1", "Dining", 1, 1.5, "categories")).toThrow(/cannot exceed/);
  });

  test("a count is a non-negative whole number", () => {
    expect(() => countFact("f1", "Dining", -1, "purchase")).toThrow(/non-negative integer/);
    expect(() => countFact("f1", "Dining", 1.5, "purchase")).toThrow(/non-negative integer/);
  });

  test("a non-finite measurement is refused before it can render as NaN", () => {
    expect(() => scalarFact("f1", "Dining", Number.NaN, "money")).toThrow(/finite/);
    expect(() => scalarFact("f1", "Dining", Number.POSITIVE_INFINITY, "money")).toThrow(/finite/);
    expect(() => deltaFact("f1", "Dining", Number.NaN, "money", "June", "July")).toThrow(/finite/);
  });
});

describe("a fact set", () => {
  test("refuses a duplicate slot", () => {
    // two claims about two subjects rendering through one slot is exactly the
    // ambiguity this whole module exists to make impossible
    expect(() =>
      factSet([scalarFact("f1", "Dining", 1, "money"), scalarFact("f1", "Groceries", 2, "money")]),
    ).toThrow(/Duplicate fact slot f1/);
  });

  test("is keyed by slot id", () => {
    const set = factSet([scalarFact("f1", "Dining", 1, "money"), scalarFact("f2", "Groceries", 2, "money")]);
    expect(set.get("f2")?.subject).toBe("Groceries");
    expect(set.size).toBe(2);
    expect(factSet([]).size).toBe(0);
  });
});
