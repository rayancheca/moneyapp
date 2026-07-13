import { describe, expect, test } from "vitest";
import { coverageLabel, formatNameList } from "./coverage-label";

describe("formatNameList", () => {
  test("joins when within the cap", () => {
    expect(formatNameList(["A", "B"])).toBe("A, B");
  });

  test("caps with a +N more suffix", () => {
    expect(formatNameList(["A", "B", "C", "D"])).toBe("A, B +2 more");
  });

  test("respects a custom max (untruncated for aria)", () => {
    expect(formatNameList(["A", "B", "C"], Number.MAX_SAFE_INTEGER)).toBe("A, B, C");
  });

  test("empty list is an empty string", () => {
    expect(formatNameList([])).toBe("");
  });
});

describe("coverageLabel", () => {
  test("complete day (no missing) → null", () => {
    expect(coverageLabel(["A", "B"], [])).toBeNull();
  });

  test("far fewer covered than missing → name the covered ('only')", () => {
    // 2022: only Chase existed → 'only Chase ····3522' beats listing 7 missing
    expect(coverageLabel(["Chase ····3522"], ["Discover", "SoFi", "Venture X"])).toEqual({
      kind: "only",
      text: "Chase ····3522",
    });
  });

  test("few missing → name the missing ('missing')", () => {
    expect(coverageLabel(["A", "B", "C", "D"], ["Robinhood Crypto", "Venture X"])).toEqual({
      kind: "missing",
      text: "Robinhood Crypto, Venture X",
    });
  });

  test("tie (equal covered and missing) → default to naming the missing", () => {
    expect(coverageLabel(["A", "B"], ["C", "D"])).toEqual({ kind: "missing", text: "C, D" });
  });

  test("no covered names at all → name the missing (defensive)", () => {
    expect(coverageLabel([], ["A"])).toEqual({ kind: "missing", text: "A" });
  });

  test("kind is the literal render verb, so surfaces cannot drift", () => {
    // one canonical word per branch — every UI surface renders `{kind} {text}`
    expect(coverageLabel(["A"], ["B", "C"])?.kind).toBe("only");
    expect(coverageLabel(["A", "B"], ["C"])?.kind).toBe("missing");
  });

  test("caps the covered list when many are covered but still fewer than missing", () => {
    expect(coverageLabel(["A", "B", "C"], ["D", "E", "F", "G", "H", "I"], 2)).toEqual({
      kind: "only",
      text: "A, B +1 more",
    });
  });

  test("max is threaded to the chosen list for full aria phrasing", () => {
    expect(coverageLabel(["A"], ["B", "C", "D"], Number.MAX_SAFE_INTEGER)).toEqual({
      kind: "only",
      text: "A",
    });
  });
});
