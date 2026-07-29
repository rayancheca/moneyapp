import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * THE SHEET-PARITY GATE.
 *
 * The approved design (Direction A+) fixes how wide the app is allowed to be at
 * every viewport, and it does so in ONE place: the `.page` rule and its five
 * `@media` steps in the mockup. The shell restates that ladder in Tailwind
 * classes, minus the 13.5rem nav rail, because here the rail is part of the
 * sheet.
 *
 * Two restatements of one law drift. So this reads BOTH files and re-derives
 * the ladder from each: the mockup's CSS, and the literal class string that
 * actually ships to the browser (not a TS constant that agrees with the design
 * while the markup quietly disagrees with both). If someone widens the rail,
 * retunes a step, or lets a "DRY" refactor turn the classes into a template
 * literal Tailwind cannot see, the arithmetic stops adding up here rather than
 * on the owner's monitor.
 */

const root = process.cwd();
const shell = fs.readFileSync(path.join(root, "src/components/shell/AppShell.tsx"), "utf8");
const mockup = fs.readFileSync(
  path.join(root, "docs/design-directions/direction-A-plus.html"),
  "utf8",
);

const PX_PER_REM = 16;

interface Step {
  /** viewport px at which this rung takes over (0 = the base rule) */
  from: number;
  /** the width that rung sets, in px */
  width: number;
}

/** The approved ladder read out of the mockup's own `.page` rules. */
function approvedLadder(): Step[] {
  const base = /\.page\s*\{[^}]*?max-width:\s*(\d+)px/.exec(mockup);
  if (!base?.[1]) throw new Error("direction-A-plus.html: no base `.page` max-width");
  const steps: Step[] = [{ from: 0, width: Number(base[1]) }];
  const rung = /@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.page\s*\{[^}]*?max-width:\s*(\d+)px/g;
  for (const m of mockup.matchAll(rung)) {
    steps.push({ from: Number(m[1]), width: Number(m[2]) });
  }
  return steps;
}

/** The shipped ladder read out of the class string the browser actually gets. */
function shippedLadder(): Step[] {
  const base = /(?<![:\]])\bmax-w-\[([\d.]+)rem\]/.exec(shell);
  if (!base?.[1]) throw new Error("AppShell.tsx: no unprefixed max-w-[…rem] on the sheet");
  const steps: Step[] = [{ from: 0, width: Number(base[1]) * PX_PER_REM }];
  const rung = /min-\[(\d+)px\]:max-w-\[([\d.]+)rem\]/g;
  for (const m of shell.matchAll(rung)) {
    steps.push({ from: Number(m[1]), width: Number(m[2]) * PX_PER_REM });
  }
  return steps;
}

/** The nav column of `md:grid-cols-[13.5rem_1fr]`, in px. */
function railPx(): number {
  const m = /md:grid-cols-\[([\d.]+)rem_1fr\]/.exec(shell);
  if (!m?.[1]) throw new Error("AppShell.tsx: shell grid is no longer `[<rem>_1fr]`");
  return Number(m[1]) * PX_PER_REM;
}

describe("the sheet reconciles to Direction A+", () => {
  test("the mockup and the shell declare the same steps", () => {
    // rail + main must equal the approved page width, rung for rung
    const rail = railPx();
    const totals = shippedLadder().map((s) => ({ from: s.from, width: rail + s.width }));
    expect(totals).toEqual(approvedLadder());
  });

  test("the ladder only ever widens, and tops out at A+'s 2280px sheet", () => {
    const shipped = shippedLadder();
    expect(shipped.length).toBeGreaterThan(1);
    shipped.reduce((prev, next) => {
      expect(next.from).toBeGreaterThan(prev.from);
      expect(next.width).toBeGreaterThan(prev.width);
      return next;
    });
    const widest = shipped[shipped.length - 1];
    expect(railPx() + (widest?.width ?? 0)).toBe(2280);
  });

  test("a step never outgrows the viewport that turns it on", () => {
    // A cap wider than its own breakpoint would be inert — the column would
    // simply run to the window edge and the "step" would be a lie.
    const rail = railPx();
    for (const step of shippedLadder()) {
      if (step.from === 0) continue;
      expect(rail + step.width).toBeLessThanOrEqual(step.from);
    }
  });
});

describe("the sheet is applied, not merely declared", () => {
  test("`main` and the masthead row ride the same sheet", () => {
    // Both interpolate the shared SHEET/GUTTER constants; a hand-written width
    // on either one is how the header stops aligning with the content.
    expect(shell.match(/\$\{SHEET\}\s+\$\{GUTTER\}/g)).toHaveLength(2);
  });

  test("the old fixed 1024px cap is gone", () => {
    // comments stripped — the ladder's own docs name `max-w-5xl` as the defect
    expect(shell.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\bmax-w-5xl\b/);
  });

  test("the sheet still centres itself and fills narrow columns", () => {
    expect(shell).toMatch(/"mx-auto w-full"/);
  });

  test("the width and gutter ladders never mix variant families", () => {
    // Measured trap: Tailwind v4 emits arbitrary `min-[…px]` rules BEFORE the
    // named breakpoints, so a later `md:px-8` beat `min-[1800px]:px-12` at
    // equal specificity and the wide gutter silently never applied. A ladder
    // only orders correctly inside ONE family, so no rung may use `sm:`/`md:`/
    // `lg:`/`xl:`/`2xl:`.
    for (const re of [/const SHEET = \[([\s\S]*?)\]\.join/, /const GUTTER = "([^"]*)";/]) {
      const body = re.exec(shell);
      expect(body?.[1], `ladder not found: ${re}`).toBeTruthy();
      const rungs = (body?.[1] ?? "").replace(/\/\/[^\n]*/g, "");
      expect(rungs).not.toMatch(/\b(?:sm|md|lg|xl|2xl):/);
    }
  });
});
