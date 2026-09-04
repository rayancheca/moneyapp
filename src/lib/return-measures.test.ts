import { describe, expect, test } from "vitest";
import { RETURN_MEASURE } from "./return-measures";

describe("the return vocabulary", () => {
  /*
   * ⛔ "Total return" names a figure measured against TIME. The against-cost
   * figure is not one, and a holding page that called it that sat four lines
   * under its own -29.72% time-weighted return.
   */
  test("the against-cost measure is never called a total return", () => {
    expect(RETURN_MEASURE.unrealized.label.toLowerCase()).not.toContain("total return");
    expect(RETURN_MEASURE.unrealized.meaning).toContain("against price, not against time");
  });

  test("every measure says which question it answers", () => {
    for (const words of Object.values(RETURN_MEASURE)) {
      expect(words.label.length).toBeGreaterThan(0);
      expect(words.meaning.length).toBeGreaterThan(0);
    }
  });

  test("no two measures share a label", () => {
    const labels = Object.values(RETURN_MEASURE).map((w) => w.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
