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

/** One line on each state, for a section note. */
export const SERIES_EVIDENCE_NOTE: Record<SeriesEvidence, string> = {
  active: "charged within their cadence, and forecast",
  "never-billed": "registered by hand and forecast — the bank has not charged them yet",
  "running-late": "still forecast — the last charge is older than the cadence allows",
  lapsed: "no longer forecast — quiet past the point a bill stops",
};
