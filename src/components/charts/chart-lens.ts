import { type ViewDimension } from "@/lib/view-state";

/**
 * The universal chart⇄table lens (chart-parity pass 23, roadmap #2): the honest
 * "show me the raw numbers" escape hatch every chart owes the reader. One
 * dimension, appended to each surface's own view spec, so it is shareable in
 * the URL (`?lens=table`) and sticky per surface — exactly like `view`/`unit`.
 *
 * A SEPARATE dimension rather than another option on an existing one: on the
 * investments surfaces `view` (Value/Return) and `unit` ($/%) are orthogonal to
 * how the data is drawn, and folding "table" into `view` would make
 * "the Return numbers, as a table" unrepresentable. `/spending` predates this
 * and keeps its table as an option of `cash`.
 *
 * No "use client" — the server pages import it to resolve the active view.
 *
 * ⚠️ Both investments panels index their spec POSITIONALLY (`SPEC[0]`/`SPEC[1]`),
 * so this must always be APPENDED to a spec, never inserted.
 */
export const LENS_DIMENSION: ViewDimension = { key: "lens", options: ["chart", "table"] };

export const LENS_LABELS: Record<string, string> = { chart: "Chart", table: "Table" };

/** Whether the resolved view is showing the table lens. */
export function isTableLens(state: Record<string, string>): boolean {
  return state[LENS_DIMENSION.key] === "table";
}
