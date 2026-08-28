import type { AppDatabase } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { rankFact, scalarFact, shareFact, type Fact } from "@/lib/insight-facts";
import { isPrintableName } from "@/lib/printable-name";
import { budgetStatuses, totalBudgetedCents, type BudgetStatus } from "./budgets";
import { runInsights, type InsightCandidate, type SurfaceInsights } from "./insights";
import { provenanceFor } from "./provenance";

/**
 * What `/budgets` can say that its own rows do not.
 *
 * The page prints every plan amount, and prints them ordered by CATEGORY. So
 * which one is the biggest, and how much of the whole month it is, are two
 * facts a reader can only get by doing arithmetic down the page — which is the
 * test `merchant-insights` failed and this module has to pass: a sentence that
 * restates a figure already on screen is noise in a second voice.
 *
 * ## ⛔ A plan is proven differently from a sum
 *
 * `/budgets` already mounts `categorySpend` beside each row's ACTUAL. That
 * proof is wrong for these sentences, and reaching for it is the mistake
 * `merchant-insights` made when it tried to prove a merchant's spend with the
 * dominant category's rows. A budget amount is not a sum of anything — it is a
 * decision — so it takes `budgetPlan`, whose honest answer is that nothing
 * checks it because there is nothing to check a plan against.
 *
 * ## ⛔ The set is MONTHLY, borrowed rather than invented
 *
 * A daily budget of $5 and an annual one of $400 are not comparable magnitudes,
 * and one ranking over both would put a year beside a day. The page already
 * decided this: its income comparison is scoped to monthly budgets because
 * "they are the ones whose window matches a pay cycle". This module uses the
 * same set and the same denominator function — `totalBudgetedCents`, which
 * excludes a child budget sitting inside a budgeted parent so nothing is
 * counted twice — rather than defining a second idea of "everything budgeted"
 * that could drift from the figure printed at the top of the page.
 */

/** Below two, a rank is not a ranking and a share is 100% of one thing. */
const MIN_BUDGETS_TO_COMPARE = 2;

export function budgetInsights(db: AppDatabase, today: string = todayIso()): SurfaceInsights | null {
  const monthly = budgetStatuses(db, today).filter((s) => s.budget.period === "monthly");

  /*
   * The same exclusion `totalBudgetedCents` applies to the denominator, applied
   * to the ranked set. Without it a child budget could be ranked first against a
   * total it is not part of, and its share could exceed 1 — which `shareFact`
   * refuses outright rather than clamping.
   */
  const present = new Set(monthly.map((s) => s.budget.categoryId));
  const counted = monthly.filter((s) => !s.ancestorCategoryIds.some((id) => present.has(id)));
  if (counted.length < MIN_BUDGETS_TO_COMPARE) return null;

  const totalCents = totalBudgetedCents(monthly);
  if (totalCents <= 0) return null;

  /*
   * Ties broken by the category path so the rank is stable across renders — two
   * budgets set to the same amount must not swap places between page loads and
   * make one of them "the largest" only sometimes.
   *
   * ⚠️ Redundant TODAY and kept anyway, measured rather than assumed:
   * `budgetStatuses` already ends its own sort with the same path comparison
   * and JS sort is stable, so deleting this changes no output and breaks no
   * test. It stays because the guarantee would otherwise be INHERITED from an
   * ordering that exists for the PAGE's benefit and has no reason to keep
   * breaking ties this way — and the failure would be a rank that flickers
   * between renders with every test still green.
   */
  const ranked = [...counted].sort(
    (a, b) => b.budget.amountCents - a.budget.amountCents || a.categoryPath.localeCompare(b.categoryPath),
  );
  const top: BudgetStatus = ranked[0]!;
  const planCents = top.budget.amountCents;
  if (planCents <= 0) return null;
  /*
   * A subject this app cannot NAME is one it cannot write a sentence about, and
   * `insight-facts` refuses `< > { } \` in a label by THROWING — so without this
   * the page renders its error boundary. See `lib/printable-name`: the write
   * boundaries refuse such a name, but a bank prints what it prints and a row
   * already in the table predates any guard. Silence is not a weakness; a page
   * that will not render is.
   */
  if (!isPrintableName(top.categoryPath)) return null;

  const prove = () => provenanceFor(db, { kind: "budgetPlan", id: top.budget.id, label: top.categoryPath });

  const facts: Fact[] = [
    /*
     * ⛔ The basis lives in `amongLabel`, so the grammar renders it INSIDE the
     * sentence. "Housing is the largest of your 12 monthly budgets" beside a
     * page that also holds daily and annual ones would be true of the fact and
     * wrong to a reader — the same correction `recurring-insights` made after a
     * yearly rank printed onto a page of monthly figures.
     */
    rankFact("f1", top.categoryPath, 1, ranked.length, "monthly budgets, by what you planned to spend"),
    scalarFact("f2", top.categoryPath, planCents, "money"),
  ];

  const candidates: InsightCandidate[] = [
    // always rank 1 by construction, so the ranked_in_set branch is unreachable
    // here and is not offered — the gate would accept it and say the same thing
    { claimId: "largest_in_set", a: "f1", b: "f2", prove },
  ];

  /*
   * ⛔ Guarded, not assumed. Every counted plan is a term of `totalCents` and
   * `budgetInputSchema` requires a positive amount, so the largest cannot exceed
   * the sum — but the column is a bare `integer notNull` with no CHECK, and
   * `shareFact` REFUSES a share outside 0–1 rather than clamping it. A single
   * non-positive amount written around the schema would therefore turn this into
   * a throw inside a server component, which is a 500 on his budgets page rather
   * than a missing sentence. Same guard `recurring-insights` writes for the same
   * reason: the throw would be the second place it was caught, not the first.
   */
  if (planCents <= totalCents) {
    facts.push(shareFact("f3", top.categoryPath, planCents / totalCents, "everything you have budgeted for a month"));
    candidates.push({
      claimId: planCents / totalCents > 0.5 ? "more_than_half" : "share_of_whole",
      a: "f3",
      prove,
    });
  }

  const excluded = monthly.length - counted.length;
  const overlap =
    excluded > 0
      ? ` ${excluded} ${excluded === 1 ? "budget sits" : "budgets sit"} inside another budgeted category and ${excluded === 1 ? "is" : "are"} counted in neither.`
      : "";

  return runInsights(facts, candidates, {
    label: "your monthly plan",
    /*
     * The denominator is the one thing a reader cannot check from the sentence,
     * so it is counted here rather than described — a phrase like "all your
     * budgets" would stop being true the first time a weekly one is added.
     */
    note: `Ranked against the ${counted.length} monthly budgets — the set this page sizes against your income. A plan is a decision, so none of these are checked against a document.${overlap}`,
  });
}
