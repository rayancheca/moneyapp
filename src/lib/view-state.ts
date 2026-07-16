/**
 * View-state model — the shared, pure core behind "switchable views everywhere"
 * (North Star #2, Pillar 2). A surface declares a VIEW SPEC (its switchable
 * dimensions and each one's allowed values), and this module resolves the ACTIVE
 * view from three precedence layers and encodes a chosen view back to URL params:
 *
 *   URL param  >  the user's persisted per-surface preference  >  the spec default
 *
 * URL wins so a view is shareable and the back button works (same rule as
 * period.ts); the persisted layer (app_settings) makes a chosen view sticky
 * across visits; the spec default (each dimension's first option) is the floor.
 * Unknown/typo'd values are dropped, never thrown — a bad URL falls back
 * gracefully, exactly like resolvePeriod. Pure + DB-free + clock-free.
 *
 * Only NON-DEFAULT dimensions are written to the URL, so a default view produces
 * a clean URL and shared links stay minimal (mirrors period.ts's param helpers).
 */

/** One switchable dimension of a surface; `options[0]` is its default. */
export interface ViewDimension {
  /** the URL param key AND the app_settings key for this dimension (e.g. "chart") */
  key: string;
  /** allowed values, in display order; the FIRST is the default */
  options: readonly string[];
}

/** A surface's switchable dimensions. */
export type ViewSpec = readonly ViewDimension[];

/** dimension key → chosen value */
export type ViewState = Record<string, string>;

/** The default value of a dimension (its first option). */
export function dimensionDefault(dim: ViewDimension): string {
  // a spec dimension always declares at least one option; guard anyway so a
  // malformed spec degrades to "" rather than throwing at a render boundary.
  return dim.options[0] ?? "";
}

/** Every dimension at its default — the floor a resolve falls back to. */
export function specDefaults(spec: ViewSpec): ViewState {
  const out: ViewState = {};
  for (const dim of spec) out[dim.key] = dimensionDefault(dim);
  return out;
}

/** A value is valid for a dimension only if it is one of the declared options. */
function isValid(dim: ViewDimension, value: string | undefined): value is string {
  return value !== undefined && dim.options.includes(value);
}

/**
 * Resolve the active view for a surface from the three precedence layers.
 * For each dimension: the URL value if valid, else the persisted value if valid,
 * else the dimension default. A resolved state ALWAYS has every dimension set.
 */
export function resolveViewState(
  spec: ViewSpec,
  urlParams: Record<string, string | undefined>,
  persisted: ViewState | undefined,
): ViewState {
  const out: ViewState = {};
  for (const dim of spec) {
    const fromUrl = urlParams[dim.key];
    const fromPersisted = persisted?.[dim.key];
    if (isValid(dim, fromUrl)) out[dim.key] = fromUrl;
    else if (isValid(dim, fromPersisted)) out[dim.key] = fromPersisted;
    else out[dim.key] = dimensionDefault(dim);
  }
  return out;
}

/**
 * The URL params for a chosen view — only the dimensions whose value differs
 * from the default, so a default view yields `{}` (a clean URL) and a link
 * carries just the deviations. Unknown/invalid values are dropped.
 */
export function viewStateToParams(spec: ViewSpec, state: ViewState): Record<string, string> {
  const params: Record<string, string> = {};
  for (const dim of spec) {
    const value = state[dim.key];
    if (isValid(dim, value) && value !== dimensionDefault(dim)) params[dim.key] = value;
  }
  return params;
}

/**
 * A new ViewState with one dimension changed to `value` (immutably). An unknown
 * dimension key or an invalid value is a no-op — the caller can only ever move
 * to a declared option, so the URL/settings can never hold garbage.
 */
export function setDimension(
  spec: ViewSpec,
  state: ViewState,
  key: string,
  value: string,
): ViewState {
  const dim = spec.find((d) => d.key === key);
  if (!dim || !isValid(dim, value)) return state;
  if (state[key] === value) return state; // no-op keeps referential stability
  return { ...state, [key]: value };
}

/**
 * Build the query string for a view href: the preserved `base` params (period,
 * filters — passed through untouched) plus the non-default view dimensions.
 * Returns "" when there is nothing to encode, else "?a=b&c=d" (deterministic key
 * order: base first in insertion order, then spec order).
 */
export function viewHrefQuery(
  spec: ViewSpec,
  state: ViewState,
  base: Record<string, string> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v !== "") sp.set(k, v);
  }
  const viewParams = viewStateToParams(spec, state);
  for (const dim of spec) {
    if (viewParams[dim.key] !== undefined) sp.set(dim.key, viewParams[dim.key]!);
  }
  const q = sp.toString();
  return q === "" ? "" : `?${q}`;
}
