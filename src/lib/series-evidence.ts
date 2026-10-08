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
export type SeriesEvidence = "active" | "never-billed" | "awaiting-statements" | "running-late" | "lapsed";

/**
 * ⚖️ "Awaiting statements": past its tolerance today, but not by the last day every account it posts to has been
 * checked through — so it cannot be called late until a statement covers more. Never "late": statements arrive
 * monthly, each on its own day, and the gap between them is the normal state (owner, 2026-08-05). /budgets' word for a
 * verdict withheld until the days are covered, for the same reason.
 *
 * 🔴 It was "Not looked for yet", which is false once a statement covers the charge's due day but not the end of its
 * grace: the real Breezeline row (2026-10-08 copy), due Oct 11, checked through Oct 13, tolerance out on Oct 24. The
 * state is decided by when the TOLERANCE runs out, so its words say that, true on both sides of the due day.
 */
export const SERIES_EVIDENCE_LABEL: Record<SeriesEvidence, string> = {
  active: "Active",
  "never-billed": "Never billed",
  "awaiting-statements": "Awaiting statements",
  "running-late": "Running late",
  lapsed: "Lapsed",
};

/**
 * The badge tone for a live series' evidence. ⛔ Awaiting statements is not a warning: nothing is known to be wrong,
 * only not yet checked far enough. 🔴 His pay's page wore an amber "Running late" for a payday on a day no import
 * covered (2026-10-08).
 */
export function seriesEvidenceTone(evidence: SeriesEvidence): "neutral" | "warning" {
  return evidence === "awaiting-statements" ? "neutral" : "warning";
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
 * The note over the suggestions actually on the tab: `SUGGESTION_NOTE` while the forecast carries every one of them,
 * and the exception named — in the word each such card is marked with — when it does not.
 *
 * 🔴 A detected series is projected like a confirmed one only while the forecast has not LET IT GO
 * (`seriesIsProjected`). On a copy of the owner's ledger 2026-10-08 the note said "already in the forecast above" over
 * Rocket Money (running late, forecast) and Amazon Prime, whose own card read "· lapsed" and whose $4.99 was in no
 * figure above it: Committed $3,569.98 over 8 lines, without it. The claim was true of one card of two.
 */
export function suggestionNote(evidences: readonly SeriesEvidence[]): string {
  const exception = evidences.find((e) => !seriesIsProjected("detected", e));
  if (exception === undefined) return SUGGESTION_NOTE;
  const mark = SERIES_EVIDENCE_LABEL[exception].toLowerCase();
  return `detected, not yet confirmed — and, unless marked ${mark}, already in the forecast above, until you say they are not recurring`;
}

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
  "awaiting-statements":
    "still forecast — each one's tolerance runs out after the last day its accounts have been checked through, so none can be called late yet",
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
 * Does a series' own page PROJECT it — a present-tense schedule with a day to edit, rather than "Nothing expected"?
 * The client-safe reading of `seriesIsForecast` (services/recurring), from the two facts the page already carries: a
 * status the forecast projects (`seriesIsOver` names the other two), and evidence the forecast has not let go —
 * `lapsed` is exactly `hasStoppedForecasting` for a live series (`seriesEvidence`; recurring.test asserts the two
 * agree for every status, kind and age). ONE predicate, because the cadence sentence, the "Nothing expected" card and
 * the suggestions note all turn on it.
 *
 * 🔴 The lapse was carried into `noScheduleReason` privately (`evidence === "lapsed"`) and `CadenceSentence` kept
 * asking `seriesIsOver` alone — the split recorded above `seriesIsOver`, again. On a copy of the owner's ledger
 * 2026-10-08 `/recurring/<Amazon Prime>` read "charges monthly around the 5th, about $4.99" — the 5th read off a
 * stored 2026-08-05 — above "Nothing expected · …nothing more is expected from it", with a date editor whose Save
 * toasted "Next expected …" while the page, which judges the lapse by the last charge, kept saying "Nothing expected".
 */
export function seriesIsProjected(status: SeriesStatusForCopy, evidence: SeriesEvidence): boolean {
  return !seriesIsOver(status) && evidence !== "lapsed";
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

/**
 * ⛔ …and for a LIVE series the forecast has let go — the evidence's `lapsed`, which is the app's reading, not his
 * decision, so the sentence says what brings it back. 🔴 Its page stopped projecting it (`seriesIsForecast`) and the
 * "Next expected" card went with nothing in its place: `/recurring/<Amazon Prime>` would have read "Lapsed" over no
 * schedule and no word why. A card removed is not a claim withdrawn, and a claim withdrawn needs its reason.
 *
 * ⛔ Speaks for exactly the series `seriesIsProjected` says the page does not project — the predicate the cadence
 * sentence asks too, so the two cannot disagree about whether anything is expected.
 */
export function noScheduleReason(status: SeriesStatusForCopy, evidence: SeriesEvidence): string | null {
  if (seriesIsProjected(status, evidence)) return null;
  if (!seriesIsOver(status))
    return "This series has gone quiet past the point a bill stops, so it is no longer forecast and nothing more is expected from it — a new charge brings it back. Its charges below stay in the ledger.";
  if (status === "ended")
    return "This series has ended, so nothing more is expected from it. Its charges below stay in the ledger.";
  if (status === "dismissed")
    return "You said this is not a recurring series, so nothing is expected from it and nothing is forecast. Its charges below stay in the ledger.";
  return null;
}
