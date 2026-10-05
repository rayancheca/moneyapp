import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { dayWindowLabel } from "@/lib/period";
import { isPrintableName } from "@/lib/printable-name";
import { rankFact, scalarFact, shareFact, type Fact } from "@/lib/insight-facts";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isHisExpenseRow, loadCategoryIndex, spendingTransactions } from "./analytics";
import { surfaceInsights, type InsightInput } from "./insight-surface";
import type { InsightCandidate, SurfaceInsights } from "./insights";
import { merchantIntelligence, merchantSummary } from "./merchants";
import { provenanceFor } from "./provenance";

/**
 * What `/merchants/[id]` can say that the page does not already show.
 *
 * ⛔ Read `lib/insight-grammar.ts` first — and then read this, because the first
 * version of this file was WRONG in a way no gate would have caught.
 *
 * It stated the visit count, the total and the median ticket. Every one of
 * those is already a figure on this page: `MerchantProfileCards` renders
 * `visitCount`, `totalCents`, `medianTicketCents` and the category mix. A strip
 * restating them says the same thing twice in two voices, which is precisely
 * what `RESERVED_NOTE_PHRASES` exists to prevent on the pages that have it.
 *
 * ⚠️ And one of the restatements was actively misleading. `merchantProfile`
 * counts a visit as an EXPENSE-KIND OUTFLOW, so Zelle — 140 rows on this
 * ledger, nearly all of them transfers — produced "2 visits" beside a page
 * header reading "140 transactions", with nothing on screen reconciling the
 * two. A true sentence can still mislead when it sits next to a different true
 * sentence about a different set of rows.
 *
 * So this module states only RELATIONSHIPS the cards cannot: where this
 * merchant sits among all of them, and how much of a category it accounts for.
 * The page owns the merchant's own figures; this owns its place among the rest.
 */

/**
 * A merchant needs more than one visit before anything here is worth saying.
 *
 * ⛔ Not only for the rank. A one-visit merchant's first and last day are the
 * SAME day, so its share of a category is a share of whatever that category
 * held on one afternoon — "Highest Standards is 100.0% of what you spend on
 * Shopping" was measured, arithmetically correct, and read as a claim about his
 * whole shopping habit. 65% of this ledger's merchants have exactly one visit,
 * so this gate is the common case and the strip is usually absent, which is the
 * honest state rather than a missing feature.
 */
const MIN_VISITS = 2;

export function merchantInsights(
  db: AppDatabase,
  merchantId: string,
  today: string = todayIso(),
): SurfaceInsights | null {
  return surfaceInsights(db, "merchant", merchantInsightInput(db, merchantId, today));
}

/** What the page measured, before the kill switch and before any proof. */
export function merchantInsightInput(
  db: AppDatabase,
  merchantId: string,
  today: string = todayIso(),
): InsightInput | null {
  const summary = merchantSummary(db, merchantId);
  const { profile } = merchantIntelligence(db, merchantId, today);
  // no spending ever recorded here — nothing measured to say, which is not the
  // same as something being wrong
  if (profile.visitCount === 0 || profile.firstSeen === null || profile.lastSeen === null) return null;
  /*
   * ⛔ A merchant this app cannot NAME is one it cannot write a sentence about.
   *
   * `claude-categorize` wrote a merchant called `<UNKNOWN>` with four real rows
   * behind it, and this page rendered the error boundary rather than a page:
   * every sentence here puts `summary.name` in a fact's subject, and a subject
   * carrying `{ }` could be re-read as a slot by the READ gate, so
   * `insight-facts` refuses it — correctly, and by throwing.
   *
   * The write boundaries now refuse such a name (`renameMerchant`, and the
   * model's own output in `claude-categorize`), but a guard added today cannot
   * un-write a row already in the table, and a bank is free to print anything.
   * So the honest behaviour is the one every other empty case here already has:
   * say nothing. Silence is not a weakness; a page that will not render is.
   */
  if (!isPrintableName(summary.name)) return null;

  const facts: Fact[] = [];
  const candidates: InsightCandidate[] = [];
  const prove = () =>
    provenanceFor(db, {
      kind: "merchantSpend",
      merchantId,
      from: profile.firstSeen!,
      to: profile.lastSeen!,
    });

  /*
   * Where this merchant sits among all of them, by money.
   *
   * Ranked over merchants with at least two visits: a one-visit merchant is a
   * place he went once, and 65% of this ledger's merchants are that. Including
   * them would make "the 40th largest of your 412 merchants" a statement mostly
   * about how many one-off shops a four-year ledger accumulates.
   */
  if (profile.visitCount < MIN_VISITS) return null;

  const totals = merchantSpendTotals(db);
  const rank = totals.findIndex((t) => t.merchantId === merchantId) + 1;
  if (rank > 0 && totals.length >= 2) {
    facts.push(rankFact("f1", summary.name, rank, totals.length, "regular merchants"));
    facts.push(scalarFact("f2", summary.name, profile.totalCents, "money"));
    candidates.push({
      // one rank claim, chosen here: both are true of a rank of 1 and printing
      // both would say the same thing twice
      claimId: rank === 1 ? "largest_in_set" : "ranked_in_set",
      a: "f1",
      b: "f2",
      prove,
    });
  }

  /*
   * How much of a category this one merchant accounts for.
   *
   * ⛔ NOT the category mix the page already draws. That answers "what is MTA
   * made of" (Transport is 64% of MTA); this answers "how much of Transport is
   * MTA" — the same two numbers arranged into the other question, and the one
   * a reader cannot get by looking.
   */
  const dominant = dominantCategory(db, merchantId);
  if (dominant) {
    /*
     * ⛔ THE PART AND THE WHOLE COME OFF ONE ROW LIST. `spendingTransactions`
     * is the same list `categorySpending` sums and the same list the
     * drill-down shows, so the merchant's share and the category's total
     * cannot be measured under two different rules.
     *
     * 🔴 They were. The whole came from `categorySpending`, which NETS refunds
     * — the comment here said so — and the part came from `dominantCategory`,
     * which counts outflows ONLY. Measured on the owner's ledger 2026-09-10:
     * `Best Buy` charged $3,758.43 and refunded $3,540.71 of it, so it cost
     * $217.72 and read "Best Buy is 21.3% of what you spent on Shopping over
     * Dec 5, 2022 – Jul 24, 2026" — of a Shopping total the app itself nets to
     * $17,611.10, in which Best Buy is 1.2%. Nine of the 66 pages carrying this
     * sentence moved, `Steam` 76.0% → 59.0% and `Uniqlo` 6.2% → 3.3%.
     *
     * ⛔ And the mix SILENCED a true one. A gross part can exceed a net whole,
     * which the guard below reads as impossible: `DraftKings` charged $1,294.30
     * against a Gambling total of $831.11 and got no sentence at all. Net, it
     * is $794.30 of $831.11 and can finally be said.
     *
     * `dominantCategory` still chooses WHICH category — "where this merchant
     * charges most" is a selector, not a measurement — and only the share is
     * taken from these rows.
     */
    const inCategory = spendingTransactions(db, {
      categoryId: dominant.categoryId,
      from: profile.firstSeen,
      to: profile.lastSeen,
    });
    const categoryTotal = inCategory.reduce((sum, t) => sum - t.amountCents, 0);
    const merchantCents = inCategory.reduce(
      (sum, t) => (t.merchantId === merchantId ? sum - t.amountCents : sum),
      0,
    );
    /*
     * A share needs a whole strictly larger than its part. Both sides net
     * refunds, so a category — or a merchant — that net-refunded over this
     * window comes back zero or negative, and `shareFact` refuses a value
     * outside 0–1 rather than clamping. Checked here instead of thrown there.
     */
    if (categoryTotal > 0 && merchantCents > 0 && merchantCents <= categoryTotal) {
      /*
       * The window is IN the frame, not implied by the page. A merchant's span
       * is its own, not the ledger's, so "of what you spent on Transport" with
       * no dates would be read as all time on a merchant that ran for a month.
       */
      /*
       * 🔴 …AND THE WINDOW IS THE ONE MEASURED, TO THE DAY. This collapsed a
       * span to a MONTH whenever both ends fell inside one, so a share taken
       * over a single day was captioned with the month around it: "Empire City
       * Entertainment Bar is 100.0% of what you spent on Entertainment in Feb
       * 2026" is one purchase on Feb 7, and of February it is 1.6%. Measured
       * 2026-09-10 — of the 66 merchant pages carrying this sentence, 28
       * collapsed a single day and 44 overstated the month's share by 2× or
       * more, the worst of them by 64×. `dayWindowLabel` is the app's rule for
       * naming a window by its own ends and it drops only what repeats.
       */
      const label = dayWindowLabel(profile.firstSeen, profile.lastSeen);
      const span = profile.firstSeen === profile.lastSeen ? `on ${label}` : `over ${label}`;
      facts.push(shareFact("f3", summary.name, merchantCents / categoryTotal, `what you spent on ${dominant.name} ${span}`));
      candidates.push({ claimId: "share_of_whole", a: "f3", prove });
    }
  }

  return {
    facts,
    candidates,
    window: {
      /* the strip's own caption, from the same rule — it read
         "Feb 2026 – Feb 2026" over a merchant seen on one day, three lines
         under a Seen row already printing 2026-02-07 twice */
      label: dayWindowLabel(profile.firstSeen, profile.lastSeen),
      note: null,
    },
  };
}

interface MerchantTotal {
  merchantId: string;
  cents: number;
}

/**
 * Every regular merchant's expense-kind outflow, largest first.
 *
 * One aggregate rather than `merchantIntelligence` per merchant: this runs on
 * every merchant page and the profile builder walks a merchant's whole history.
 * The filter matches the profile's own — outflows in expense-kind categories —
 * so a rank and the total it is printed beside cannot come from different rows.
 */
function merchantSpendTotals(db: AppDatabase): MerchantTotal[] {
  /*
   * The expense-kind rollup is resolved in TS for the reason
   * `merchantIntelligence` gives: `loadCategoryIndex` is the one place that
   * rollup is implemented, and a self-join would be a second implementation of
   * it. One pass over the active rows does both the sum and the visit count, so
   * a merchant cannot clear the visit gate on one set of rows and be ranked on
   * another.
   */
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const byMerchant = new Map<string, { cents: number; gross: number; visits: number }>();
  for (const row of db
    .select({
      accountId: transactions.accountId,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(eq(transactions.status, "active"))
    .all()) {
    if (row.merchantId === null) continue;
    // ⚖️ the profile's own filter: his expense rows, none on the agent's cash (`isHisExpenseRow`, owner decision 2026-10-02)
    if (!isHisExpenseRow(idx, agentsCash, row)) continue;
    const acc = byMerchant.get(row.merchantId) ?? { cents: 0, gross: 0, visits: 0 };
    /*
     * ⛔ THE RANK IS BY WHAT IT COST, and the credits are the other half of
     * that. Owner's decision 2026-09-10, on the measurement: ranked by charges
     * alone, `Best Buy` was the LARGEST of 250 on $3,758.43 of which $3,540.71
     * went back — it cost $217.72 and ranks 55th — and `Apple Store` sat 15th
     * on $1,248.80 charged and $0.00 net, every purchase returned.
     *
     * ⚠️ MEMBERSHIP is unchanged: a regular merchant is one with `MIN_VISITS`
     * purchases, counted here exactly as `merchantProfile` counts them, so the
     * set the sentence names ("your 250 regular merchants") does not move under
     * a merchant's refunds. Only the ORDER and the figure do. `gross` carries
     * that gate; `cents` is what it cost.
     */
    acc.cents -= row.amountCents;
    if (row.amountCents < 0) {
      acc.gross -= row.amountCents;
      acc.visits += 1;
    }
    byMerchant.set(row.merchantId, acc);
  }
  return [...byMerchant.entries()]
    .filter(([, v]) => v.visits >= MIN_VISITS && v.gross > 0)
    .map(([merchantId, v]) => ({ merchantId, cents: v.cents }))
    .sort((a, b) => b.cents - a.cents || a.merchantId.localeCompare(b.merchantId));
}

/** The top-level category most of this merchant's spending sits in, with its cents. */
function dominantCategory(
  db: AppDatabase,
  merchantId: string,
): { categoryId: string; name: string; cents: number } | null {
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const byTop = new Map<string, number>();
  for (const row of db
    .select({
      accountId: transactions.accountId,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "active")))
    .all()) {
    if (row.amountCents >= 0) continue;
    // where HIS spending at this merchant sits — the agent's cash is none of it (owner decision 2026-10-02)
    if (!isHisExpenseRow(idx, agentsCash, row)) continue;
    const top = idx.topLevelOf(row.categoryId!);
    byTop.set(top.id, (byTop.get(top.id) ?? 0) - row.amountCents);
  }
  const best = [...byTop.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!best) return null;
  return { categoryId: best[0], name: idx.byId.get(best[0])!.name, cents: best[1] };
}
