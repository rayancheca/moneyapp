import type { AppDatabase } from "@/db/client";
import { monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatMonthYear } from "@/lib/format-date";
import {
  countFact,
  deltaFact,
  factSet,
  rankFact,
  scalarFact,
  shareFact,
  trendFact,
  type Fact,
} from "@/lib/insight-facts";
import { checkClaim, type Accepted } from "@/lib/insight-validator";
import { categoryBreakdown } from "./analytics";
import { categoryMonthlyTrend } from "./category-detail";
import { moversCard, type MoversCard } from "./movers-card";
import { provenanceFor, type Provenance } from "./provenance";

/**
 * What /spending can say about itself, and prove.
 *
 * ⛔ Read `lib/insight-grammar.ts` first. Nothing here writes a sentence: this
 * module MEASURES, packages each measurement as a typed `Fact`, and asks
 * `checkClaim` whether a claim in the closed vocabulary is supported by it. The
 * words come from the vocabulary, the figures come from the ledger, and a claim
 * whose facts do not back it does not render.
 *
 * ## The window is somebody else's decision
 *
 * ⚠️ "Last month" is not the same as "a month the ledger has been shown". His
 * statements land weeks after the period they cover — SoFi's July statement
 * closes 2026-07-31 and August is still open — so a rank computed over the
 * running month would be a rank over whatever happens to have been imported so
 * far, and it would move every time a statement arrived.
 *
 * `moversCard` already answers exactly this ("the newest month every live
 * spender has been imported past"), including the trap it documents: requiring
 * EVERY account with any spend to be current lets one dormant account veto the
 * answer forever. So the window is taken from it rather than computed a second
 * time — two functions that must agree about a date must not both derive it.
 *
 * ## Every claim names its own window
 *
 * Because the window is not the period selector's, a sentence that did not say
 * which months it covered would be read as being about the period on screen.
 * The grammar makes that impossible: a rank renders the set it ranked, a delta
 * renders the two points it spans, a trend renders its start. The heading says
 * it once more in plain words.
 */

/** How many of the accepted claims reach the page. A wall of text is not an insight. */
export const MAX_INSIGHTS = 4;

/**
 * A trend needs every step to move the same way.
 *
 * ⛔ Deliberately the strictest reading available, and not a line fitted through
 * noise. "Has been climbing since July" is one of the three strings that got
 * this feature held, and the honest version of it is a claim about every month
 * in the window, not about the two ends. A category that rose, fell and rose
 * again gets no trend fact and therefore cannot be described as rising at all.
 */
export const TREND_MONTHS = 6;

export interface SpendingInsight {
  /**
   * Stable across renders — the React key, and a dismissal id later.
   *
   * Claim id AND slots, not the claim id alone: two candidates may legitimately
   * use one template about different facts (two categories, both risen), and a
   * duplicate key silently makes React reuse the wrong node.
   */
  id: string;
  /** the sentence, rendered by the app from its own vocabulary */
  text: string;
  /** which template said it — for the tests, and for a future per-claim opt-out */
  claimId: string;
  /**
   * The chain behind the figures in this sentence. An insight the app cannot
   * prove does not render, which is the same rule every other figure follows;
   * `null` is therefore a reason to DROP the insight, not to show it bare.
   */
  provenance: Provenance;
}

export interface SpendingInsights {
  /** the month every claim is about, e.g. "July 2026" */
  windowLabel: string;
  /**
   * Why that month and not the running one — measured, in the app's own words.
   * Null when the window IS the running month and needs no explanation.
   */
  windowNote: string | null;
  insights: SpendingInsight[];
}

interface Candidate {
  claimId: string;
  a: string;
  b?: string;
  /** whose transactions prove it — a top-level category id */
  categoryId: string;
}

/**
 * Facts and the claims worth trying on them, in the order they would be read.
 *
 * The ORDER is a judgement about interest and nothing else; every candidate
 * still has to pass `checkClaim`, so a reordering can change which four
 * sentences appear and can never change whether one is true.
 */
function buildCandidates(
  db: AppDatabase,
  card: MoversCard,
): { facts: Fact[]; candidates: Candidate[]; from: string; to: string } | null {
  const from = `${card.month}-01`;
  // `periodBounds` owns the calendar, exactly as `moversCard` defers to it
  const to = periodBounds(from, "monthly").end;
  const monthLabel = formatMonthYear(from);

  /*
   * Ranked by what was SPENT, and the explicit Uncategorized bucket is not a
   * category — it is the absence of one. Ranking it would let "the largest of
   * your spending categories" name a hole in the data.
   */
  const rows = categoryBreakdown(db, { from, to })
    .filter((r) => r.categoryId !== null && r.spentCents > 0)
    .sort((x, y) => y.spentCents - x.spentCents || x.name.localeCompare(y.name));
  if (rows.length === 0) return null;

  const top = rows[0]!;
  const totalCents = rows.reduce((sum, r) => sum + r.spentCents, 0);

  const facts: Fact[] = [
    rankFact("f1", top.name, 1, rows.length, "spending categories"),
    scalarFact("f2", top.name, top.spentCents, "money"),
    shareFact("f3", top.name, top.spentCents / totalCents, `everything you spent in ${monthLabel}`),
    /*
     * "transaction", not "purchase". `categoryBreakdown` counts every row the
     * bucket admits — a refund inside a category is one of them — and rent is
     * not a purchase in any case. The noun has to be true of all seven rows.
     */
    countFact("f4", top.name, top.txnCount, "transaction"),
  ];
  const candidates: Candidate[] = [
    { claimId: "largest_in_set", a: "f1", b: "f2", categoryId: top.categoryId! },
    { claimId: "share_of_whole", a: "f3", categoryId: top.categoryId! },
  ];

  /*
   * The biggest move against its own usual month, taken from `moversCard`'s own
   * rows so the two surfaces cannot disagree about a delta. A row it has marked
   * thin is skipped: its "usual" is two spends in six months, which is
   * lumpiness rather than a change, and the card says so in its own words.
   */
  const mover = card.movers.find((m) => m.categoryId !== null && m.thinNote === null && m.deltaCents !== 0);
  if (mover) {
    facts.push(
      deltaFact("f5", mover.categoryName, mover.deltaCents, "money", "its usual month", monthLabel),
    );
    candidates.push({
      claimId: mover.deltaCents > 0 ? "rose_between" : "fell_between",
      a: "f5",
      categoryId: mover.categoryId!,
    });
  }

  /*
   * A trend, only where every step agrees. `categoryMonthlyTrend` counts back
   * from a reference date, so it is anchored on the WINDOW's last day and not
   * on today — anchoring on today would slide a partly-imported month into the
   * series and let it decide the direction.
   */
  const points = categoryMonthlyTrend(db, top.categoryId!, TREND_MONTHS, to);
  const direction = monotonicDirection(points.map((p) => p.spentCents));
  if (direction !== null && points.length >= 3) {
    facts.push(trendFact("f6", top.name, direction, formatMonthYear(`${points[0]!.month}-01`), points.length));
    candidates.push({
      claimId: direction === "rising" ? "trend_rising" : direction === "falling" ? "trend_falling" : "trend_flat",
      a: "f6",
      categoryId: top.categoryId!,
    });
  }

  candidates.push({ claimId: "count_in_subject", a: "f4", categoryId: top.categoryId! });
  return { facts, candidates, from, to };
}

/**
 * The direction EVERY step agrees on, or null.
 *
 * Null is the common answer on real data and that is the point — a series that
 * changes its mind has no direction, and the honest response is to say nothing
 * about it rather than to fit a line through it and call the slope a trend.
 */
export function monotonicDirection(values: readonly number[]): "rising" | "falling" | "flat" | null {
  if (values.length < 3) return null;
  const steps = values.slice(1).map((v, i) => Math.sign(v - values[i]!));
  if (steps.every((s) => s > 0)) return "rising";
  if (steps.every((s) => s < 0)) return "falling";
  if (steps.every((s) => s === 0)) return "flat";
  return null;
}

export function spendingInsights(db: AppDatabase, today: string = todayIso()): SpendingInsights | null {
  const card = moversCard(db, today);
  // no fully-observed month means no window, and a window is what every claim
  // here names. Nothing to say is not a weakness — it renders as nothing.
  if (card === null) return null;

  const built = buildCandidates(db, card);
  if (built === null) return null;
  const facts = factSet(built.facts);

  const insights: SpendingInsight[] = [];
  for (const candidate of built.candidates) {
    if (insights.length >= MAX_INSIGHTS) break;
    const verdict = checkClaim(candidate, facts);
    if (!verdict.ok) continue;
    const provenance = provenanceFor(db, {
      kind: "categorySpend",
      categoryId: candidate.categoryId,
      from: built.from,
      to: built.to,
      label: (verdict as Accepted).text,
    });
    // an insight the app cannot prove does not render — the same rule as every
    // other figure on this page
    if (!provenance) continue;
    insights.push({
      id: `${candidate.claimId}:${verdict.factIds.join("+")}`,
      text: verdict.text,
      claimId: verdict.claimId,
      provenance,
    });
  }
  if (insights.length === 0) return null;

  const windowLabel = card.monthLabel;
  const windowNote =
    card.month === monthKey(today)
      ? null
      : `${card.currentMonthLabel} is still being imported, so these read ${windowLabel} — the newest month every account has been shown through.`;

  return { windowLabel, windowNote, insights };
}
