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
export type SeriesEvidence = "active" | "never-billed" | "not-looked-for" | "running-late" | "lapsed";

/**
 * ⚖️ "Not looked for yet": quiet past its tolerance only over days after the last day its account has been checked
 * through — the voice of "the ledger has not looked for its deposit" (2026-10-07), never "late". Statements arrive
 * monthly, each on its own day, and the gap between them is the normal state (owner, 2026-08-05).
 */
export const SERIES_EVIDENCE_LABEL: Record<SeriesEvidence, string> = {
  active: "Active",
  "never-billed": "Never billed",
  "not-looked-for": "Not looked for yet",
  "running-late": "Running late",
  lapsed: "Lapsed",
};

/**
 * The badge tone for a live series' evidence. ⛔ Not looked for is not a warning: nothing is known to be wrong, only
 * not yet read. 🔴 His pay's page wore an amber "Running late" for a payday on a day no import covered (2026-10-08).
 */
export function seriesEvidenceTone(evidence: SeriesEvidence): "neutral" | "warning" {
  return evidence === "not-looked-for" ? "neutral" : "warning";
}

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

/**
 * What a LIVE series' row is qualified by — or, for a series that is no longer
 * live, its status instead.
 *
 * 🔴 `seriesEvidence`'s own docstring says it is "only meaningful for a
 * detected/confirmed series; a dismissed or ended one is described by its
 * status, and callers badge those separately" — and `/categories/<Food>` did
 * not. On 2026-09-04 it listed five series under "Recurring series", every one
 * of them **dismissed**, every one labelled "lapsed":
 *
 *     Nabila Inc                       weekly · lapsed   $3.00
 *     CC Vending                       weekly · lapsed   $2.53
 *     Fordham Sambazon                 biweekly · lapsed $6.60
 *     PURA VIDA BAY ROAD MIAMI BEACH   weekly · lapsed   $5.79
 *     YA-FIT Smoothie Bar              weekly · lapsed   $15.39
 *
 * "Lapsed" is an evidence state — a bill that WAS recurring and went quiet past
 * the point the forecast lets it go. Dismissed is the owner saying it was never
 * recurring at all, and it is also the detector's re-detection sink, so those
 * rows exist precisely because he rejected them. A page headed "Recurring
 * series" printed five of his rejections back to him as bills that had lapsed.
 *
 * Returns null for a live series with active evidence — nothing to qualify.
 */
export function seriesRowLabel(
  status: "detected" | "confirmed" | "dismissed" | "ended",
  evidence: SeriesEvidence,
): string | null {
  if (status === "ended") return "ended";
  if (status === "dismissed") return "not recurring";
  if (status === "detected") return evidence === "active" ? "suggested" : `suggested · ${SERIES_EVIDENCE_LABEL[evidence].toLowerCase()}`;
  return evidence === "active" ? null : SERIES_EVIDENCE_LABEL[evidence].toLowerCase();
}

/** One line on each state, for a section note. */
export const SERIES_EVIDENCE_NOTE: Record<SeriesEvidence, string> = {
  active: "charged within their cadence, and forecast",
  "never-billed": "registered by hand and forecast — the bank has not charged them yet",
  "not-looked-for":
    "still forecast — the charge each is waiting on falls after the last day its account has been checked through, so the ledger has not looked for it yet",
  "running-late": "still forecast — the last charge is older than the cadence allows",
  lapsed: "no longer forecast — quiet past the point a bill stops",
};

/** The four statuses this vocabulary speaks about. */
export type SeriesStatusForCopy = "detected" | "confirmed" | "dismissed" | "ended";

/**
 * The two statuses the forecast does not project — ONE predicate, because two
 * sentences on one page turn on it.
 *
 * 🔴 `noScheduleReason` owned this test privately and `CadenceSentence` did not
 * ask it. Measured on the owner's ledger 2026-09-10: all **27** ended or
 * dismissed series opened with a present-tense schedule — "charges monthly
 * around the 8th, about $1,786.46 from Chase Checking" — three cards above
 * "Nothing expected · This series has ended, so nothing more is expected from
 * it." Twenty-five of them still carry a stored `next_expected_on`, which is
 * where that day-of-month comes from; `Hoffman LL`'s is 2026-02-08 and its last
 * charge is fifteen months older still.
 *
 * ⛔ The 2026-09-04 pass dropped the "Next expected" CARD for these and left
 * the sentence that names the same schedule in the present tense. A card
 * removed is not a claim withdrawn.
 */

/**
 * Why a series' own page shows no schedule — for the two statuses the forecast
 * does not project.
 *
 * 🔴 `/recurring/<Hoffman LL>` on 2026-09-04 carried the badge "Ended · Bill"
 * over "Next expected — Sep 8, 2026 -$1,786.46 · Oct 8 · Nov 8", of a series
 * whose one linked charge is dated 2025-06-02, fifteen months earlier.
 * `/recurring/<YA-FIT Smoothie Bar>` read "Dismissed · Bill" over three more,
 * on dates 4 days apart that its own lead sentence called "weekly on
 * Thursdays" — a Friday, a Tuesday and a Saturday.
 *
 * `listSeries` refuses exactly this and says so: "rolling a dismissed/ended
 * series forward would invent a future charge." The page ABOUT the series was
 * the one place that did it anyway. Dropping the card silently would leave the
 * reader wondering; this is the sentence that goes where it was.
 */
export function seriesIsOver(status: SeriesStatusForCopy): boolean {
  return status === "ended" || status === "dismissed";
}

/**
 * The statuses whose charges are DRAWN as recurring — every status but
 * dismissed. ONE predicate, because four surfaces turn on it.
 *
 * Dismissed is the owner saying "not recurring" (the button is labelled that),
 * and it is also the detector's re-detection sink: its rows keep their link
 * precisely so the same group is not suggested again. The LINK is right; any
 * label built from it that says "recurring" re-asserts the claim he rejected.
 * `ended` stays — it WAS recurring and stopped, and its history is real.
 *
 * The rule was restated three times before it had a name — the calendar's
 * history population (`recurringCalendar`), `/categories`' "Recurring series"
 * card (`seriesInCategory`), and `seriesRowLabel` above ("not recurring") — and
 * the ledger's "R" badge asked none of them.
 *
 * 🔴 Measured on the real ledger 2026-09-14: 60 active rows linked to the 10
 * dismissed series wore the Recurring badge on /transactions, the dashboard and
 * the account pages; `?q=PURA VIDA BAY ROAD` badged 10 of its 13 rows.
 */
export const RECURRING_HISTORY_STATUSES = ["detected", "confirmed", "ended"] as const;

export function seriesDrawsAsRecurring(status: SeriesStatusForCopy): boolean {
  return status !== "dismissed";
}

export function noScheduleReason(status: SeriesStatusForCopy): string | null {
  if (!seriesIsOver(status)) return null;
  if (status === "ended")
    return "This series has ended, so nothing more is expected from it. Its charges below stay in the ledger.";
  if (status === "dismissed")
    return "You said this is not a recurring series, so nothing is expected from it and nothing is forecast. Its charges below stay in the ledger.";
  return null;
}
