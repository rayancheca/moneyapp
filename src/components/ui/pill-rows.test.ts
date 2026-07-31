import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE PILL-ROW GATE — the horizontal-overflow bug that `*:min-w-0` does NOT
 * cover, gated in the same cheap source-level way (see
 * src/app/investments/page.test.ts for why a source gate rather than a rendered
 * one: jsdom has no layout engine).
 *
 * A grid track's automatic minimum is its min-content width, and `*:min-w-0`
 * answers that. A NON-WRAPPING FLEX ROW is a different failure with the same
 * symptom: its min-content width is the SUM of its children, not the widest of
 * them, so the row can never be narrower than every pill laid end to end. These
 * two rows are ordinary blocks in the page flow with no scroller of their own,
 * so when they cannot fit they push the DOCUMENT sideways instead of clipping.
 *
 * Measured on the running app, before `flex-wrap`:
 *   · `/`         44px of sideways scroll at 440, 164px at 320 — 0 and 100 with
 *                 the single newest pill hidden. The dashboard's chart
 *                 dimension had just gone from six options to seven, and the
 *                 seventh is what crossed the line. The row had been one option
 *                 away from this since the sixth was added.
 *   · `/spending` 14px at 320, from five granularity pills whose min-content is
 *                 318px against 288px of page.
 * After: 0 at every width on both routes except a pre-existing 11px at 320 that
 * belongs to the hero figure, not to a pill row.
 *
 * The point of gating it is that this is a LATENT bug that only appears when
 * someone appends an option — the change that trips it looks nothing like a
 * layout change, so the person making it has no reason to re-measure. Wrapping
 * makes the row's minimum the widest single pill, which is bounded by one
 * label, so appending an option costs a second line and never a scrollbar.
 */

const ROWS: readonly { file: string; what: string; anchor: string }[] = [
  {
    file: "src/components/ui/ViewSwitcher.tsx",
    what: "the switchable-view segmented control (every surface's view pills)",
    anchor: "rounded-full border border-line bg-surface-leaf p-1",
  },
  {
    file: "src/components/spending/PeriodSelector.tsx",
    what: "the period-granularity nav on /spending",
    anchor: 'aria-label="Period granularity"',
  },
  {
    // Added after this row shipped 48px over the 320 floor on `/?chart=sankey`.
    // The detector below already MATCHED this file and already returned
    // `flex-wrap === false` — the file simply was not in this array, so it was
    // never opened. Two of three pill rows were fixed and the third, on the one
    // view that hand-rolls its own, was not. If you add a fourth pill row
    // anywhere, it belongs here the same day.
    file: "src/components/dashboard/DashboardChartSection.tsx",
    what: "the Sankey's own range pills on the dashboard (`/?chart=sankey`)",
    anchor: 'aria-label="Flow range"',
  },
];

describe("pill rows wrap instead of pushing the page sideways", () => {
  for (const row of ROWS) {
    describe(row.what, () => {
      const source = fs.readFileSync(path.join(process.cwd(), row.file), "utf8");

      test("the row this gate is about still exists", () => {
        // guards the guard: if the markup were renamed, the assertion below
        // would pass vacuously against a file that no longer has the row
        expect(source).toContain(row.anchor);
      });

      test("its flex row wraps", () => {
        // the WELL, not the pills inside it: both are `flex … rounded-full`,
        // and what separates them is that the well pads its children (`p-1`)
        // while a pill pads its own text (`px-*`/`py-*`). Matching on the pills
        // too would demand `flex-wrap` on single-line labels, which is noise.
        const flexRows = [...source.matchAll(/className=[{]?[`"]([^`"]*\bflex\b[^`"]*)[`"]/g)]
          .map((m) => m[1] ?? "")
          .filter((cls) => {
            const tokens = cls.split(/\s+/);
            return tokens.includes("rounded-full") && tokens.includes("gap-1") && tokens.includes("p-1");
          });
        expect(flexRows.length).toBeGreaterThanOrEqual(1);
        for (const cls of flexRows) {
          expect(
            cls.includes("flex-wrap"),
            `a non-wrapping pill row cannot be narrower than the sum of its ` +
              `pills, so adding one more option scrolls the whole page ` +
              `sideways on a phone. Add \`flex-wrap\`:\n  ${cls}`,
          ).toBe(true);
        }
      });
    });
  }
});
