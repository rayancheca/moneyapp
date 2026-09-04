import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { countFact, rankFact, scalarFact, shareFact, type Fact } from "@/lib/insight-facts";
import { isPrintableName } from "@/lib/printable-name";
import { sideMagnitudeCents } from "@/lib/side-magnitude";
import { listAccounts } from "./accounts";
import { surfaceInsights, type InsightInput } from "./insight-surface";
import type { InsightCandidate, SurfaceInsights } from "./insights";
import { provenanceFor } from "./provenance";

/**
 * What `/accounts/[id]` can say that its own numbers do not.
 *
 * ⛔ Read `lib/insight-grammar.ts` first, and `merchant-insights.ts` second —
 * that module's mistake was restating figures the page already printed, and the
 * same trap is right here. This page shows the balance, the chart, the anchors
 * and the recent rows. What it does NOT show is where this account sits among
 * the others, or how much of what he owns it is.
 *
 * ## ⛔ Assets and liabilities are ranked apart
 *
 * A card's balance is negative and a savings account's is positive, so one
 * ranking over both would sort a $5,000 debt below a $0 chequing account and
 * call it "the smallest". They are two questions — "how much do I have here"
 * and "how much do I owe here" — and the sentence names which set it ranked in,
 * so a reader is never left guessing.
 *
 * ## What a share is a share OF
 *
 * An asset's share is of total ASSETS, never of net worth. Net worth is assets
 * minus liabilities and can be small or negative while an account is large;
 * dividing by it produces shares over 100% and, below zero, shares with the
 * wrong sign. `shareFact` refuses a value outside 0–1 rather than clamping, so
 * that mistake would throw rather than render — but it is stated here because
 * the throw would be the SECOND place it was caught.
 */

/** Below two accounts on a side, a rank is not a ranking. */
const MIN_ACCOUNTS_TO_RANK = 2;

export function accountInsights(
  db: AppDatabase,
  accountId: string,
  today: string = todayIso(),
): SurfaceInsights | null {
  return surfaceInsights(db, "account", accountInsightInput(db, accountId, today));
}

/** What the page measured, before the kill switch and before any proof. */
export function accountInsightInput(
  db: AppDatabase,
  accountId: string,
  today: string = todayIso(),
): InsightInput | null {
  /*
   * ⛔ An account with NO balance at all is not an account holding zero.
   * `Capital One 360 Checking` on the real ledger is exactly that: zero rows
   * and zero `daily_balances`, which `listAccounts` reports as `balance: null`.
   * Reading it as $0 would rank it last among his accounts, state a figure
   * nobody measured, and add one to every other account's denominator. Empty is
   * not zero — the distinction that has now bitten four services here.
   *
   * ⚠️ `balanceCents` is typed `number | null` and the column is NOT NULL, so
   * the second half of this narrowing can never fire on real data. It is kept
   * because the TYPE permits it and a future basis might: what it must never do
   * is silently become a zero.
   */
  const all = listAccounts(db).filter(
    (a): a is typeof a & { balance: { balanceCents: number; asOf: string | null } } =>
      a.isActive && a.balance !== null && a.balance.balanceCents !== null,
  );
  const self = all.find((a) => a.id === accountId);
  if (!self) return null;
  /*
   * A subject this app cannot NAME is one it cannot write a sentence about, and
   * `insight-facts` refuses `< > { } \` in a label by THROWING — so without this
   * the page renders its error boundary. See `lib/printable-name`: the write
   * boundaries refuse such a name, but a bank prints what it prints and a row
   * already in the table predates any guard. Silence is not a weakness; a page
   * that will not render is.
   */
  if (!isPrintableName(self.name)) return null;

  const side = all.filter((a) => a.isLiability === self.isLiability);
  const sideLabel = self.isLiability ? "cards and loans" : "accounts holding money";

  /*
   * A liability's balance is stored negative, so both sides are ranked by
   * MAGNITUDE — largest debt first, largest balance first. Ranking a liability
   * by its signed value would put the biggest debt last and call it smallest.
   */
  /*
   * 🔴 …and by what the side MEANS, not by absolute value. A card in credit is
   * a liability-type account with a positive balance: it owes nothing, and the
   * bank owes it. `Math.abs` counted Chase Sapphire's $82.72 credit as $82.72
   * OWED — /accounts/<Discover> read "55.3% of everything you owe" on
   * 2026-09-03, a share of $1,008.33 when the two cards actually owed $925.61
   * between them (60.2%, the cards card's own slice). Held is the positive part
   * of an asset-side balance, owed the negative part of a liability-side one;
   * an account on the wrong side of its sign is ranked at zero and gets no
   * share, the same refusal a zero balance gets below.
   *
   * ⛔ The rule lives in `lib/side-magnitude` because it shipped fixed HERE and
   * broken in the `/accounts` table on the same day — 60.2% on one page, 55.3%
   * on the other, of one debt.
   */
  const sideAmount = (a: (typeof all)[number]): number =>
    sideMagnitudeCents(a.balance.balanceCents, self.isLiability);
  const ranked = [...side].sort((a, b) => sideAmount(b) - sideAmount(a) || a.name.localeCompare(b.name));
  const rank = ranked.findIndex((a) => a.id === accountId) + 1;
  const magnitude = sideAmount(self);

  const facts: Fact[] = [];
  const candidates: InsightCandidate[] = [];
  const prove = () => provenanceFor(db, { kind: "accountBalance", accountId, day: self.balance.asOf ?? undefined });

  if (rank > 0 && ranked.length >= MIN_ACCOUNTS_TO_RANK && magnitude > 0) {
    facts.push(rankFact("f1", self.name, rank, ranked.length, sideLabel));
    facts.push(scalarFact("f2", self.name, magnitude, "money"));
    // one rank claim: both are true of a rank of 1, and printing both would say
    // the same thing twice
    candidates.push({ claimId: rank === 1 ? "largest_in_set" : "ranked_in_set", a: "f1", b: "f2", prove });
  }

  /*
   * Its share of the side it belongs to. Assets over assets, debts over debts —
   * never over net worth, which is a difference and not a whole.
   */
  const sideTotal = side.reduce((sum, a) => sum + sideAmount(a), 0);
  if (sideTotal > 0 && magnitude > 0 && magnitude <= sideTotal) {
    facts.push(
      shareFact("f3", self.name, magnitude / sideTotal, self.isLiability ? "everything you owe" : "everything you hold"),
    );
    candidates.push({ claimId: "share_of_whole", a: "f3", prove });
  }

  /*
   * How much of the ledger this account is, by rows. A big balance on an
   * account with four rows a year is a different object from a small balance on
   * the one everything goes through, and no figure on this page separates them.
   */
  const rowCount = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.status, "active")))
    .all().length;
  if (rowCount > 0) {
    facts.push(countFact("f4", self.name, rowCount, "transaction"));
    candidates.push({ claimId: "count_in_subject", a: "f4", prove });
  }

  return {
    facts,
    candidates,
    window: {
      label: self.balance.asOf ? `as of ${formatDayLong(self.balance.asOf)}` : self.name,
      note: null,
    },
  };
}
