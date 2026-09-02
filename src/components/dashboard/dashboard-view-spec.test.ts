import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveViewState, specDefaults, viewStateToParams } from "@/lib/view-state";
import {
  BRIDGE_LENS_DIMENSION,
  DASHBOARD_CHART_DIMENSION,
  DASHBOARD_VIEW_SPEC,
  DECISIONS_VIEW_SPEC,
  SANKEY_LENS_DIMENSION,
  TERRAIN_LENS_DIMENSION,
  TERRAIN_VIEW_DIMENSION,
} from "./dashboard-view-spec";

/**
 * THE DASHBOARD SURFACE'S WIRING CONTRACT — the guard that would have caught
 * all six at once.
 *
 * `ViewDimension.key` is documented in `lib/view-state.ts` as "the URL param key
 * AND the app_settings key for this dimension". Six switchers declared one and
 * kept neither half: the terrain's lens and camera, the money-flow diagram's
 * flow/table lens, the net-worth bridge's chart/table lens, and — on other
 * surfaces — the massif's and the tower's cameras. `/?chart=terrain&terrainLens=table`
 * opened on the relief, measured 2026-09-02, and every choice was lost on reload.
 *
 * `TransferTower.test.ts` has held /flow to exactly this contract since the day
 * `/?chart=terrain` shipped as a 500 that 246 Playwright tests walked past. This
 * is the same contract for the dashboard, and it is written the same way: it
 * ENUMERATES THE REGISTRY rather than listing what someone remembered.
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const page = read("src/app/page.tsx");
/** every file that renders a switcher for a dimension of THIS surface */
const MARKUP_FILES = [
  "src/components/dashboard/DashboardChartSection.tsx",
  "src/components/charts/NetWorthTerrain.tsx",
  "src/components/charts/SankeyChart.tsx",
  "src/components/charts/NetWorthBridge.tsx",
] as const;
const markup = MARKUP_FILES.map(read).join("\n");

/** the constant each dimension's switcher must be BOUND to, by key */
const BOUND_TO: Record<string, string> = {
  chart: "DASHBOARD_CHART_DIMENSION",
  terrainLens: "TERRAIN_LENS_DIMENSION",
  terrainView: "TERRAIN_VIEW_DIMENSION",
  sankeyLens: "SANKEY_LENS_DIMENSION",
  bridgeLens: "BRIDGE_LENS_DIMENSION",
};

describe("every declared dashboard dimension is wired end to end", () => {
  test("the spec declares five dimensions, and no two share a key", () => {
    const keys = DASHBOARD_VIEW_SPEC.map((d) => d.key);
    expect(keys).toEqual(["chart", "terrainLens", "terrainView", "sankeyLens", "bridgeLens"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /*
   * ⛔ THE COLLISION THIS NAMING EXISTS TO PREVENT. Three components declared a
   * dimension called `viewpoint` and a fourth called its lens `bridge` — which
   * is already a VALUE of `chart`. A key must be unique across every surface
   * that could ever share a URL, so they are checked together.
   */
  test("no dimension is named after a hero VIEW", () => {
    /*
     * The precise rule, and it is narrower than "no key equals any value" —
     * `bridgeLens` legitimately offers a "chart" option, scoped to its own
     * param. What bites is a KEY named after one of `chart`'s values: `sankey`
     * and `bridge` were both, so `?chart=sankey&sankey=table` used one word
     * twice for two things. Values of `chart` are the words that name views on
     * this surface, and a param must not borrow one.
     */
    const views = new Set(DASHBOARD_CHART_DIMENSION.options);
    for (const dim of DASHBOARD_VIEW_SPEC) {
      if (dim === DASHBOARD_CHART_DIMENSION) continue;
      expect(
        views.has(dim.key),
        `"${dim.key}" is both a param name and a hero view — add a suffix, as terrainLens does`,
      ).toBe(false);
    }
  });

  test("the PAGE reads every dimension's URL param — or a shared link lies", () => {
    const map = page.match(/resolveViewState\(\s*DASHBOARD_VIEW_SPEC,\s*\{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
    expect(map).not.toBe("");
    for (const dim of DASHBOARD_VIEW_SPEC) {
      expect(
        new RegExp(`\\b${dim.key}\\s*:`).test(map),
        `the dashboard never reads ?${dim.key}= — the pill will work (setView persists, ` +
          `then navigates, and the persisted value wins) and only a shared link or a hard ` +
          `reload reveals that the param was ignored. Add \`${dim.key}: firstParam(raw.${dim.key}) ?? undefined\` ` +
          `to the resolveViewState map in src/app/page.tsx.`,
      ).toBe(true);
    }
  });

  test("SOME file renders a switcher bound to every dimension — or it is unreachable", () => {
    const bound = (markup.match(/dimension=\{(\w+)\}/g) ?? []).map((m) =>
      m.replace(/dimension=\{|\}/g, ""),
    );
    for (const dim of DASHBOARD_VIEW_SPEC) {
      const expected = BOUND_TO[dim.key];
      expect(expected, `dimension "${dim.key}" is missing from this test's BOUND_TO map`).toBeDefined();
      expect(
        bound,
        `no <ViewSwitcher dimension={${expected}}> in any of ${MARKUP_FILES.join(", ")}, so the ` +
          `"${dim.key}" dimension has no control and is reachable only by URL`,
      ).toContain(expected!);
    }
  });

  /*
   * ⛔ A switcher that holds its own value is the defect, not the control. Both
   * of these files rendered one over a `useState` while their dimension
   * declared a URL key — so the pill worked, the link did not, and a reload
   * forgot. A `useState` narrowing a lens is how that comes back.
   */
  test("no dashboard chart holds a view dimension in local state", () => {
    for (const rel of MARKUP_FILES) {
      const src = read(rel);
      for (const forbidden of [
        /useState<"relief" \| "table">/,
        /useState<"flow" \| "table">/,
        /useState<"chart" \| "table">/,
        /useState<TerrainViewpoint>/,
      ]) {
        expect(forbidden.test(src), `${rel} holds a view dimension in useState`).toBe(false);
      }
    }
  });

  test("every option of every dimension resolves to itself from the URL", () => {
    for (const dim of DASHBOARD_VIEW_SPEC) {
      for (const option of dim.options) {
        expect(resolveViewState(DASHBOARD_VIEW_SPEC, { [dim.key]: option }, undefined)[dim.key]).toBe(option);
      }
    }
  });

  test("the URL beats the remembered preference, for every dimension", () => {
    for (const dim of DASHBOARD_VIEW_SPEC) {
      const [first, second] = dim.options;
      expect(
        resolveViewState(DASHBOARD_VIEW_SPEC, { [dim.key]: second! }, { [dim.key]: first! })[dim.key],
      ).toBe(second);
    }
  });

  test("the default view produces a clean URL, and every non-default is shareable", () => {
    expect(viewStateToParams(DASHBOARD_VIEW_SPEC, specDefaults(DASHBOARD_VIEW_SPEC))).toEqual({});
    expect(
      viewStateToParams(DASHBOARD_VIEW_SPEC, {
        chart: "terrain",
        terrainLens: "table",
        terrainView: "plan",
        sankeyLens: "flow",
        bridgeLens: "chart",
      }),
    ).toEqual({ chart: "terrain", terrainLens: "table", terrainView: "plan" });
  });

  /*
   * ⚠️ `options[0]` IS the default. Every one of these had a `useState` initial
   * value, and reading the spec off the old switcher ORDER instead would have
   * silently changed what the dashboard draws on a cold load — the terrain
   * listed "front" first and opened on "quarter".
   */
  test("each dimension opens on what it always opened on", () => {
    expect(DASHBOARD_CHART_DIMENSION.options[0]).toBe("combined");
    expect(TERRAIN_LENS_DIMENSION.options[0]).toBe("relief");
    expect(TERRAIN_VIEW_DIMENSION.options[0]).toBe("quarter");
    expect(SANKEY_LENS_DIMENSION.options[0]).toBe("flow");
    expect(BRIDGE_LENS_DIMENSION.options[0]).toBe("chart");
  });

  /* A preference written before any of these existed is missing their keys
     entirely; that must be a graceful default, never an error. */
  test("a preference from before these dimensions existed still resolves", () => {
    expect(resolveViewState(DASHBOARD_VIEW_SPEC, {}, { chart: "terrain" })).toEqual({
      chart: "terrain",
      terrainLens: "relief",
      terrainView: "quarter",
      sankeyLens: "flow",
      bridgeLens: "chart",
    });
  });

  /* The cards' lens shares the surface KEY but is its own spec, and
     `saveViewPreferenceAction` merges per surface — so the two must not collide
     either. */
  test("the decisions spec shares no key with the chart spec", () => {
    const chartKeys = new Set(DASHBOARD_VIEW_SPEC.map((d) => d.key));
    for (const dim of DECISIONS_VIEW_SPEC) expect(chartKeys.has(dim.key)).toBe(false);
  });
});
