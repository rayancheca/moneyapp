import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DashboardMode } from "@/lib/multi-series";
import { resolveViewState } from "@/lib/view-state";
import { TERRAIN_VIEWPOINTS } from "@/lib/terrain-layout";
import { sideLabel, sideTag } from "./NetWorthTerrain";
import {
  DASHBOARD_SURFACE,
  DASHBOARD_VIEW_SPEC,
  TERRAIN_LENS_DIMENSION,
  TERRAIN_VIEW_DIMENSION,
  dashboardChartView,
  dashboardSeriesMode,
} from "@/components/dashboard/dashboard-view-spec";

/**
 * The terrain's SOURCE contract. The geometry is proved in
 * `lib/terrain-layout.test.ts` (including against the real net-worth service);
 * what is left here is everything that lives in the markup and cannot be
 * asserted from a pure function in a node test runner:
 *
 *   · the shrink gate — the same failure CategoryMassif.test.ts was written
 *     for, one component over. The stage carries a literal `width={720}` <svg>
 *     until the ResizeObserver has measured, and a grid item's automatic
 *     minimum is its min-content size, so a grid without `*:min-w-0` floors its
 *     track at 720px and scrolls the DASHBOARD sideways on his phone.
 *   · the figure states its own encodings, in the drawing and in words;
 *   · the escape hatches exist (a rail of exact figures, a Table lens);
 *   · determinism, which the Playwright visual baselines depend on;
 *   · and the view wiring: `terrain` is APPENDED to the dashboard spec and
 *     draws from the per-account series, so no spec option can reach the
 *     series builder as an unhandled string.
 */

const DIR = path.join(process.cwd(), "src/components/charts");
const source = fs.readFileSync(path.join(DIR, "NetWorthTerrain.tsx"), "utf8");
const geometry = fs.readFileSync(path.join(process.cwd(), "src/lib/terrain-layout.ts"), "utf8");

/** Every literal className in the file — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

describe("the terrain's tracks can shrink", () => {
  test("there is a grid here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(source).filter(isGrid).length).toBeGreaterThanOrEqual(1);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(source).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        "grid without a shrink guard — add `*:min-w-0`. Without it the stage's " +
          "720px <svg> sets the track width and the dashboard scrolls sideways " +
          `on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the plate-and-rail composition above lg survived the guard", () => {
    const stage = classNames(source).find((c) => c.includes("lg:grid-cols-[minmax(0,1fr)_20rem]"));
    expect(stage).toBeDefined();
    expect(stage).toContain("*:min-w-0");
  });

  test("the stage clips its own drawing rather than pushing the page wide", () => {
    expect(classNames(source).some((c) => c.includes("overflow-hidden"))).toBe(true);
  });
});

describe("the figure states what it is drawing", () => {
  test("it is ONE described figure, not a hundred unlabelled polygons", () => {
    expect(source).toContain('role="img"');
    expect(source).toContain("aria-label={terrainDescription(");
  });

  test("the description names every encoding and points at the exact numbers", () => {
    expect(source).toContain("Height above the zero plane is the account's balance");
    expect(source).toContain("depth separates the accounts");
    expect(source).toContain("extrudes below the plane");
    expect(source).toContain("Exact figures for every account are in the list beside the chart");
  });

  test("the key strip prints the same four channels beside the plate", () => {
    for (const key of ["Height", "Depth", "Below rule", "Colour", "Hatched"]) {
      expect(source, `the caption strip must name ${key}`).toContain(`>${key}</b>`);
    }
  });

  test("the broken debt scale is never printed without its factor", () => {
    expect(source).toContain("scale broken ×");
    expect(geometry).toContain("debtMultiple");
  });
});

describe("the honesty a chart of real money owes", () => {
  test("an unverified span is drawn broken — hatched fill, dashed crest", () => {
    expect(source).toContain("segment.verified ? ribbon.color : `url(#${hatchId})`");
    expect(source).toContain('strokeDasharray: "3 3"');
  });

  test("the figure says how it reconciles with the net-worth chart above it", () => {
    expect(source).toContain("reconcileTerrain");
    expect(source).toContain("reconciliationNote");
    expect(source).toContain("read the ledger");
  });

  test("today's figures come from the layout, never re-derived in the markup", () => {
    // every money figure the component prints is a field the pure layer
    // computed from the same points the drawing uses
    expect(source).toContain("layout.totalLatestCents");
    expect(source).toContain("layout.assetsLatestCents");
    expect(source).toContain("layout.owedLatestCents");
    expect(source).not.toMatch(/reduce\(\s*\(/);
  });
});

describe("the escape hatches", () => {
  test("a rail of exact figures sits beside the plate, and links each account", () => {
    expect(source).toContain("function TerrainRail");
    expect(source).toContain("<Link");
    expect(source).toContain("/accounts/${encodeURIComponent(r.id)}");
  });

  test("a Table lens prints the whole span as rows", () => {
    expect(source).toContain("function TerrainTable");
    expect(source).toContain("<DataTable");
    expect(source).toContain('ariaLabel="Terrain lens"');
  });

  test("four named viewpoints, no free tumble", () => {
    // the options live with the SURFACE now — one declaration, resolved by the
    // RSC and rendered by the pills, so they cannot drift apart
    expect(TERRAIN_VIEW_DIMENSION.options).toEqual(["quarter", "front", "side", "plan"]);
    expect(geometry).toContain("TERRAIN_VIEWPOINTS");
  });

  /*
   * ⚠️ `options[0]` IS the default. The old switcher listed "front" first while
   * `useState` opened on "quarter" — reading the spec straight off that order
   * would have silently changed the terrain's default camera.
   */
  test("the camera the terrain opens on is the one it always opened on", () => {
    expect(TERRAIN_VIEW_DIMENSION.options[0]).toBe("quarter");
    expect(TERRAIN_LENS_DIMENSION.options[0]).toBe("relief");
  });

  test("every declared viewpoint is a camera the geometry actually has", () => {
    for (const option of TERRAIN_VIEW_DIMENSION.options) {
      expect(Object.keys(TERRAIN_VIEWPOINTS)).toContain(option);
    }
  });
});

describe("determinism and motion", () => {
  test("neither the drawing nor its geometry reaches for a clock or a die", () => {
    for (const [name, src] of [
      ["NetWorthTerrain.tsx", source],
      ["terrain-layout.ts", geometry],
    ] as const) {
      expect(src, `${name} must not use Math.random`).not.toContain("Math.random");
      expect(src, `${name} must not construct a Date`).not.toMatch(/new Date\(/);
    }
  });

  test("reduced motion is respected, and motion stays on the compositor", () => {
    expect(source).toContain("usePrefersReducedMotion");
    expect(source).toContain("reducedMotion ? \"\" :");
    // opacity only — never a layout-bound property
    expect(source).toContain("transition-opacity duration-(--duration-fast) ease-(--ease-ink)");
  });
});

describe("the letterpress tokens are actually consumed", () => {
  test("the sheet, the ink, the marginalia and the press depth all land here", () => {
    for (const token of [
      "var(--surface-leaf)",
      "var(--ink-display)",
      "var(--annotation)",
      "var(--emboss-hi)",
    ]) {
      expect(source, `${token} has no consumer in the terrain`).toContain(token);
    }
    for (const utility of ["shadow-press-2", "text-ink-display", "bg-surface-leaf", "text-annotation"]) {
      expect(source, `${utility} has no consumer in the terrain`).toContain(utility);
    }
  });
});

// ── The view wiring ──────────────────────────────────────────────────

describe("the dashboard hero's view dimension", () => {
  const options = DASHBOARD_VIEW_SPEC[0]!.options;

  test("every view is APPENDED — the ones that existed before still exist, in order", () => {
    /*
     * The guard doing its job: adding `bridge` turned this red, which is exactly
     * what it is for. A view is only ever added to the END, because the option
     * order is what the ViewSwitcher renders and what `/?chart=` addresses, and
     * because two dashboard specs derive their whole test list from this array.
     */
    expect(options).toEqual([
      "combined",
      "assets",
      "liabilities",
      "split",
      "accounts",
      "sankey",
      "terrain",
      "bridge",
    ]);
    // the default is untouched: a reader who never picks a view still gets the
    // net-worth line the dashboard has always opened on
    expect(options[0]).toBe("combined");
  });

  test("it is URL-addressable and persisted, like every other view", () => {
    expect(resolveViewState(DASHBOARD_VIEW_SPEC, { chart: "terrain" }, undefined)).toMatchObject({
      chart: "terrain",
    });
    expect(resolveViewState(DASHBOARD_VIEW_SPEC, {}, { chart: "terrain" })).toMatchObject({
      chart: "terrain",
    });
    expect(DASHBOARD_SURFACE).toBe("dashboard");
    expect(dashboardChartView({ chart: "terrain" })).toBe("terrain");
    expect(dashboardChartView({})).toBe("combined");
  });

  /*
   * 🔴 THE PROMISE THAT WAS BROKEN. `ViewDimension.key` is documented as "the
   * URL param key AND the app_settings key", and both of the terrain's
   * dimensions declared one while holding their value in `useState`:
   * `/?chart=terrain&terrainLens=table` opened on the relief, measured
   * 2026-09-02, and the camera was lost on reload. They are real now.
   */
  test("the terrain's lens and camera are addressable and persisted too", () => {
    expect(
      resolveViewState(DASHBOARD_VIEW_SPEC, { chart: "terrain", terrainLens: "table" }, undefined),
    ).toMatchObject({ chart: "terrain", terrainLens: "table" });
    expect(
      resolveViewState(DASHBOARD_VIEW_SPEC, {}, { terrainView: "plan" }),
    ).toMatchObject({ terrainView: "plan" });
    // the URL still beats the remembered preference, the rule the whole model rests on
    expect(
      resolveViewState(DASHBOARD_VIEW_SPEC, { terrainView: "side" }, { terrainView: "plan" }),
    ).toMatchObject({ terrainView: "side" });
    // and a typo falls back rather than reaching the camera table
    expect(
      resolveViewState(DASHBOARD_VIEW_SPEC, { terrainView: "orbit" }, undefined),
    ).toMatchObject({ terrainView: "quarter" });
  });

  /* ⛔ Three components declared `viewpoint`. Any two dimensions sharing a key
     on ONE surface would be two switchers writing one param. */
  test("no two dimensions on this surface share a key", () => {
    const keys = DASHBOARD_VIEW_SPEC.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("terrain draws from the SAME per-account series as the accounts view", () => {
    expect(dashboardSeriesMode("terrain")).toBe("accounts");
    expect(dashboardSeriesMode("accounts")).toBe("accounts");
  });

  test("NO spec option can reach the series builder as an unhandled string", () => {
    // the landmine this function exists to defuse: `dashboardChartData` switches
    // exhaustively on DashboardMode and returns undefined for anything else, so
    // an unmapped option would 500 the dashboard — and, because the view is
    // PERSISTED, would keep 500ing it on every later visit.
    const modes: DashboardMode[] = ["combined", "assets", "liabilities", "split", "accounts"];
    for (const option of options) {
      const mode = dashboardSeriesMode(option);
      expect(mode === null || modes.includes(mode), `unmapped hero view "${option}"`).toBe(true);
    }
    // the two views that build no series at all
    expect(dashboardSeriesMode("combined")).toBeNull();
    expect(dashboardSeriesMode("sankey")).toBeNull();
    expect(dashboardSeriesMode(undefined)).toBeNull();
    expect(dashboardSeriesMode("nonsense")).toBeNull();
  });
});

/**
 * 🔴 The rail printed a bare "owed" over a POSITIVE figure while the Table lens
 * sixty lines below it, over the same rows, printed "Owed · in credit".
 * Measured 2026-09-10: `Chase Sapphire` reads "owed +$82.72 since Feb 2025".
 */
describe("which side of the rule a row sits on", () => {
  test("an asset is held, and the rail tags it with nothing", () => {
    expect(sideLabel({ isLiability: false, lastCents: 300_760 })).toBe("Held");
    expect(sideTag({ isLiability: false, lastCents: 300_760 })).toBe("");
  });

  test("a card carrying a balance is owed", () => {
    expect(sideLabel({ isLiability: true, lastCents: -36_799 })).toBe("Owed");
    expect(sideTag({ isLiability: true, lastCents: -36_799 })).toBe("owed");
  });

  test("a card IN CREDIT is still owed-side, and says which", () => {
    expect(sideLabel({ isLiability: true, lastCents: 8_272 })).toBe("Owed · in credit");
    expect(sideTag({ isLiability: true, lastCents: 8_272 })).toBe("owed · in credit");
  });

  test("a card at exactly zero is not in credit", () => {
    expect(sideLabel({ isLiability: true, lastCents: 0 })).toBe("Owed");
  });

  test("the rail's tag is the table's label, never a second rule", () => {
    for (const r of [
      { isLiability: true, lastCents: 8_272 },
      { isLiability: true, lastCents: -1 },
      { isLiability: true, lastCents: 0 },
      { isLiability: false, lastCents: 5 },
    ]) {
      expect(sideTag(r)).toBe(r.isLiability ? sideLabel(r).toLowerCase() : "");
    }
  });
});
