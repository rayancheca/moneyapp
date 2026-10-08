import type { AppDatabase } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import type { EvidenceSource } from "@/lib/billed-with";
import { todayIso } from "@/lib/dates";
import { rankFact, scalarFact, shareFact, type Fact } from "@/lib/insight-facts";
import { isPrintableName } from "@/lib/printable-name";
import { seriesIsIncomeOrSpending } from "@/lib/series-kind";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsSeries } from "./analytics";
import { withBillingCarriers } from "./billing-carriers";
import { silenceMeasuredThroughBySeries } from "./cash-earnings";
import { surfaceInsights, type InsightInput } from "./insight-surface";
import type { InsightCandidate, SurfaceInsights } from "./insights";
import { provenanceFor } from "./provenance";
import { listSeries, seriesIsForecast, type SeriesOverrides, type SeriesView } from "./recurring";

/** Exactly what `seriesHasLapsed` reads — the stored row, overrides intact, and the carrier it is billed with. */
type LapseInput = SeriesOverrides & EvidenceSource;

/**
 * What `/recurring/[id]` can say that the series' own figures do not.
 *
 * ⛔ Read `lib/insight-grammar.ts` first and `merchant-insights.ts` second. That
 * module's mistake was restating figures the page already printed, and this
 * page prints a lot of them: `SeriesDetail` renders the annualized cost, the
 * cadence, the confidence, the linked-transaction count and the amount history
 * chart. A sentence about any of those says the same thing twice in two voices.
 *
 * What no figure on this page can show is where this commitment sits among the
 * others, and how much of a year's committed money it is. That is the whole
 * subject of this module: its place, never its own numbers.
 *
 * ## ⛔ Money out and money in are ranked apart
 *
 * `annualizedCents` is a MAGNITUDE — `Math.abs` — so a $54,444/yr cash job and
 * a $27,428/yr rent are the same size to a sort, and one ranking over both
 * would tell him his income is the largest thing he pays for. They are two
 * questions, so they are two sets, and the sentence names which one it ranked
 * in. Income kind here is the one `lapsedSeriesShouldStopForecasting` already
 * distinguishes; this module does not invent a second test for direction. A
 * transfer series answers neither question and is in neither set
 * (`seriesIsIncomeOrSpending`).
 *
 * ## ⛔ "Your commitments" is the LIVE set, and most of them are not
 *
 * Of 38 series on the real ledger, 11 are dismissed and 12 ended — 23 of 38 are
 * over. Ranking against all 38 would say "the largest of your 38 commitments"
 * about a set two thirds of which he has already cancelled, and would put every
 * dead subscription into the denominator of the share. So the set is the one
 * that is still running, decided by the rules the app ALREADY owns:
 * `status` confirmed or detected, and — for money out only —
 * `lapsedSeriesShouldStopForecasting` + `seriesHasLapsed`, the same pair
 * `upcomingOccurrences` gates its forecast on. Naming a fresh condition here
 * would be a second definition of "still running" that could drift from the
 * calendar's without either being wrong on its own.
 *
 * ⛔ A series that is NOT in that set — ended, dismissed, or lapsed — gets no
 * strip at all. It is not ranked last among the living, and it is not given a
 * 0% share: it is simply not a member of the set the sentence is about. Nothing
 * to say is not a weakness, which is the distinction that has now cost five
 * services in this codebase.
 *
 * ## The ranking basis is IN the sentence, not beside it
 *
 * Rent is $2,285.70 a month and $27,428.40 a year, and `largest_in_set` prints
 * only "at {{b.value}}". A sentence reading "…at $27,428.40" over a page whose
 * every other figure is per-occurrence would be true of the fact and wrong to a
 * reader — the exact shape of the bug that printed "rose by +$1,185.70" over a
 * month he paid LESS. So the basis is carried in the rank's own `amongLabel`
 * ("by what they cost in a year"), which the grammar renders inside the
 * sentence, rather than in the window label beside it where a reader scanning
 * the line would never meet it.
 */

/** Below two, a rank is not a ranking and a share is 100% of one thing. */
const MIN_SERIES_TO_COMPARE = 2;

/**
 * Still running, by the rules the forecast already uses — never a fresh test.
 *
 * ⚠️ `seriesHasLapsed` is handed the RAW row, not the `SeriesView`. A view
 * carries the EFFECTIVE cadence with the override already folded in and its
 * `userCadence` gone, and `seriesStaleness` reads that field to decide whether
 * the tolerance steps by the detected interval or by the cadence's nominal
 * length. Rebuilding an overrides-shaped object out of a view would silently
 * take the other branch, so this series' liveness could differ from the same
 * series' liveness on the calendar — two functions computing one date, which is
 * the pass-54 mistake. The row is the input every other caller passes.
 */
function isLive(view: SeriesView, row: LapseInput | undefined, today: string, checkedThrough: string | null): boolean {
  if (view.annualizedCents === null) return false;
  if (!row) return false;
  // the rule every forward leg asks — this module wrote its own copy first, and was the only one to ask the lapse
  return seriesIsForecast({ ...row, kind: view.kind, status: view.status }, today, checkedThrough);
}

export function recurringInsights(
  db: AppDatabase,
  seriesId: string,
  today: string = todayIso(),
): SurfaceInsights | null {
  return surfaceInsights(db, "recurring", recurringInsightInput(db, seriesId, today));
}

/** What the page measured, before the kill switch and before any proof. */
export function recurringInsightInput(
  db: AppDatabase,
  seriesId: string,
  today: string = todayIso(),
): InsightInput | null {
  const all = listSeries(db, today);
  /*
   * ⛔ Every row, unfiltered. `isLive` is the ONE place that decides what is
   * still running, and a `where` clause here would quietly become a second one:
   * the status test below would then be dead code that still LOOKED
   * load-bearing, and a later change to either would silently disagree with the
   * other. Measured — with the query filtered, deleting the status test broke
   * no test at all.
   */
  // each with the carrier it is billed with, whose postings are its evidence (`lastSeenOn`, §6A 59)
  const rows = new Map(
    withBillingCarriers(db, db.select().from(recurringSeries).all()).map((r) => [r.id, r as LapseInput]),
  );
  // the lapse is measured to each series' checked day, as `listSeries` measured it (§6A 57)
  const checkedOf = silenceMeasuredThroughBySeries(db, today);
  const self = all.find((s) => s.id === seriesId);
  if (!self || !isLive(self, rows.get(seriesId), today, checkedOf(seriesId))) return null;
  /*
   * A subject this app cannot NAME is one it cannot write a sentence about, and
   * `insight-facts` refuses `< > { } \` in a label by THROWING — so without this
   * the page renders its error boundary. See `lib/printable-name`: the write
   * boundaries refuse such a name, but a bank prints what it prints and a row
   * already in the table predates any guard. Silence is not a weakness; a page
   * that will not render is.
   */
  if (!isPrintableName(self.name)) return null;

  /*
   * ⚖️ The deposit set is "what YOUR scheduled deposits bring in", and what the agent's cash is paid is not his
   * (`isAgentsIncomeSeries`, owner decision 2026-09-28, §6A 27): no member of either set, and its own page ranks it
   * among nothing. 🔴 Counted as a deposit, the agent's month-end interest made his pay "the largest of 2". Nor is
   * what the agent's cash pays one of his commitments (`isAgentsSeries`, owner decision 2026-10-02, §6A 34).
   *
   * ⚖️ Nor is a transfer series, either leg: it moves his money between his own accounts, so it is neither what he
   * pays nor what he is paid (`seriesIsIncomeOrSpending`, the rule the forecast card's net applies; `committed.ts`
   * leaves transfers out of what he owes for the same reason). 🔴 Split on `kind === "income"` alone, every transfer
   * was a commitment: the synthetic Chase autopay ($993.02 a month) beside a $1,800.00 rent and a $15.49 Netflix
   * made Rent "64.1% of what your scheduled commitments cost in a year", where the two commitments give 99.1%.
   *
   * ⛔ The series is ranked only on a side it is a member of, by the predicate the side is built from — or a page
   * outside every set would rank itself 0th among the others.
   */
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const isIncome = self.kind === "income";
  const onSide = (s: SeriesView): boolean =>
    seriesIsIncomeOrSpending(s.kind) && (s.kind === "income") === isIncome && !isAgentsSeries(agentsCash, s);
  if (!onSide(self)) return null;
  const side = all.filter((s) => isLive(s, rows.get(s.id), today, checkedOf(s.id)) && onSide(s));
  if (side.length < MIN_SERIES_TO_COMPARE) return null;

  const annualized = self.annualizedCents!;
  if (annualized <= 0) return null;

  /*
   * Ties broken by name so the rank is stable across renders — two commitments
   * at the same yearly cost must not swap places between two page loads and
   * make one of them "the largest" only sometimes.
   *
   * ⚠️ Redundant TODAY and kept anyway: `listSeries` already ends its own sort
   * with the same name comparison and JS sort is stable, so deleting this line
   * changes no output and breaks no test — measured, not assumed. It stays
   * because the guarantee would otherwise be INHERITED from an upstream sort
   * that has no reason to keep it, and the failure would be a rank that flickers
   * between renders with every test still green.
   */
  const ranked = [...side].sort(
    (a, b) => b.annualizedCents! - a.annualizedCents! || a.name.localeCompare(b.name),
  );
  const rank = ranked.findIndex((s) => s.id === seriesId) + 1;
  const sideTotal = side.reduce((sum, s) => sum + s.annualizedCents!, 0);

  const amongLabel = isIncome
    ? "scheduled deposits, by what they bring in over a year"
    : "scheduled commitments, by what they cost in a year";
  const ofLabel = isIncome
    ? "what your scheduled deposits bring in over a year"
    : "what your scheduled commitments cost in a year";

  const facts: Fact[] = [];
  const candidates: InsightCandidate[] = [];
  const prove = () => provenanceFor(db, { kind: "recurringSeries", id: seriesId, today });

  facts.push(rankFact("f1", self.name, rank, ranked.length, amongLabel));
  facts.push(scalarFact("f2", self.name, annualized, "money"));
  // one rank claim, not both: "the largest" and "the 1st largest" are the same
  // sentence, and printing both would say it twice
  candidates.push({ claimId: rank === 1 ? "largest_in_set" : "ranked_in_set", a: "f1", b: "f2", prove });

  /*
   * Its share of the side it belongs to. `shareFact` refuses anything outside
   * 0–1 rather than clamping, and the guard here is the same one stated: every
   * member's annualized figure is a magnitude, so no member can exceed the sum
   * and the share cannot pass 1 — but the check is written because the THROW
   * would be the second place it was caught, not the first.
   */
  if (sideTotal > 0 && annualized <= sideTotal) {
    facts.push(shareFact("f3", self.name, annualized / sideTotal, ofLabel));
    // above half, the stronger template says the same measurement in one fewer
    // step for a reader; below it, the plain share is the only honest form
    candidates.push({
      claimId: annualized / sideTotal > 0.5 ? "more_than_half" : "share_of_whole",
      a: "f3",
      prove,
    });
  }

  /*
   * The note explains the DENOMINATOR, which is the one thing a reader cannot
   * check from the sentence. Counted here rather than described, so it cannot
   * drift from the set the ranking actually used.
   */
  /*
   * 🔴 …AND THE OTHER HALF OF THE SAME PAIR. The sided fix below was applied to
   * the 13 and never to the 27 beside it: `retired` counted BOTH sides, so a
   * commitment's note read "Ranked against the 13 scheduled commitments still
   * running. The 27 you have ended or dismissed are not counted." — a
   * 40-series population where the commitment side holds 36. Measured
   * 2026-09-10: 27 retired in all (11 dismissed + 16 ended) of which 4 are
   * income-kind, so the count that belongs beside the 13 is 23.
   *
   * ⛔ The same predicate the side is built from, so the two cannot disagree
   * about which series the sentence is about.
   */
  const retired = all.filter((s) => (s.status === "ended" || s.status === "dismissed") && onSide(s)).length;
  /*
   * 🔴 …and the denominator is one SIDE of the live series, not all of them.
   * "Ranked against the 13 still running" read on 2026-09-04 beside a tab badge
   * saying "All 14": the fourteenth is the owner's weekly pay, live and ranked
   * on the other side. With "the 27 you have ended or dismissed" beside it the
   * pair implied a population of 40 where the ledger holds 41.
   *
   * The side's own noun is the one the ranking sentence above already uses, so
   * the two cannot describe different sets.
   */
  const sideNoun = isIncome ? "scheduled deposits" : "scheduled commitments";
  const note =
    retired > 0
      ? `Ranked against the ${side.length} ${sideNoun} still running. The ${retired} you have ended or dismissed are not counted.`
      : null;

  return { facts, candidates, window: { label: "a year at today's amounts", note } };
}
