import type { SeriesKind } from "@/db/schema/recurring";

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
 *
 * ⛔ `schedule-ended` is the SCHEDULE's own let-go, as `lapsed` is the forecast's: a live series whose end
 * (`userEndsOn`) leaves no date still to come (`scheduleHasEnded`) — the Nov 11 car-insurance balance from Nov 12. Asked
 * before the evidence: a finished schedule is not late, never billed or lapsed, whatever its last charge says. 🔴 It
 * was ended to the subscriptions card and the annualized figure and live to its own page and the All tab (review of
 * 0af5689).
 */
export type SeriesEvidence =
  | "active"
  | "never-billed"
  | "awaiting-statements"
  | "running-late"
  | "lapsed"
  | "schedule-ended";

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
  // the subscriptions card's word for the same series: "1 has already ended, so it costs nothing going forward"
  "schedule-ended": "Ended",
};

/**
 * The badge tone for a live series' evidence — the series page's badge and every staleness chip (`staleMarkTone`):
 * ONE tone per state, a warning only of what is late — charged, then quiet past tolerance on read days, or let go.
 *
 * ⛔ Awaiting statements is not a warning: nothing is known to be wrong, only not yet checked far enough. 🔴 His pay's
 * page wore an amber "Running late" for a payday on a day no import covered (2026-10-08). ⛔ Nor is never billed:
 * nothing is late about a bill the bank has not charged yet (the calendar's Day Sheet). 🔴 The series page wore
 * "Never billed" in amber beside a chip that called the same state neutral (review of 2026-10-08).
 */
export function seriesEvidenceTone(evidence: SeriesEvidence): "neutral" | "warning" {
  return evidence === "running-late" || evidence === "lapsed" ? "warning" : "neutral";
}

/** The staleness facts a projected series' word is read from — `SeriesStaleness` (services/recurring), structurally. */
export interface StalenessFacts {
  /** when it was last seen; null when nothing — its own or its carrier's — ever matched */
  lastMatchedOn: string | null;
  /** past tolerance on days the ledger has checked */
  isStale: boolean;
  /** past tolerance today, but not by its checked day */
  awaitingStatements: boolean;
}

/**
 * The word for a series the forecast still PROJECTS, read off its staleness — `seriesEvidence` for every series it has
 * not let go (lapsed is the forecast's own let-go, `hasStoppedForecasting`), and the word every staleness chip, footer
 * and band reads. ONE predicate, so the All tab, the series page and the forecast above them cannot file one series
 * under two words.
 *
 * 🔴 The footer split its entries by the staleness flags itself (`staleSummaryLabel`), the All tab by `seriesEvidence`,
 * and on 2026-10-08 Amazon Prime read "running late" in the forecast's band and footer and "Lapsed" on the All tab of
 * the same page — the lapse measured to today on one surface and to the checked day on the other (§6A 57 put both on
 * the checked day; this keeps them on one word).
 *
 * ⚠️ `isStale` is true of a never-billed series too — no evidence is past every tolerance — so never billed is asked
 * first: "running late" is only true of a series that has posted.
 */
export function projectedEvidence(s: StalenessFacts): Exclude<SeriesEvidence, "lapsed" | "schedule-ended"> {
  if (s.lastMatchedOn === null) return "never-billed";
  if (s.isStale) return "running-late";
  return s.awaitingStatements ? "awaiting-statements" : "active";
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

/**
 * What one posting of a series is called, by kind — a deposit of money in, a transfer of money moved, a charge of the
 * rest: `seriesVerb`'s split (components/recurring/labels), whose past tense this is.
 */
const POSTING: Record<"charge" | "deposit" | "transfer", { noun: string; past: string }> = {
  charge: { noun: "charge", past: "charged" },
  deposit: { noun: "deposit", past: "deposited" },
  transfer: { noun: "transfer", past: "moved" },
};

/** The posting a series of this kind makes — the one place a kind is told a deposit from a charge. */
export function postingOf(kind: SeriesKind): (typeof POSTING)[keyof typeof POSTING] {
  if (kind === "income") return POSTING.deposit;
  if (kind === "transfer") return POSTING.transfer;
  return POSTING.charge;
}

/** "charge", "deposit", "charge or deposit" — every posting the kinds make, charge first, each once. */
function postingsOf(kinds: readonly SeriesKind[], part: "noun" | "past"): string {
  const made = new Set(kinds.map(postingOf));
  return Object.values(POSTING)
    .filter((p) => made.has(p))
    .map((p) => p[part])
    .join(" or ");
}

/**
 * One line on each state, for a section note — worded by the kinds the section HOLDS: "deposited" of his pay,
 * "charged" of a bill, both when both are there.
 *
 * 🔴 Review of 2026-10-08: the evidence words said "charge" of his payroll deposit — "N series have not been looked
 * for yet" over "the charge each is waiting on" (both gone with Awaiting statements, 2026-10-08), and still "charged
 * within their cadence" over his pay in Active and "the last charge is older than the cadence allows" over it in
 * Running late.
 *
 * ⚠️ Lapsed is money-out only — money in never lapses (`lapsedSeriesShouldStopForecasting`) — and its "bill" is a
 * transfer's too, which this does not settle. Awaiting statements says nothing of what posts.
 */
export function seriesEvidenceNote(evidence: SeriesEvidence, kinds: readonly SeriesKind[]): string {
  // an empty section prints no note; its words default to a bill's
  const of = kinds.length === 0 ? (["bill"] as const) : kinds;
  const chargesOnly = of.every((k) => postingOf(k) === POSTING.charge);
  switch (evidence) {
    case "active":
      return `${postingsOf(of, "past")} within their cadence, and forecast`;
    case "never-billed":
      // a bill's words as he has always read them; "the bank has not deposited" his pay would be false of who pays it
      return chargesOnly
        ? "registered by hand and forecast — the bank has not charged them yet"
        : `registered by hand and forecast — nothing has been ${postingsOf(of, "past")} for them yet`;
    case "awaiting-statements":
      return "still forecast — each one's tolerance runs out after the last day its accounts have been checked through, so none can be called late yet";
    case "running-late":
      return `still forecast — the last ${postingsOf(of, "noun")} is older than the cadence allows`;
    case "lapsed":
      return "no longer forecast — quiet past the point a bill stops";
    case "schedule-ended":
      // "more": a last date that came due unposted is still owed in its month (the Next column says so)
      return "nothing more forecast — every date their schedules hold has come";
  }
}

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
 * Can a series' own page reshape it — attach rows to it, merge another series in (§4.3)? Only a live one: rows moved
 * onto an ended or dismissed series leave the forecast and the calendar, and `mergeSeries` refuses such a target. ONE
 * predicate, because the page renders the controls on it and `seriesDetail` reads the merge preview on it (§6A 54).
 *
 * 🔴 The preview — every candidate and what merging it would file — was read on every series page, the ended and
 * dismissed pages included, where the control it feeds is hidden (review of §6A 54, 2026-10-08).
 */
export function seriesCanBeReshaped(status: SeriesStatusForCopy): boolean {
  return status === "detected" || status === "confirmed";
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
 *
 * ⛔ …nor a schedule its end has closed (`schedule-ended`, `scheduleHasEnded`). 🔴 Review of 0af5689: a month past
 * its one day, the Nov 11 balance's page read "charges once on Nov 11, about $72.74" with no "Nothing expected" card,
 * while its annualized figure and the subscriptions card had ended it (a copy of his ledger, asked about 2026-12-12).
 */
export function seriesIsProjected(status: SeriesStatusForCopy, evidence: SeriesEvidence): boolean {
  return !seriesIsOver(status) && evidence !== "lapsed" && evidence !== "schedule-ended";
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
  if (status === "ended")
    return "This series has ended, so nothing more is expected from it. Its charges below stay in the ledger.";
  if (status === "dismissed")
    return "You said this is not a recurring series, so nothing is expected from it and nothing is forecast. Its charges below stay in the ledger.";
  /* ⛔ Its schedule's own end, before the lapse: a new charge does not bring back a schedule with no date left.
     🔴 A month past its one day the Nov 11 balance's page said nothing of why nothing was expected (review of
     0af5689). "More": a last date that came due unposted is still owed this month — the already-due card says so. */
  if (evidence === "schedule-ended")
    return "Its schedule has ended — every date it holds has come — so nothing more is expected from it. Its charges below stay in the ledger.";
  return "This series has gone quiet past the point a bill stops, so it is no longer forecast and nothing more is expected from it — a new charge brings it back. Its charges below stay in the ledger.";
}
