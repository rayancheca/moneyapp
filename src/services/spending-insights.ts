import type { AppDatabase } from "@/db/client";
import { monthKey, periodBounds, todayIso } from "@/lib/dates";
import { formatMonthYear } from "@/lib/format-date";
import {
  countFact,
  deltaFact,
  rankFact,
  scalarFact,
  shareFact,
  trendFact,
  type Fact,
} from "@/lib/insight-facts";
import { isPrintableName } from "@/lib/printable-name";
import { categoryBreakdown } from "./analytics";
import { categoryMonthlyTrend } from "./category-detail";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { surfaceInsights, type InsightInput } from "./insight-surface";
import type { InsightCandidate, SurfaceInsights } from "./insights";
import { moversCard, type MoversCard } from "./movers-card";
import { provenanceFor } from "./provenance";

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

/** A candidate before its proof is wired — the surface knows the category, not the chain. */
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
  /**
   * Which category the sentences are about. `"largest"` is /spending's
   * question ("what dominated the month?"); a category id is
   * /categories/[id]'s ("where does this one sit?").
   *
   * ⛔ ONE builder for both, so the two pages cannot disagree about a rank, a
   * share or a trend. A second copy of this arithmetic would be a second
   * opinion, and the app's rule is that a figure has one.
   */
  subject: string | "largest" = "largest",
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

  const top = subject === "largest" ? rows[0]! : rows.find((r) => r.categoryId === subject);
  // a category with no spend in the observed month is not a weakness and not an
  // error — there is simply nothing measured to say about it
  if (!top) return null;
  /*
   * A subject this app cannot NAME is one it cannot write a sentence about, and
   * `insight-facts` refuses `< > { } \` in a label by THROWING — so without this
   * the page renders its error boundary. See `lib/printable-name`: the write
   * boundaries refuse such a name, but a bank prints what it prints and a row
   * already in the table predates any guard. Silence is not a weakness; a page
   * that will not render is.
   */
  if (!isPrintableName(top.name)) return null;
  const rank = rows.indexOf(top) + 1;
  const totalCents = rows.reduce((sum, r) => sum + r.spentCents, 0);

  const facts: Fact[] = [
    /*
     * ⛔ The window belongs in the SENTENCE, not only in the panel header.
     * "Housing is the largest of your 12 spending categories, at $2,653.58"
     * sat one screen above /spending's own table reading "Car 70% $6,457.58"
     * for the period on the selector — this panel does not follow that
     * selector, and a superlative with no window reads as a standing fact
     * about the ledger. Its sibling share fact already names the month; this
     * one now does too, in the same words.
     */
    rankFact("f1", top.name, rank, rows.length, `spending categories in ${monthLabel}`),
    scalarFact("f2", top.name, top.spentCents, "money"),
    shareFact("f3", top.name, top.spentCents / totalCents, `everything you spent in ${monthLabel}`),
    /*
     * "transaction", not "purchase". `categoryBreakdown` counts every row the
     * bucket admits — a refund inside a category is one of them — and rent is
     * not a purchase in any case. The noun has to be true of all seven rows.
     */
    countFact("f4", top.name, top.txnCount, "transaction", `in ${monthLabel}`),
  ];
  /*
   * ONE rank claim, chosen here rather than offered to the gate.
   *
   * ⛔ The division of labour matters. The gate decides what is TRUE — it would
   * accept both of these for a first-place category, because "is the largest"
   * and "is the 1st largest" are both true of a rank of 1. What it cannot know
   * is that printing both says the same thing twice, and redundancy is an
   * editorial judgement, which is this module's job and not the validator's.
   */
  const candidates: Candidate[] = [
    {
      claimId: rank === 1 ? "largest_in_set" : "ranked_in_set",
      a: "f1",
      b: "f2",
      categoryId: top.categoryId!,
    },
    { claimId: "share_of_whole", a: "f3", categoryId: top.categoryId! },
  ];

  /*
   * The biggest move against its own usual month, taken from `moversCard`'s own
   * rows so the two surfaces cannot disagree about a delta. A row it has marked
   * thin is skipped: its "usual" is two spends in six months, which is
   * lumpiness rather than a change, and the card says so in its own words.
   */
  const mover = card.movers.find(
    (m) =>
      m.categoryId !== null &&
      m.thinNote === null &&
      m.deltaCents !== 0 &&
      // on a category page the delta has to be about THAT category; the
      // cross-slot rule would refuse a sentence stapling another one's move to
      // this one's name, but offering it at all would be a bug worth not having
      (subject === "largest" || m.categoryId === subject) &&
      // the mover names a DIFFERENT category from `top`, so it needs its own
      // check — see the guard above
      isPrintableName(m.categoryName),
  );
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
  // the flag is not read here — `monotonicDirection` runs on the figures — but
  // the frontier is passed rather than faked, so this caller cannot drift into
  // asserting a reach it never checked
  const points = categoryMonthlyTrend(db, top.categoryId!, TREND_MONTHS, to, ledgerReaches(db), ledgerOpens(db));
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

/**
 * The strip on /spending: what dominated the newest fully-observed month.
 *
 * ⚠️ It does NOT follow the period selector, and every sentence names its own
 * window so it cannot be read as being about the period on screen.
 */
export function spendingInsights(db: AppDatabase, today: string = todayIso()): SurfaceInsights | null {
  return categoryInsights(db, "largest", today);
}

/** What /spending measured, before the kill switch and before any proof. */
export function spendingInsightInput(db: AppDatabase, today: string = todayIso()): InsightInput | null {
  return categoryInsightInput(db, "largest", today);
}

/**
 * The strip on /categories/[id]: where THIS category sits, in the same window
 * and through the same measurements /spending uses.
 */
export function categoryInsights(
  db: AppDatabase,
  subject: string | "largest",
  today: string = todayIso(),
): SurfaceInsights | null {
  /*
   * ⛔ Two surfaces, one builder, and therefore two kill-switch keys off the
   * same call. `/spending` asks "what dominated the month?" and a category page
   * asks "where does this one sit?" — the same measurement, but turning one off
   * must not silence the other, so the surface id follows the QUESTION rather
   * than the module.
   */
  return surfaceInsights(db, subject === "largest" ? "spending" : "category", categoryInsightInput(db, subject, today));
}

/** What a category page measured, before the kill switch and before any proof. */
export function categoryInsightInput(
  db: AppDatabase,
  subject: string | "largest",
  today: string = todayIso(),
): InsightInput | null {
  const card = moversCard(db, today);
  // no fully-observed month means no window, and a window is what every claim
  // here names. Nothing to say is not a weakness — it renders as nothing.
  if (card === null) return null;

  const built = buildCandidates(db, card, subject);
  if (built === null) return null;

  const candidates: InsightCandidate[] = built.candidates.map((c) => ({
    claimId: c.claimId,
    a: c.a,
    b: c.b,
    prove: () =>
      provenanceFor(db, {
        kind: "categorySpend",
        categoryId: c.categoryId,
        from: built.from,
        to: built.to,
      }),
  }));

  return {
    facts: built.facts,
    candidates,
    window: {
      label: card.monthLabel,
      /*
       * 🔴 This used to read "Sep 2026 is still being imported, so these read
       * Jul 2026", and the two halves are a two-month jump explained by a
       * one-month reason. A reader with August on screen — the period selector
       * does not move this panel — asks what happened to August, and the note
       * had skipped it silently.
       *
       * `moversCard` walks BACK from the current month and takes the first
       * candidate every live spending account is imported through, so every
       * month between the window and today failed that test by construction.
       * The note now says exactly that, and names the current month only as the
       * thing these figures are NOT.
       */
      note:
        card.month === monthKey(today)
          ? null
          /* 🔴 "every account" — the comment eight lines up says the true
             scope, "every live SPENDING account", and the rendered sentence
             dropped both words. `moversCard`'s `live` set takes only accounts
             with ≥3 non-zero baseline months that are present in
             `observationFrontier`, which excludes every investment account by
             design and drops accounts never imported. Measured 2026-09-10:
             `Robinhood Crypto` has been shown through 2026-06-30, before July
             closes, and `Capital One 360 Checking` through nothing at all. */
          : `${card.monthLabel} is the newest month every live spending account has been shown through, and no month after it is fully imported yet — so these read ${card.monthLabel} rather than ${card.currentMonthLabel}.`,
    },
  };
}
