import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeMassifLayout, MASSIF_VIEWPOINTS } from "@/lib/massif-layout";
import { massifCaptionKey, massifDescription, massifTableCaption, reconciliationNote } from "./CategoryMassif";

/**
 * 🔴 S8/S13/Q8. With no comparable prior window the relief still described every
 * block's height as "the change against" it: `/spending?period=2023&where=table`
 * captioned "2023 against 2022, by category" over a 2022 the ledger holds four
 * months of. ⛔ Not by passing `priorCents = spentCents` — that prints a
 * fabricated "level with".
 */
describe("with no comparable prior window, the relief states no change", () => {
  const layout = computeMassifLayout(
    [
      { id: "food", label: "Food", hue: null, spentCents: 16_072, priorCents: null, txnCount: 25 },
      { id: "housing", label: "Housing", hue: null, spentCents: 726, priorCents: null, txnCount: 1 },
    ],
    { width: 720, height: 320, camera: MASSIF_VIEWPOINTS.quarter },
  );

  test("the description names no prior window and no change", () => {
    const d = massifDescription(layout, "2023", null);
    expect(d).toContain("Where 2023 went");
    expect(d).not.toContain("against");
    expect(d).not.toContain("change");
    expect(d).not.toContain("level with");
    expect(d).not.toContain("null");
  });

  test("every block stands level and carries no delta", () => {
    expect(layout.blocks.map((b) => [b.relief, b.deltaCents, b.deltaPct])).toEqual([
      ["level", null, null],
      ["level", null, null],
    ]);
    expect(layout.totalDeltaCents).toBeNull();
  });

  test("the table's caption names the period alone", () => {
    expect(massifTableCaption("2023", null)).toBe("2023, by category — every figure the relief is cut from.");
    expect(massifTableCaption("2024", "2023")).toBe(
      "2024 against 2023, by category — every figure the relief is cut from.",
    );
  });
});

/**
 * THE SHRINK GATE for the "Where it went" relief.
 *
 * Same failure shape as `src/app/page.test.ts`, one layer down and measured on
 * the running app: a grid item's automatic minimum size is its min-content
 * size, and the relief's stage holds an `<svg width={DEFAULT_WIDTH}>` (720px)
 * until the ResizeObserver has measured. Below `lg` the grid falls back to a
 * single implicit `auto` track, so that 720 — plus the stage's 1px borders —
 * became the track's floor: `/spending?where=relief` scrolled the DOCUMENT
 * sideways by +323px at a 440px window and +227px at 768.
 *
 * `overflow-hidden` on the stage clips the drawing, but it only zeroes the
 * automatic minimum of a FLEX/GRID item — the stage is a block child, so its
 * min-content still propagates. The guard therefore belongs on the track.
 *
 * Above `lg` the explicit `minmax(0,1fr)` already did this, which is exactly
 * why the bug was invisible at every width the visual suite screenshots.
 */

const SOURCE = path.join(process.cwd(), "src/components/charts/CategoryMassif.tsx");
const source = fs.readFileSync(SOURCE, "utf8");

/** Every literal className in the file — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the relief's tracks can shrink", () => {
  test("there is a grid here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(1);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(source).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        "grid without a shrink guard — add `*:min-w-0`. Without it the stage's " +
          "720px <svg> sets the track width and /spending?where=relief scrolls " +
          `sideways on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the two-column composition above lg survived the fix", () => {
    // the cure must not have been "delete the rail beside the plate"
    const stage = classNames(source).find((c) => c.includes("lg:grid-cols-[minmax(0,1fr)_19rem]"));
    expect(stage).toBeDefined();
    expect(stage).toContain("*:min-w-0");
  });

  test("the stage still clips the pre-measurement drawing", () => {
    // min-w-0 lets the TRACK shrink; overflow-hidden is what stops the 720px
    // first-paint svg from painting outside the card. Both are required.
    const stage = classNames(source).find((c) => c.includes("h-[17rem]"));
    expect(stage).toBeDefined();
    expect(stage).toContain("overflow-hidden");
  });
});

describe("the relief's readout counts categories in English", () => {
  /* 🔴 "Aug 2022 · all 1 categories" — the `<desc>` this card also writes
     pluralises "block" from the same count. */
  test("one category is a category", () => {
    expect(massifCaptionKey(null, 1, "Aug 2022")).toBe("Aug 2022 · all 1 category");
  });

  test("more than one is categories", () => {
    expect(massifCaptionKey(null, 12, "Jul 2026")).toBe("Jul 2026 · all 12 categories");
  });

  test("zero is categories too", () => {
    expect(massifCaptionKey(null, 0, "Jul 2026")).toBe("Jul 2026 · all 0 categories");
  });

  test("a hovered block names itself and its share instead", () => {
    expect(massifCaptionKey({ label: "FOOD", share: 0.4237, spentCents: 42_370 }, 12, "Jul 2026")).toBe(
      "FOOD · 42.4% of Jul 2026",
    );
  });

  /**
   * 🔴 A category that netted a REFUND has a zero footprint — correctly, a
   * width is `Math.max(0, spent)` — and the readout beside it turned that
   * width into a measured share. `/spending?period=2024-05` read
   * "Shopping · 0.0% · -$1,605.11".
   */
  test("a block that netted money back took no share, and says so", () => {
    expect(massifCaptionKey({ label: "SHOPPING", share: 0, spentCents: -160_511 }, 12, "May 2024")).toBe(
      "SHOPPING · no share of May 2024 — it netted money back",
    );
  });

  test("a category that really spent nothing still reads 0.0%", () => {
    expect(massifCaptionKey({ label: "HOTELS", share: 0, spentCents: 0 }, 12, "May 2024")).toBe(
      "HOTELS · 0.0% of May 2024",
    );
  });
});

describe("the relief's two denominators, and a window that took money IN", () => {
  const totals = { blocksCents: -190_410, uncategorizedCents: 0, refundsCents: 195_974, grossSpentCents: 5_564 };

  /**
   * 🔴 `/spending?from=2024-05-10&to=2024-05-10&where=relief`, 2026-09-10:
   * T-Mobile −$55.64 and a Best Buy return of +$1,959.74, so $1,904.10 came
   * back — and the card read "the -$1,904.10 of money out this period".
   * Seventeen day windows on this ledger render the same shape.
   */
  test("a net inflow is money that came back, not negative money out", () => {
    const note = reconciliationNote(
      -190_410,
      totals,
      { balanced: true, netOutCents: -190_410, residualCents: 0 },
    );
    expect(note).toContain("$1,904.10 came back this period");
    expect(note).not.toContain("of money out");
    expect(note).not.toContain("-$1,904.10 of");
  });

  test("an ordinary outflow keeps the words it had", () => {
    const note = reconciliationNote(
      67_587,
      { blocksCents: 67_587, uncategorizedCents: 0, refundsCents: 0, grossSpentCents: 67_587 },
      { balanced: true, netOutCents: 67_587, residualCents: 0 },
    );
    expect(note).toContain("the $675.87 of money out this period");
  });

  test("the unbalanced branch follows the same sign rule", () => {
    const note = reconciliationNote(
      -190_410,
      totals,
      { balanced: false, netOutCents: -190_410, residualCents: 1_000 },
    );
    expect(note).toContain("came back in the stat cards above");
    expect(note).not.toContain("of money out in the stat cards");
  });
});
