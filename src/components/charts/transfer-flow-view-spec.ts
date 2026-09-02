import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import { TOWER_VIEWPOINT_ORDER } from "@/lib/transfer-tower-layout";
import { type ViewDimension, type ViewSpec } from "@/lib/view-state";

/**
 * The /flow surface's switchable views.
 *
 * `measure` is a FIRST-CLASS dimension, not a checkbox, because gross and net
 * are two different true answers rather than a display preference. He
 * round-trips money, so gross overstates real movement badly — on the real data
 * $96,482.26 of $330,513.57 came straight back. Making the choice a view means
 * it lives in the URL, is shareable, and persists like every other view.
 *
 * `shape` picks WHICH TRUE PICTURE of the same money you get. The spine answers
 * "where does it settle"; the tower answers "when did it move, and is this
 * route a habit or a one-off". Neither is a mode of the other, and neither is a
 * fallback for the other — so it is a view dimension, not a toggle.
 *
 * ⚠️ EVERY DIMENSION IS REFERENCED BY NAME, never by array index. The panel used
 * to read `FLOW_VIEW_SPEC[0]`, which meant inserting anything ahead of `measure`
 * would silently repoint it and pin the whole surface to "gross" with no error.
 * Exporting the dimensions makes that class of bug unrepresentable — and it is
 * why a third dimension could be INSERTED here rather than appended, keeping
 * `LENS_DIMENSION` last where the rest of the codebase expects it.
 *
 * ⚠️ Adding a dimension here is not enough on its own: `src/app/flow/page.tsx`
 * must also pass its `?param=` through to `resolveViewState`, or the pill will
 * work while a shared link silently falls back to the persisted value.
 */
export const FLOW_SURFACE = "flow";

export const FLOW_MEASURE_DIMENSION: ViewDimension = {
  key: "measure",
  options: ["gross", "net"],
};

export const FLOW_SHAPE_DIMENSION: ViewDimension = {
  key: "shape",
  options: ["spine", "tower"],
};

/**
 * The tower's CAMERA.
 *
 * 🔴 It lived in `useState` inside `TransferTower` while declaring a URL key
 * named `viewpoint` — a word `NetWorthTerrain` and `CategoryMassif` declared
 * too, so wiring any of them naively would have put three surfaces on one
 * param. Made real on the owner's instruction, 2026-09-02, with a name only
 * this surface uses.
 *
 * ⚠️ `TOWER_VIEWPOINT_ORDER` already leads with `quarter`, which is the camera
 * the tower has always opened on — and `options[0]` IS the default, so the two
 * facts have to agree. `TransferTower.test.ts` asserts they do.
 */
export const FLOW_TOWER_VIEW_DIMENSION: ViewDimension = {
  key: "towerView",
  options: [...TOWER_VIEWPOINT_ORDER],
};

export const FLOW_VIEW_SPEC: ViewSpec = [
  FLOW_MEASURE_DIMENSION,
  FLOW_SHAPE_DIMENSION,
  FLOW_TOWER_VIEW_DIMENSION,
  LENS_DIMENSION, // ALWAYS last
];

export const FLOW_MEASURE_LABELS: Record<string, string> = { gross: "Gross", net: "Net" };
export const FLOW_SHAPE_LABELS: Record<string, string> = { spine: "Spine", tower: "Tower" };
export const FLOW_TOWER_VIEW_LABELS: Record<string, string> = {
  quarter: "Quarter",
  front: "Front",
  side: "Side",
  plan: "Plan",
};
