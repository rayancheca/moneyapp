import { describe, expect, test } from "vitest";
import { assertPrintableName, isPrintableName, UNPRINTABLE_NAME_CHARS } from "./printable-name";

describe("isPrintableName", () => {
  test("an ordinary merchant name is printable", () => {
    expect(isPrintableName("Whole Foods Market")).toBe(true);
  });

  test("names with punctuation, digits and ampersands stay printable", () => {
    for (const name of ["Ben & Jerry's", "7-Eleven", "SoFi 9067", "Trader Joe's #452", "Café Bustelo"]) {
      expect(isPrintableName(name)).toBe(true);
    }
  });

  test.each(["<UNKNOWN>", "a<b", "a>b", "a{b", "a}b", "a\\b"])("%s is not printable", (name) => {
    expect(isPrintableName(name)).toBe(false);
  });

  test("a name that could be re-read as a slot is refused", () => {
    expect(isPrintableName("{{a.value}}")).toBe(false);
  });

  test("empty and whitespace-only are not printable", () => {
    expect(isPrintableName("")).toBe(false);
    expect(isPrintableName("   ")).toBe(false);
  });

  /*
   * The regex is shared and module-level, so a `/g` flag would make `test()`
   * alternate between true and false for one input. This asserts the property
   * rather than the flag: the same call twice must agree.
   */
  test("the predicate is stateless across repeated calls", () => {
    expect(UNPRINTABLE_NAME_CHARS.global).toBe(false);
    expect(isPrintableName("<UNKNOWN>")).toBe(false);
    expect(isPrintableName("<UNKNOWN>")).toBe(false);
    expect(isPrintableName("Whole Foods")).toBe(true);
    expect(isPrintableName("Whole Foods")).toBe(true);
  });
});

describe("assertPrintableName", () => {
  test("says nothing about a name it accepts", () => {
    expect(() => assertPrintableName("Merchant name", "Whole Foods")).not.toThrow();
  });

  test("names the field and quotes the value it refuses", () => {
    expect(() => assertPrintableName("Merchant name", "<UNKNOWN>")).toThrow(
      /Merchant name cannot contain < > \{ \} or a backslash: "<UNKNOWN>"/,
    );
  });

  test("an empty name gets its own reason rather than the character one", () => {
    expect(() => assertPrintableName("Account name", "  ")).toThrow("Account name cannot be empty");
  });
});
