import { describe, expect, test } from "vitest";
import {
  MoneyParseError,
  assertValidCents,
  formatCents,
  formatCentsSigned,
  parseAmountToCents,
  sumCents,
} from "./money";

describe("parseAmountToCents", () => {
  test.each([
    ["1234.56", 123_456],
    ["$1,234.56", 123_456],
    ["-43.64", -4_364],
    ["(43.64)", -4_364],
    ["($43.64)", -4_364],
    ["( $43.64 )", -4_364],
    ["+12", 1_200],
    ["0", 0],
    ["0.00", 0],
    [".5", 50],
    ["-.5", -50],
    ["1,234", 123_400],
    ["  99.99  ", 9_999],
    ["$0.01", 1],
    ["123456789.12", 12_345_678_912],
  ])("parses %s -> %d cents", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  test("negative sign inside parentheses double-negates", () => {
    expect(parseAmountToCents("(-5.00)")).toBe(500);
  });

  test("never returns negative zero", () => {
    expect(Object.is(parseAmountToCents("(0.00)"), 0)).toBe(true);
    expect(Object.is(parseAmountToCents("-0.00"), 0)).toBe(true);
  });

  test.each([
    ["1.005", 101],
    ["1.004", 100],
    ["-1.005", -101],
    ["2.999", 300],
  ])("rounds half away from zero: %s -> %d", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  test.each(["", "   ", "-", "$", "abc", "12.34.56", "1,23.45", "12a.50", "()"])(
    "rejects invalid input %j",
    (input) => {
      expect(() => parseAmountToCents(input)).toThrow(MoneyParseError);
    },
  );

  // bank-reality forms that institution parsers must pre-normalize before
  // calling this function — pinned as LOUD rejections, never silent misparse
  test.each(["$-43.64", "43.64-", "43.64 CR", "43.64DR"])(
    "rejects unnormalized bank form %j (parser profiles pre-normalize these)",
    (input) => {
      expect(() => parseAmountToCents(input)).toThrow(MoneyParseError);
    },
  );

  test("rejects amounts that overflow safe integer cents", () => {
    expect(() => parseAmountToCents("99999999999999999999")).toThrow(MoneyParseError);
  });
});

describe("sumCents / assertValidCents", () => {
  test("sums signed values", () => {
    expect(sumCents([100, -250, 50])).toBe(-100);
  });

  test("empty sum is zero", () => {
    expect(sumCents([])).toBe(0);
  });

  test("rejects non-integer cents", () => {
    expect(() => sumCents([10.5])).toThrow(RangeError);
    expect(() => assertValidCents(Number.NaN)).toThrow(RangeError);
    expect(() => assertValidCents(2 ** 53)).toThrow(RangeError);
  });
});

describe("formatting", () => {
  test("formatCents renders USD", () => {
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(-4_364)).toBe("-$43.64");
    expect(formatCents(0)).toBe("$0.00");
  });

  test("formatCentsSigned carries an explicit sign on every non-zero amount", () => {
    expect(formatCentsSigned(12_000)).toBe("+$120.00");
    expect(formatCentsSigned(-4_364)).toBe("-$43.64");
    expect(formatCentsSigned(1)).toBe("+$0.01");
    expect(formatCentsSigned(-1)).toBe("-$0.01");
  });

  // a "+" on zero renders as a gain that is not a gain at ~39 flow displays
  test("formatCentsSigned leaves zero unsigned", () => {
    expect(formatCentsSigned(0)).toBe("$0.00");
    expect(formatCentsSigned(-0)).toBe("$0.00");
  });
});
