/**
 * The "Ledger & Letterpress" surface vocabulary (Direction A+).
 *
 * The tokens themselves live in globals.css; this module is the single place
 * that decides WHAT EACH ONE MEANS, so the whole app inherits the look from
 * one file instead of every page re-inventing a shadow. Every string here is
 * Tailwind classes over mapped tokens — no raw colour ever appears in a
 * component, which is what keeps the WCAG measurements in globals.css true.
 *
 * ── The one idea ──────────────────────────────────────────────────────────
 * Depth here is INK PRESSED INTO PAPER, not elevation. A sheet that has risen
 * off the page catches the light along its top edge (--emboss-hi) and pools
 * ink underneath it (--emboss-lo). A slot pressed INTO the page does the
 * reverse: the ink pools along its top INNER edge and there is no catch-light
 * at all. That single inversion — PRESS.* vs PRESSED_SLOT — is the whole
 * language, and it is why a card and an input can share a border colour and
 * still read as opposites.
 *
 * ── Depth is RANKED, and the ranking is the point ─────────────────────────
 * If every surface floats, nothing does. Three steps, and a component picks
 * the SMALLEST one that still separates it from what is behind it:
 *
 *   PRESS.rule   (press-1)  a resting rule: a stat tile, a control, a caption
 *                           slug. Barely off the page. Most things live here.
 *   PRESS.card   (press-2)  a raised card: a plate, a table, a panel. The
 *                           workhorse — one step, not two.
 *   PRESS.lifted (press-3)  above the sheet entirely: toasts. Rare by design.
 *
 * Dialog surfaces (Sheet, Popover, CommandPalette) keep --shadow-sheet /
 * --shadow-overlay, which globals.css explicitly reserves for them; they join
 * the language through CATCH_LIGHT instead of by replacing their shadow.
 */

/** Ranked letterpress depth. Each token already carries its own catch-light. */
export const PRESS = {
  /** a resting rule — barely off the page */
  rule: "shadow-press-1",
  /** a raised card — the workhorse */
  card: "shadow-press-2",
  /** lifted clear of the sheet — rare */
  lifted: "shadow-press-3",
} as const;

export type PressRank = keyof typeof PRESS;

/**
 * The hairline catch-light on its own, for surfaces that must keep a reserved
 * shadow token. Composed, never stacked: a second `shadow-*` utility on the
 * same element replaces the first rather than adding to it.
 */
export const CATCH_LIGHT = "shadow-[inset_0_1px_0_var(--emboss-hi)]";

/** …the same, for a panel whose lit edge faces left (the md+ right drawer). */
export const CATCH_LIGHT_LEFT = "shadow-[inset_1px_0_0_var(--emboss-hi)]";

/** A dialog surface that keeps --shadow-overlay and gains the lit top edge. */
export const OVERLAY_PRESS =
  "shadow-[var(--shadow-overlay),inset_0_1px_0_var(--emboss-hi)]";

/**
 * A slot pressed INTO the page: bar tracks, inputs, skeleton bones, the well a
 * segmented control's thumb slides in. Ink pools at the top inner edge and
 * there is no catch-light — that is what makes it read as sunken rather than
 * merely darker.
 */
export const PRESSED_SLOT = "shadow-[inset_0_1px_0_var(--emboss-lo)]";

/* ── Sheets of paper ─────────────────────────────────────────────────────── */

/** The plate: the primary card, printed on the raised sheet. */
export const PLATE = `rounded-(--radius-card) border border-line bg-surface-raised ${PRESS.card}`;

/**
 * The leaf: a nested panel — a companion rail, a pinned footer, a well inside
 * a plate. --surface-leaf sits between sunken and surface so it reads as a
 * second sheet laid on the page rather than a second elevation.
 */
export const LEAF = `rounded-(--radius-card) border border-line bg-surface-leaf ${PRESS.card}`;

/**
 * A leaf lying FLAT on the page, with no depth at all — the empty state, the
 * placeholder, anything holding no figures. Spelled as its own recipe rather
 * than as `LEAF + shadow-none`, because Tailwind emits `.shadow-none` BEFORE
 * `.shadow-press-2` in the sheet: equal specificity, so the press wins and the
 * override silently does nothing. Cancelling a utility by adding another one
 * only works when you have checked which way the cascade actually falls.
 */
export const BLANK_LEAF = "rounded-(--radius-card) border border-line bg-surface-leaf";

/**
 * The slug: a printed caption, tagged down its left edge with an ink rule.
 * The 3px --accent-ink edge is the mark that says "this is set type, not UI".
 */
export const SLUG = `rounded-[3px] border border-line border-l-[3px] border-l-accent-ink bg-surface-leaf ${PRESS.rule}`;

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** The strong rule: 2px of --ink-display. Opens a masthead, closes a total. */
export const RULE_STRONG = "border-t-2 border-t-ink-display";
/** The hairline: 1px of --line at 3/4 strength, set under a strong rule. */
export const RULE_HAIR = "border-t border-t-line opacity-75";
/** The strong rule, drawn UNDER its element — a table's head rule. */
export const RULE_STRONG_BOTTOM = "border-b-2 border-b-ink-display";

/* ── Behaviour ───────────────────────────────────────────────────────────── */

/**
 * A pressable control. Hover warms to the leaf tone and firms its border;
 * active presses one pixel INTO the page — the physical claim the whole
 * direction rests on. --ease-ink arrives and stops dead: money must not bounce.
 */
export const CONTROL_MOTION =
  "transition-[color,background-color,border-color,box-shadow,opacity,translate] duration-(--duration-tap) ease-(--ease-ink) active:translate-y-px";

/** Hover for a control that owns a border. */
export const CONTROL_HOVER = "hover:border-line-strong hover:bg-surface-leaf";

/**
 * Picking a resting sheet up by exactly one rank on hover. Spelled out in full
 * rather than composed as `hover:${PRESS.card}` because Tailwind extracts
 * candidates from raw source TEXT — a variant assembled at runtime is a class
 * that never gets generated.
 */
export const LIFT_ON_HOVER = "hover:shadow-press-2";

/** Hover for a ledger row: the leaf slides under the cursor, nothing moves. */
export const ROW_HOVER =
  "transition-colors duration-(--duration-tap) ease-(--ease-ink) hover:bg-surface-leaf";
