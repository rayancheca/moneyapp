/**
 * What the EVIDENCE says about a live recurring series, and the one word each
 * surface uses for it.
 *
 * 🔴 `/recurring`'s All tab filed seven series under "INACTIVE" on 2026-09-03 —
 * five hand-registered commitments the bank has never billed and the owner's
 * weekly pay, each with a "Next" date on the same row and each projected by
 * the forecast one tab over. "Inactive" is not what any of them are. A series
 * that has never charged has no evidence to be stale FROM (the subscriptions
 * card already says "never billed"); one that is late is still forecast until
 * it lapses; and money in never lapses at all. Three facts wore one word, and
 * the word was wrong for all three.
 *
 * The rule lives in `services/recurring` (`seriesEvidence`); this is the
 * vocabulary, kept client-safe so components can label without importing the
 * database.
 */
export type SeriesEvidence = "active" | "never-billed" | "running-late" | "lapsed";

export const SERIES_EVIDENCE_LABEL: Record<SeriesEvidence, string> = {
  active: "Active",
  "never-billed": "Never billed",
  "running-late": "Running late",
  lapsed: "Lapsed",
};

/**
 * The note over the SUGGESTIONS section — the one bucket on the All tab that is
 * not an evidence state, and the one whose membership in the forecast a reader
 * cannot guess.
 *
 * 🔴 A `detected` series is projected exactly like a confirmed one: every
 * forecast query on this page selects `status in (detected, confirmed)`. On
 * 2026-09-04 the page read "In September 2026, 4 series are running late" over a
 * Running late section holding TWO rows — the other two were Amazon Prime and
 * Rocket Money, sitting under "Suggestions · 2 to review" with Confirm and Not
 * recurring buttons, and their $4.99 and $6.00 already inside the $3,567.60
 * PROJECTED SPENDING at the top of the same screen. Every other section on the
 * tab says whether it is forecast; the one that looks least forecast said
 * nothing.
 */
export const SUGGESTION_NOTE =
  "detected, not yet confirmed — and already in the forecast above, until you say they are not recurring";

/** One line on each state, for a section note. */
export const SERIES_EVIDENCE_NOTE: Record<SeriesEvidence, string> = {
  active: "charged within their cadence, and forecast",
  "never-billed": "registered by hand and forecast — the bank has not charged them yet",
  "running-late": "still forecast — the last charge is older than the cadence allows",
  lapsed: "no longer forecast — quiet past the point a bill stops",
};
