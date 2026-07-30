import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  FLOW_MEASURE_DIMENSION,
  FLOW_SHAPE_DIMENSION,
  FLOW_SURFACE,
  FLOW_VIEW_SPEC,
} from "./transfer-flow-view-spec";
import { LENS_DIMENSION } from "./chart-lens";
import { resolveViewState, specDefaults, viewStateToParams } from "@/lib/view-state";

/**
 * The tower's SOURCE contract, and the /flow surface's WIRING contract.
 *
 * The geometry is proved in `lib/transfer-tower-layout.test.ts`. What is left
 * here is everything that lives in the markup or in the wiring between three
 * files, and cannot be asserted from a pure function in a node test runner
 * (vitest runs `environment: "node"` — there is no jsdom and no renderer).
 *
 * THE REASON THIS FILE EXISTS. `/?chart=terrain` shipped as a 500 and 246
 * Playwright tests passed straight over it, because the option was registered
 * in a view spec — so it rendered a clickable pill and a persistable URL — but
 * nothing ever opened it. A registry that drives UI needs a test that
 * ENUMERATES THE REGISTRY. Adding `shape` to FLOW_VIEW_SPEC reproduces exactly
 * that hazard on /flow, in three separate silent ways:
 *
 *   · the page hardcodes its URL-param map, so a new dimension's `?param=` is
 *     dropped and only a shared link or a hard reload reveals it;
 *   · the panel hardcodes its switchers, so a new dimension renders no control;
 *   · nothing indexes the spec positionally any more — and this file is what
 *     keeps it that way.
 */

const CHARTS = path.join(process.cwd(), "src/components/charts");
const tower = fs.readFileSync(path.join(CHARTS, "TransferTower.tsx"), "utf8");
const panel = fs.readFileSync(path.join(CHARTS, "TransferFlowPanel.tsx"), "utf8");
const page = fs.readFileSync(path.join(process.cwd(), "src/app/flow/page.tsx"), "utf8");

/** Every literal className in a file — `"…"` and `{`…`}` forms. */
function classNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1] ?? "");
  return out;
}

describe("every declared view dimension is actually wired end to end", () => {
  test("the spec declares the three dimensions, with the lens last", () => {
    expect(FLOW_VIEW_SPEC.map((d) => d.key)).toEqual(["measure", "shape", "lens"]);
    expect(FLOW_VIEW_SPEC[FLOW_VIEW_SPEC.length - 1]).toBe(LENS_DIMENSION);
  });

  test("the PAGE reads every dimension's URL param — or a shared link lies", () => {
    // the literal object handed to resolveViewState
    const map = page.match(/resolveViewState\(\s*FLOW_VIEW_SPEC,\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(map).not.toBe("");
    for (const dim of FLOW_VIEW_SPEC) {
      expect(
        new RegExp(`\\b${dim.key}\\s*:`).test(map),
        `/flow's page never reads ?${dim.key}= — the pill will work and a shared ` +
          `link will silently fall back to the persisted value. Add ` +
          `\`${dim.key}: one(raw.${dim.key})\` to the resolveViewState map in src/app/flow/page.tsx.`,
      ).toBe(true);
    }
  });

  test("the PANEL renders a switcher for every dimension — or it is unreachable", () => {
    // Assert the BINDING, not merely the mention. The first version of this read
    // `includes(X) || includes("dimension={LENS_DIMENSION}")` — and the panel
    // always contains that literal, so the right operand was unconditionally
    // true and the whole check was `X || true`. It could never fail.
    const bound = (panel.match(/dimension=\{(\w+)\}/g) ?? []).map((m) =>
      m.replace(/dimension=\{|\}/g, ""),
    );
    // The identifiers are not uniformly named (`FLOW_MEASURE_DIMENSION` is
    // surface-scoped, `LENS_DIMENSION` is shared), so this cannot be derived —
    // it is declared, and the exhaustiveness check below is what forces a new
    // dimension to be added here rather than silently skipped.
    const CONSTANT: Record<string, string> = {
      measure: "FLOW_MEASURE_DIMENSION",
      shape: "FLOW_SHAPE_DIMENSION",
      lens: "LENS_DIMENSION",
    };
    for (const dim of FLOW_VIEW_SPEC) {
      const expected = CONSTANT[dim.key];
      expect(expected, `dimension "${dim.key}" is missing from this test's CONSTANT map`).toBeDefined();
      expect(
        bound,
        `no <ViewSwitcher dimension={${expected}}> in TransferFlowPanel.tsx, so the ` +
          `"${dim.key}" dimension has no control and is reachable only by URL`,
      ).toContain(expected);
    }
    // one <ViewSwitcher> per dimension, no more and no fewer
    expect(panel.match(/<ViewSwitcher/g) ?? []).toHaveLength(FLOW_VIEW_SPEC.length);
    expect(bound).toHaveLength(FLOW_VIEW_SPEC.length);
  });

  test("no file indexes the spec POSITIONALLY — that bug pins the surface to one value", () => {
    // `FLOW_VIEW_SPEC[0]` silently repoints the moment a dimension is inserted,
    // and the symptom is a switcher that does nothing, with no error anywhere.
    for (const [name, src] of [
      ["TransferFlowPanel.tsx", panel],
      ["flow/page.tsx", page],
    ] as const) {
      expect(/FLOW_VIEW_SPEC\s*\[\s*\d+\s*\]/.test(src), `${name} indexes FLOW_VIEW_SPEC by index`).toBe(false);
    }
    expect(panel).toContain("FLOW_MEASURE_DIMENSION.key");
    expect(panel).toContain("FLOW_SHAPE_DIMENSION.key");
  });

  test("every option of every dimension resolves to itself from the URL", () => {
    for (const dim of FLOW_VIEW_SPEC) {
      for (const option of dim.options) {
        const state = resolveViewState(FLOW_VIEW_SPEC, { [dim.key]: option }, undefined);
        expect(state[dim.key]).toBe(option);
      }
    }
  });

  test("the default view produces a clean URL, and every non-default is shareable", () => {
    expect(viewStateToParams(FLOW_VIEW_SPEC, specDefaults(FLOW_VIEW_SPEC))).toEqual({});
    expect(
      viewStateToParams(FLOW_VIEW_SPEC, { measure: "net", shape: "tower", lens: "chart" }),
    ).toEqual({ measure: "net", shape: "tower" });
  });

  test("an existing persisted preference from before `shape` existed still resolves", () => {
    // app_settings rows written by the two-dimension version are missing the key
    // entirely; that must be a graceful default, never an error.
    const state = resolveViewState(FLOW_VIEW_SPEC, {}, { measure: "net", lens: "table" });
    expect(state).toEqual({ measure: "net", shape: "spine", lens: "table" });
  });

  test("the surface key is unchanged, so nobody's saved preference is orphaned", () => {
    expect(FLOW_SURFACE).toBe("flow");
  });

  test("spine is the default shape — the tower is opt-in, never forced", () => {
    expect(FLOW_SHAPE_DIMENSION.options[0]).toBe("spine");
    expect(FLOW_MEASURE_DIMENSION.options[0]).toBe("gross");
  });
});

describe("the tower's plate can shrink", () => {
  const isGrid = (cls: string) => cls.split(/\s+/).includes("grid");

  test("there is a grid here to gate", () => {
    // guards the guard: a regex that silently matches nothing proves nothing
    expect(classNames(tower).filter(isGrid).length).toBeGreaterThanOrEqual(1);
  });

  test("every grid zeroes its items' automatic minimum size", () => {
    for (const cls of classNames(tower).filter(isGrid)) {
      expect(
        cls.includes("*:min-w-0"),
        "grid without a shrink guard — add `*:min-w-0`. A grid item's automatic " +
          "minimum is its min-content size, so without it the plate's own width " +
          `floors the track and scrolls the page sideways on a phone:\n  ${cls}`,
      ).toBe(true);
    }
  });

  test("the plate clips its own drawing rather than pushing the card wide", () => {
    expect(classNames(tower).some((c) => c.includes("overflow-hidden"))).toBe(true);
  });
});

describe("the tower is deterministic", () => {
  // The visual baselines and the byte-identity of two renders depend on this.
  for (const forbidden of ["Math.random", "Date.now", "new Date("]) {
    test(`no ${forbidden} anywhere in the render path`, () => {
      expect(tower).not.toContain(forbidden);
    });
  }

  test("the geometry is imported, never recomputed inline", () => {
    expect(tower).toContain("computeTowerLayout");
    expect(tower).toContain("@/lib/transfer-tower-layout");
  });

  test("arcs are painted in the layout's own order, not the array's", () => {
    expect(tower).toContain("layout.order.map");
  });
});

describe("the tower is not the only path to anything it says", () => {
  test("the drawing carries a title and a generated description", () => {
    expect(tower).toContain("aria-labelledby");
    expect(tower).toContain("towerDescription");
  });

  test("there is a rail of real links beside the plate", () => {
    expect(tower).toContain('aria-label="Accounts in this tower"');
    expect(tower).toMatch(/<a\s+href=\{p\.href\}/);
  });

  test("the tooltip is aria-hidden and is not a live region", () => {
    // announcing a new bucket for every arc the cursor crosses is hostile
    expect(tower).toMatch(/aria-hidden="true"\s*\n?\s*className="pointer-events-none absolute/);
    expect(tower).not.toContain("aria-live");
  });

  test("the arcs are pointer-only — a couple of hundred tab stops is a trap", () => {
    expect(tower).not.toContain("tabIndex");
  });
});
