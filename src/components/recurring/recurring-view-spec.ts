import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import { type ViewSpec } from "@/lib/view-state";

/**
 * The recurring series detail's switchable views (chart-parity pass 23). Only
 * the universal chart⇄table lens so far — the amount-history bars have no other
 * framing. One preference for all series (per-surface, consistent with the
 * model): a reader who wants the charge amounts as numbers wants that on every
 * subscription, not just the one they toggled.
 *
 * No "use client" so the server page can import it to resolve the active view.
 */
export const RECURRING_SERIES_SURFACE = "recurring-series";

export const RECURRING_SERIES_VIEW_SPEC: ViewSpec = [LENS_DIMENSION];

/**
 * How tall a day cell in the recurring calendar is allowed to be.
 *
 * ⛔ The problem is `aspect-square`, and it is only a problem on a wide screen.
 * `CalendarGrid` sizes days square, which is exactly right at 320px — a cell is
 * ~38px and the figures barely fit — and wrong at 1280px, where a column is
 * ~150px wide and therefore ~150px TALL. Six rows of that is a grid the owner
 * has to scroll to see, and cannot screenshot at all.
 *
 * ⚠️ A cap, not a fixed height. `max-height` leaves the square alone wherever it
 * still fits (every narrow screen) and only bites where the cell had grown
 * larger than its own content needs. The `max-sm:min-h-[4.5rem]` floor below the
 * `sm` breakpoint still wins, which is why the caps are `sm:`-gated.
 *
 * `regular` is the default and it CHANGES what this page used to look like —
 * deliberately, on the owner's report that the calendar is "massive". `tall` is
 * the old behaviour, kept because a big cell is the right one for reading a
 * month closely rather than at a glance.
 */
export const RECURRING_CALENDAR_SURFACE = "recurring-calendar";

export const CALENDAR_VIEW_SPEC: ViewSpec = [{ key: "cal", options: ["regular", "compact", "tall"] }];

export const CALENDAR_VIEW_LABELS: Record<string, string> = {
  regular: "Regular",
  compact: "Compact",
  tall: "Tall",
};

/**
 * The height cap per option, `sm:`-gated so no narrow screen is affected.
 *
 * `tall` carries no cap at all rather than a large one: an empty string is the
 * honest way to say "leave the square alone", and a 12rem cap would silently
 * become a second, invisible design decision the day a cell needed 13.
 */
export const CALENDAR_DENSITY_CLASS: Record<string, string> = {
  compact: "sm:max-h-[3.25rem]",
  regular: "sm:max-h-[5rem]",
  tall: "",
};
