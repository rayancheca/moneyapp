import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../src/db/client";
import type { ImportInput } from "../src/services/import/service";

/**
 * Seeded-base machinery for the e2e harness (ux-overhaul-plan §2.7).
 *
 * Fixture split:
 * - SET A (seeded by global-setup before any spec runs): chase, discover,
 *   sofi, robinhood — structured downloads + statement PDFs. Visual/a11y/
 *   interaction specs render against this populated, un-mutated base.
 * - SET B (reserved): capital-one + discover/corrupted — uploaded through
 *   the real browser UI by zz-golden-path.spec.ts, whose assertions rely on
 *   these accounts and periods NOT pre-existing.
 *
 * App modules are imported dynamically so env (db path, fake clock/prices)
 * is set before any of them evaluates; imports are RELATIVE because this
 * file runs under Playwright's transpiler, not the Next bundler.
 */

/**
 * Pinned "today" for the whole harness: inside the fixture window
 * (2024-07-01 → 2026-07-05 per manifest.json) so "this month" and
 * "last 30 days" surfaces contain fixture transactions, and 3 days past the
 * last posting so "upcoming"/pace surfaces have something imminent. Also the
 * repo's canonical test date (dates.test.ts, demo recurring detection).
 */
export const E2E_FAKE_TODAY = "2026-07-08";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "synthetic");

/**
 * zz-golden-path uploads the CORRUPTED 2024-11-15 → 2024-12-14 Discover
 * statement; the fixture generator built that month so the PDF is the
 * period's ONLY source. Its clean twin must stay out of set A, or
 * duplicate-period adoption would reconcile the gap away.
 */
const RESERVED_FOR_GOLDEN_PATH = new Set(["discover-card-2024-11-15_2024-12-14.pdf"]);

const SET_A_DIRS: readonly (readonly string[])[] = [
  ["chase"],
  ["chase", "statements"],
  ["discover"],
  ["discover", "statements"],
  ["sofi"],
  ["sofi", "statements"],
  ["robinhood"],
  ["robinhood", "statements"],
];

function loadDir(...rel: string[]): ImportInput[] {
  const dir = path.join(FIXTURES, ...rel);
  return fs
    .readdirSync(dir)
    .filter((f) => !RESERVED_FOR_GOLDEN_PATH.has(f) && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: f, buffer: fs.readFileSync(path.join(dir, f)) }));
}

export interface SeedSummary {
  files: number;
  txns: number;
  coveragePct: number;
  gapPeriods: number;
  reviewBacklog: number;
}

/** Per-cluster and per-run caps — keep the seeded backlog small and its nav
 * badge a moderate, stable number so baselines don't churn on the count. */
const CLUSTER_CAP = 6;
const MERCHANT_CLUSTERS = 3;

interface FlagRow {
  id: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  accountName: string;
}

/**
 * Content order (newest first), IDENTICAL to reviewInbox's row orderBy
 * (postedOn desc, amount desc, rawDescription desc, accountName asc, id desc) so
 * the seed flags exactly the rows the inbox surfaces first. accountName precedes
 * the id fallback because per-seed uuidv7 ids can shuffle otherwise-tied rows
 * across accounts; id only separates byte-identical rows, which render the same.
 */
function newestFirst(a: FlagRow, b: FlagRow): number {
  return (
    b.postedOn.localeCompare(a.postedOn) ||
    b.amountCents - a.amountCents ||
    b.rawDescription.localeCompare(a.rawDescription) ||
    a.accountName.localeCompare(b.accountName) ||
    b.id.localeCompare(a.id)
  );
}

/**
 * Seeds a deterministic, clustered review backlog (ux-overhaul-plan §3.3): the
 * synthetic import categorizes too cleanly to leave a needsReview queue, so the
 * inbox would render empty and its drain gate couldn't run. Flags the newest
 * rows of the busiest few merchants (→ "Confirm all" clusters) plus one
 * uncategorized stripped-key group (→ "Categorize all"), all selected by
 * content so the flagged set — and every baseline over it — is stable.
 */
export async function seedReviewBacklog(db: AppDatabase): Promise<number> {
  const { transactions } = await import("../src/db/schema/transactions");
  const { merchants } = await import("../src/db/schema/merchants");
  const { accounts } = await import("../src/db/schema/accounts");
  const { eq, inArray } = await import("drizzle-orm");
  const { strippedDescriptionKey } = await import("../src/lib/description-key");

  const active = db
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      categoryId: transactions.categoryId,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      canonicalName: merchants.canonicalName,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(eq(transactions.status, "active"))
    .all();

  const flagIds: string[] = [];

  // 1) busiest categorized merchants → "Confirm all" clusters
  const byMerchant = new Map<string, { name: string; rows: FlagRow[] }>();
  for (const r of active) {
    if (!r.merchantId || r.categoryId === null) continue;
    const group = byMerchant.get(r.merchantId) ?? { name: r.canonicalName ?? "", rows: [] };
    group.rows.push(r);
    byMerchant.set(r.merchantId, group);
  }
  const rankedMerchants = [...byMerchant.values()]
    .filter((g) => g.rows.length >= 3)
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name))
    .slice(0, MERCHANT_CLUSTERS);
  for (const group of rankedMerchants) {
    flagIds.push(...[...group.rows].sort(newestFirst).slice(0, CLUSTER_CAP).map((r) => r.id));
  }

  // 2) one uncategorized merchantless stripped-key group → "Categorize all"
  const byKey = new Map<string, FlagRow[]>();
  for (const r of active) {
    if (r.merchantId || r.categoryId !== null) continue;
    const key = strippedDescriptionKey(r.normalizedDescription);
    if (key === "") continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(r);
    byKey.set(key, bucket);
  }
  const bestKey = [...byKey.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (bestKey) {
    flagIds.push(...[...bestKey[1]].sort(newestFirst).slice(0, CLUSTER_CAP).map((r) => r.id));
  }

  for (let i = 0; i < flagIds.length; i += 500) {
    db.update(transactions)
      .set({ needsReview: true })
      .where(inArray(transactions.id, flagIds.slice(i, i + 500)))
      .run();
  }
  return flagIds.length;
}

/**
 * Deterministic investment fixture for the §6 Investments surfaces. The synthetic
 * brokerage is value-anchored (no per-symbol holdings or events), so the holdings
 * table / allocation / movers / holding pages would render blank. This seeds a
 * fully controlled, position-based portfolio:
 *   - three equities that rise over the window (gains), with a last-day move
 *     shaped per symbol so movers has a winner AND losers, and
 *   - an ETH crypto position that rises over the window but dips the last 30 days
 *     — so the portfolio's ALL range is a gain (green accent) while 1M is a loss
 *     (red accent), giving both accent-state baselines from one seed.
 *
 * Those two shapes are TRENDS. The close actually stored is the trend times
 * `priceWobble`, a seeded function of (symbol, day index) — so the series is
 * reproducible to the cent across runs while looking like a price rather than a
 * ruled line. Determinism is the property the baselines need; straightness never
 * was, and buying the former with the latter cost every investment chart its
 * credibility (and its ability to witness a renderer bug).
 */
interface SeedSecurity {
  symbol: string;
  assetType: "stock" | "etf" | "crypto";
  startPrice: number;
  peakPrice: number;
  /** override the final day's close vs the prior day, cents (movers direction) */
  lastDayDeltaCents: number;
  /** dip the last 30 days from peak to this price (crypto weekend/loss shape) */
  dipToPrice: number | null;
  qtyE8: number;
  openingE8: number;
  avgCostCents: number;
}

const SEED_SECURITIES: readonly SeedSecurity[] = [
  { symbol: "AAPL", assetType: "stock", startPrice: 120, peakPrice: 235, lastDayDeltaCents: 340, dipToPrice: null, qtyE8: 30_00000000, openingE8: 20_00000000, avgCostCents: 15000 },
  { symbol: "MSFT", assetType: "stock", startPrice: 300, peakPrice: 415, lastDayDeltaCents: -520, dipToPrice: null, qtyE8: 45_00000000, openingE8: 30_00000000, avgCostCents: 34000 },
  { symbol: "WMT", assetType: "etf", startPrice: 60, peakPrice: 96, lastDayDeltaCents: 0, dipToPrice: null, qtyE8: 120_00000000, openingE8: 90_00000000, avgCostCents: 7000 },
  { symbol: "ETH", assetType: "crypto", startPrice: 1000, peakPrice: 3000, lastDayDeltaCents: -0, dipToPrice: 2300, qtyE8: 8_00000000, openingE8: 5_00000000, avgCostCents: 137500 },
];

export async function seedInvestments(db: AppDatabase, today: string): Promise<void> {
  const { accounts } = await import("../src/db/schema/accounts");
  const { institutions } = await import("../src/db/schema/institutions");
  const { holdings, priceCache } = await import("../src/db/schema/holdings");
  const { holdingEvents } = await import("../src/db/schema/holding-events");
  const { createAccount } = await import("../src/services/accounts");
  const { rebuildInvestmentHistory } = await import("../src/services/crypto-history");
  const { priceWobble } = await import("../src/lib/fake-prices");
  const { addDays, compareDates } = await import("../src/lib/dates");
  const { and, eq } = await import("drizzle-orm");

  const firstDay = "2024-07-01";
  const totalDays = dayCount(firstDay, today, addDays, compareDates); // exclusive of today
  const dipStart = addDays(today, -30);
  const mid = addDays(firstDay, Math.floor(totalDays / 2));

  const brokerage = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.type, "investment"), eq(accounts.subtype, "brokerage")))
    .get();
  const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get();
  if (!brokerage || !robinhood) return;

  const cryptoId = createAccount(db, {
    institutionId: robinhood.id,
    name: "Robinhood Crypto",
    type: "investment",
    subtype: "crypto",
  });

  // fresh, controlled positions replace any (empty) synthetic ones
  db.delete(holdings).where(eq(holdings.accountId, brokerage.id)).run();

  for (const s of SEED_SECURITIES) {
    const accountId = s.assetType === "crypto" ? cryptoId : brokerage.id;
    const source = s.assetType === "crypto" ? ("coinbase" as const) : ("yahoo" as const);

    // build a deterministic close series: a rise to the peak, an optional 30-day
    // dip, and a fixed last-day delta to set the day-change direction.
    //
    // The rise and the dip are TRENDS, not the series: each close is the trend
    // times `priceWobble`, so the line has the texture of a price. Drawn from the
    // trend alone it was literally straight — AAPL's holding page was a ruler-
    // ruled diagonal across two years — which is not just ugly. A sparkline that
    // renders as a segment is exactly what a collapsed-series renderer bug looks
    // like, so 40-odd baselines were blind to the failure they exist to catch.
    const closes: { quotedOn: string; close: number }[] = [];
    const riseDays = Math.max(1, dayCount(firstDay, s.dipToPrice !== null ? dipStart : today, addDays, compareDates));
    let i = 0;
    let prevClose = s.startPrice;
    for (let day = firstDay; compareDates(day, today) <= 0; day = addDays(day, 1)) {
      let close: number;
      if (s.dipToPrice !== null && compareDates(day, dipStart) >= 0) {
        const j = dayCount(dipStart, day, addDays, compareDates);
        close = s.peakPrice - (s.peakPrice - s.dipToPrice) * (j / 30);
      } else {
        close = s.startPrice + (s.peakPrice - s.startPrice) * (i / riseDays);
      }
      close *= priceWobble(s.symbol, i);
      // pinned LAST so the day change stays exactly `lastDayDeltaCents × qty` —
      // the movers direction and the teaser's headline move are contract, and
      // they must not inherit a cent of the wobble
      if (day === today) close = prevClose + s.lastDayDeltaCents / 100;
      const rounded = Math.round(close * 100) / 100;
      closes.push({ quotedOn: day, close: rounded });
      prevClose = rounded;
      i += 1;
    }
    for (let k = 0; k < closes.length; k += 400) {
      db.insert(priceCache)
        .values(
          closes.slice(k, k + 400).map((c) => ({
            symbol: s.symbol,
            assetType: s.assetType,
            quotedOn: c.quotedOn,
            close: c.close,
            source,
            fetchedAt: `${c.quotedOn}T20:00:00.000Z`,
          })),
        )
        .run();
    }

    db.insert(holdingEvents)
      .values([
        { accountId, symbol: s.symbol, assetType: s.assetType, occurredOn: firstDay, quantityDeltaE8: s.openingE8, costCents: Math.round((s.avgCostCents * s.openingE8) / 1e8) },
        { accountId, symbol: s.symbol, assetType: s.assetType, occurredOn: mid, quantityDeltaE8: s.qtyE8 - s.openingE8, costCents: Math.round((s.avgCostCents * (s.qtyE8 - s.openingE8)) / 1e8) },
      ])
      .run();
    db.insert(holdings)
      .values({ accountId, symbol: s.symbol, assetType: s.assetType, quantityE8: s.qtyE8, avgCostCents: s.avgCostCents, isActive: true })
      .run();
  }

  rebuildInvestmentHistory(db, brokerage.id, today);
  rebuildInvestmentHistory(db, cryptoId, today);
}

/**
 * Deterministic recurring series for the §7 dashboard teasers (upcoming-bills
 * strip, "before your next paycheck", spending pace's fixed components) and a
 * live /recurring/[id] drill target. Detection is NOT run in the seed (it would
 * tag fixture transactions and churn the transactions/spending baselines), so we
 * insert a small, fixed set of series with NO linked rows — every date is
 * relative to E2E_FAKE_TODAY (2026-07-08), so the strip, the paycheck line, and
 * the forecast are identical every run. Income precedes the paycheck-adjacent
 * bill so "$X due before your next paycheck" resolves to exactly Rent.
 */
async function seedRecurring(db: AppDatabase): Promise<void> {
  const { recurringSeries } = await import("../src/db/schema/recurring");
  const rows = [
    /*
     * ⚠️ $2,943.19, which is what the ACME deposits in the corpus actually are.
     * It was $3,200.00 while nothing was linked to this series, and §9 links the
     * deposits so `incomeCard` has evidence — at which point a round number
     * nobody was ever paid became a $256.81 "drift" on every payday, and three
     * near-identical notices crowded the notices card. A schedule should agree
     * with its own evidence.
     */
    { name: "Paycheck", kind: "income" as const, cadence: "biweekly" as const, nextExpectedOn: "2026-07-10", nextExpectedAmountCents: 2_943_19, lastMatchedOn: "2026-06-26", intervalDaysAvg: 14 },
    { name: "Rent", kind: "bill" as const, cadence: "monthly" as const, nextExpectedOn: "2026-07-09", nextExpectedAmountCents: -1_800_00, lastMatchedOn: "2026-06-09", intervalDaysAvg: 30 },
    { name: "Netflix", kind: "subscription" as const, cadence: "monthly" as const, nextExpectedOn: "2026-07-16", nextExpectedAmountCents: -15_99, lastMatchedOn: "2026-06-16", intervalDaysAvg: 30 },
    { name: "Gym Membership", kind: "subscription" as const, cadence: "monthly" as const, nextExpectedOn: "2026-07-20", nextExpectedAmountCents: -49_00, lastMatchedOn: "2026-06-20", intervalDaysAvg: 30 },
  ];
  db.insert(recurringSeries)
    .values(
      rows.map((r) => ({
        name: r.name,
        kind: r.kind,
        cadence: r.cadence,
        intervalDaysAvg: r.intervalDaysAvg,
        amountCentsAvg: r.nextExpectedAmountCents,
        nextExpectedOn: r.nextExpectedOn,
        nextExpectedAmountCents: r.nextExpectedAmountCents,
        lastMatchedOn: r.lastMatchedOn,
        status: "confirmed" as const,
      })),
    )
    .run();
}

/**
 * §9 — the three decision cards that had NO pixel coverage anywhere, and could
 * not be given any by a spec change.
 *
 * ⛔ `noticesCard`, `carCard` and `incomeCard` all returned null on this
 * fixture, so nine of the deck's ten rendering cards could be photographed and
 * these three could not: a spec can only open a card the seed produces. Measured
 * first (`scripts/probe-e2e-missing-cards.ts`) rather than guessed, because each
 * one was waiting for something different.
 *
 * ⚠️ **Not one cent moves here.** Every change below is a LINK, a column, or a
 * commitment with no posted rows. That is deliberate: a new transaction would
 * re-derive daily balances and move net worth, the bridge, runway, every account
 * chart and every spending total — dozens of baselines, to photograph three
 * cards. Income and spending are identical before and after.
 */
async function seedMissingCards(db: AppDatabase): Promise<void> {
  const { categories } = await import("../src/db/schema/categories");
  const { recurringSeries } = await import("../src/db/schema/recurring");
  const { transactions } = await import("../src/db/schema/transactions");
  const { and, eq, like } = await import("drizzle-orm");

  const seriesId = (name: string): string => {
    const row = db.select({ id: recurringSeries.id }).from(recurringSeries).where(eq(recurringSeries.name, name)).get();
    if (!row) throw new Error(`seedMissingCards: missing series ${name}`);
    return row.id;
  };

  /*
   * ── income ──────────────────────────────────────────────────────────
   *
   * `incomeCard` needs a confirmed income series with EVIDENCE: without a
   * single linked deposit there is no schedule to reconcile against, and
   * `cashEarningsReadings` returns nothing. The Paycheck series existed; nothing
   * had ever been attributed to it.
   *
   * The ACME direct deposits only, and that is the story rather than an
   * oversight: they stop on 2026-05-08 and ATM cash deposits carry the wage from
   * 2026-05-14 onwards. So the schedule keeps implying paydays the bank never
   * shows, which is exactly the gap this card exists to name — and it is the
   * owner's own ledger's shape (docs/income-ground-truth.md).
   */
  db.update(transactions)
    .set({ recurringSeriesId: seriesId("Paycheck") })
    .where(
      and(
        eq(transactions.status, "active"),
        like(transactions.normalizedDescription, "ACME CORP PAYROLL%"),
      ),
    )
    .run();

  /*
   * ── notices ─────────────────────────────────────────────────────────
   *
   * A notice needs one of three things, and two of them were unreachable here:
   * no merchant in this corpus has a single expense charge (every one has 23+),
   * and none has a charge eight times its own median. The third is a recurring
   * bill that posted at a different amount, which costs no money at all.
   *
   * Rent is expected at $1,800.00 and posts at $2,150.00 — a $350.00 gap that
   * was invisible because nothing linked the posting to the schedule and because
   * `classifyPostedAmount` returns "paid" on a null spread: a series nobody has
   * measured has no normal to depart from.
   *
   * ⚠️ The JUNE posting, not July. June's occurrence (2026-06-09) is in the past
   * at E2E_FAKE_TODAY and inside the card's 90-day window, so it can be graded;
   * July's (2026-07-09) is tomorrow and a bill that has not come due yet cannot
   * have been paid differently. Tolerance is widened to 10 days on this series
   * alone because the rent posts on the 1st and the schedule expects the 9th —
   * the same eight-day lag the real ledger has, and the reason pass 57 had to
   * separate a bill's DUE day from its POSTING day.
   */
  db.update(recurringSeries)
    .set({ amountCentsStddev: 500, toleranceDays: 10 })
    .where(eq(recurringSeries.id, seriesId("Rent")))
    .run();
  db.update(transactions)
    .set({ recurringSeriesId: seriesId("Rent") })
    .where(
      and(
        eq(transactions.status, "active"),
        eq(transactions.postedOn, "2026-06-01"),
        // ⚠️ the DAY is not the identity. Matching on the date alone linked
        // every row posted that morning to the rent schedule, and the notice
        // then read "Rent fell by $1,793.32" — the drift of somebody else's
        // charge, in rent's name.
        like(transactions.normalizedDescription, "%WESTVIEW APARTMENTS%"),
      ),
    )
    .run();

  /*
   * ── car ─────────────────────────────────────────────────────────────
   *
   * `carCard` returns null the moment there is no top-level `Car` category, and
   * a fresh ledger has none. The category is one level deep, matching the real
   * ledger's own shape.
   *
   * ⛔ `userCategoryId` is the ONLY way a series with no posted rows can reach a
   * category: membership is otherwise derived FROM postings. That is not a
   * workaround — it is the documented case the column exists for, a lease signed
   * before its first charge — and it keeps every spending total untouched.
   */
  const carId = "e2e-car-category";
  db.insert(categories)
    .values({
      id: carId,
      name: "Car",
      parentId: null,
      kind: "expense",
      sortOrder: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  db.insert(recurringSeries)
    .values([
      {
        name: "Car Lease",
        kind: "bill" as const,
        cadence: "monthly" as const,
        intervalDaysAvg: 30,
        amountCentsAvg: -450_00,
        nextExpectedOn: "2026-07-22",
        nextExpectedAmountCents: -450_00,
        lastMatchedOn: "2026-06-22",
        status: "confirmed" as const,
        userCategoryId: carId,
      },
      {
        name: "Car Insurance",
        kind: "bill" as const,
        cadence: "monthly" as const,
        intervalDaysAvg: 30,
        amountCentsAvg: -128_00,
        /*
         * ⚠️ The 26th, not the 24th. On the 24th it shared a calendar day with a
         * payday and the cell collapsed to one signed total ("2.8k Paycheck +1"),
         * which broke `recurring-schedule`'s premise that every monthly series
         * sits on its own day of month — a fixture should not manufacture the
         * collision a spec exists to rule out.
         */
        nextExpectedOn: "2026-07-26",
        nextExpectedAmountCents: -128_00,
        lastMatchedOn: "2026-06-26",
        status: "confirmed" as const,
        userCategoryId: carId,
      },
    ])
    .run();
}

/**
 * A deterministic budget set for the §8 pace bars: Food (under → green),
 * Subscriptions (off-pace → amber, WITH an expected-recurring tail), and Housing
 * (already over → red). Categories are resolved BY NAME because ids are random
 * per reseed. The tail is made non-empty by linking the seeded Netflix series to
 * ONE old (2024-07) Streaming row: that row is off the recent ledger page and
 * outside both the July and the 2026 windows, so it maps Netflix into
 * Subscriptions for the tail without touching any other tab's baseline (matched
 * counts only render on the un-baselined Recurring "all" sub-view).
 */
async function seedBudgets(db: AppDatabase): Promise<void> {
  const { createBudget, setBudgetRollover } = await import("../src/services/budgets");
  const { categories } = await import("../src/db/schema/categories");
  const { recurringSeries } = await import("../src/db/schema/recurring");
  const { transactions } = await import("../src/db/schema/transactions");
  const { accounts: accountsTable } = await import("../src/db/schema/accounts");
  const { and, asc, eq, isNull, like } = await import("drizzle-orm");

  const topLevel = (name: string): string => {
    const row = db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.name, name), isNull(categories.parentId)))
      .get();
    if (!row) throw new Error(`seedBudgets: missing category ${name}`);
    return row.id;
  };

  createBudget(db, { categoryId: topLevel("Food"), period: "monthly", amountCents: 80_000, startsOn: "2026-07-01" });
  createBudget(db, { categoryId: topLevel("Subscriptions"), period: "monthly", amountCents: 4_000, startsOn: "2026-07-01" });
  createBudget(db, { categoryId: topLevel("Housing"), period: "monthly", amountCents: 200_000, startsOn: "2026-07-01" });

  /*
   * A budget that ROLLS OVER, so the carry disclosure has a rendered path.
   *
   * Utilities is chosen because it is the only top-level expense category with
   * steady spend in both closed months and NO recurring series bound to it — so
   * its carry is pure arithmetic with no tail or overdue term muddying it, and it
   * cannot disturb the "exactly one overdue row" / "exactly one tail" assertions
   * the other tests depend on.
   *
   * Deterministic at E2E_FAKE_TODAY (2026-07-08): the closed periods are May
   * (spend $194.00) and June ($173.00) against $250.00/month, so the carry is
   * ($250.00 − $194.00) + ($250.00 − $173.00) = $133.00 and the row is graded
   * against $383.00. July is the CURRENT period and is never banked.
   */
  const utilities = createBudget(db, {
    categoryId: topLevel("Utilities"),
    period: "monthly",
    amountCents: 250_00,
    startsOn: "2026-05-01",
  });
  setBudgetRollover(db, utilities, { enabled: true });

  /*
   * A bill that came due and never posted — the only thing on this page that
   * `budgetOverdue` (budgets.ts:498) renders, and it shipped with unit tests and
   * no e2e at all, so the whole rendered path could rot silently.
   *
   * On FOOD, not Housing, for two reasons. Housing is the `over` row whose
   * verdict already speaks; Food reads "Awaiting statements", so this proves the
   * disclosure survives a row that otherwise looks benign — which is exactly the
   * failure it exists for (rent overdue while Housing sat green). And the
   * `category-*` visual baseline IS the Housing page, whose "Recurring series"
   * card would otherwise gain a row and move eight snapshots for nothing.
   *
   * `userCategoryId` is the ONLY way this can reach a budget: series→category is
   * derived from POSTED rows and this series has none — by design, since a linked
   * posting inside toleranceDays is what "paid" means. The column is an OVERRIDE,
   * never a union.
   *
   * 2026-07-05 is inside [period start, E2E_FAKE_TODAY] so it is already due, and
   * the next monthly step (2026-08-04) falls outside the dashboard's 14-day bill
   * strip — so no dashboard baseline moves. /recurring's tab counts do
   * (Upcoming 6→7, All 4→5, Calendar 5→6): unavoidable for any new series, since
   * budgetOverdue needs status detected|confirmed and those counts filter on
   * status alone.
   */
  /*
   * ⚠️ `accountId` is load-bearing, and was added after the calendar learned to
   * tell a missed bill from an unimported day.
   *
   * The calendar will only call an occurrence `missed` where the ledger has
   * actually been shown that day for the account the series bills on — and a
   * series attached to NO account has never been observed charging anywhere, so
   * it can never be graded (services/observation-frontier.ts). Without this
   * column the fixture's only overdue bill rendered "not yet known", which is
   * both the wrong state for a bill this file exists to prove is overdue and
   * inconsistent with `budgetOverdue`, which still counted it.
   *
   * Chase Freedom Unlimited is imported through 2026-07-05 (newest charge
   * 2026-07-04, statement closing 2026-07-05), so the 2026-07-05 occurrence
   * lands exactly on the frontier and is genuinely, checkably absent.
   */
  const mealKitAccount = db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.name, "Chase Freedom Unlimited"))
    .get();
  if (!mealKitAccount) throw new Error("seedBudgets: missing Chase Freedom Unlimited");

  db.insert(recurringSeries)
    .values({
      name: "Meal Kit",
      accountId: mealKitAccount.id,
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      amountCentsAvg: -125_00,
      nextExpectedOn: "2026-07-05",
      nextExpectedAmountCents: -125_00,
      lastMatchedOn: "2026-06-05",
      status: "confirmed",
      userCategoryId: topLevel("Food"),
    })
    .run();

  /*
   * A bill on an account that has NOT been imported that far — the `unsettled`
   * state, which had no rendered path at all until this series existed.
   *
   * It is the case the whole day-state split was built for. Before it, an
   * expected charge that had not posted was `missed` full stop, and on the real
   * ledger that painted six red marks across August 2026 of which only two were
   * real; the rest were days whose statements simply had not been uploaded yet,
   * which in this ledger is the normal monthly rhythm.
   *
   * SoFi Checking is the account because the ledger stops short of the charge
   * there: its newest imported row is 2026-07-04 and its newest statement closes
   * 2026-06-30, so the frontier is 2026-07-04 and a 2026-07-06 occurrence sits
   * two days past everything the app has been shown. That also makes this the
   * only e2e exercising `observationFrontier` end to end — the income branch
   * short-circuits before the frontier is ever consulted.
   *
   * ⚠️ It must be an account that exists by the time `seedBudgets` runs (§8).
   * Venture X and Capital One 360 Checking are staler and would read better in
   * the prose, and both are created LATER — the lookup below threw on the first
   * attempt rather than silently attaching to nothing, which is why it is a
   * hard failure and not a `?.`.
   *
   * Placed to cost nothing else on the page:
   *   - 2026-07-06 is BEFORE E2E_FAKE_TODAY (2026-07-08), so it is already past
   *     and gradeable, and `fixedComponents` projects from TODAY forward
   *     (forecast.ts:158) — so no projected figure moves;
   *   - `userEndsOn` caps it before the next monthly step (2026-08-06), keeping
   *     it out of the 30-day Upcoming list and the dashboard's 14-day strip;
   *   - it is money OUT, so `incomeBasis`' levelling skips it outright
   *     (budgets.ts:664, `perOccurrenceCents <= 0`).
   *
   * ⚠️ Money out is not decoration here. An INCOME series in this slot moves the
   * /budgets header by its full monthly rate even though it ends four days
   * later: `stillPaying` (budgets.ts:665) is a BOOLEAN gate, so one remaining
   * occurrence inside the horizon levels the same as a stream running all year.
   * That is the known `user_ends_on` annualisation defect, and this fixture was
   * very nearly its first writer.
   *
   * No `userCategoryId`, deliberately: that column is the only route from a
   * series with no postings to a budget, and this one must not disturb the
   * "exactly one overdue row" assertions.
   */
  const stale = db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(eq(accountsTable.name, "SoFi Checking"))
    .get();
  if (!stale) throw new Error("seedBudgets: missing SoFi Checking");

  db.insert(recurringSeries)
    .values({
      name: "Storage unit",
      accountId: stale.id,
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      amountCentsAvg: -45_00,
      nextExpectedOn: "2026-07-06",
      nextExpectedAmountCents: -45_00,
      userEndsOn: "2026-07-10",
      lastMatchedOn: "2026-06-06",
      status: "confirmed",
    })
    .run();

  const netflix = db.select({ id: recurringSeries.id }).from(recurringSeries).where(eq(recurringSeries.name, "Netflix")).get();
  const oldRow = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(like(transactions.rawDescription, "NETFLIX%"))
    .orderBy(asc(transactions.postedOn))
    .get();
  if (netflix && oldRow) {
    db.update(transactions).set({ recurringSeriesId: netflix.id }).where(eq(transactions.id, oldRow.id)).run();
  }
}

/** Day count from `from` (inclusive) up to `to` (exclusive) for the price walk. */
function dayCount(
  from: string,
  to: string,
  addDays: (s: string, n: number) => string,
  compareDates: (a: string, b: string) => number,
): number {
  let n = 0;
  for (let day = from; compareDates(day, to) < 0; day = addDays(day, 1)) n += 1;
  return n;
}

/**
 * Empties every data table on the live connection (schema + migration ledger
 * kept) so the file's inode is stable for the webServer's open connection.
 * FK enforcement is toggled off for the delete sweep so table order is moot.
 */
function resetAllData(sqlite: import("better-sqlite3").Database): void {
  sqlite.pragma("foreign_keys = OFF");
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as { name: string }[];
  const wipe = sqlite.transaction(() => {
    for (const { name } of tables) sqlite.prepare(`DELETE FROM "${name}"`).run();
  });
  wipe();
  sqlite.pragma("foreign_keys = ON");
}

/** Builds the seeded e2e base: reset → seed → import set A → categorize. */
export async function seedE2eDatabase(dbPath: string): Promise<SeedSummary> {
  const { createDatabase } = await import("../src/db/client");
  const { seedDatabase } = await import("../src/db/seed");
  const { importStatementFiles } = await import("../src/services/import/service");
  const { categorizeAll, coverageStats } = await import("../src/services/categorize");
  const { statementPeriods } = await import("../src/db/schema/imports");
  const { eq } = await import("drizzle-orm");

  const { db, sqlite } = createDatabase(dbPath); // migrations run on open
  try {
    // Wipe DATA in place rather than unlinking the file: Playwright's webServer
    // opens data/e2e.db on a long-lived connection, and deleting+recreating the
    // file (a new inode) would strand that connection on the PREVIOUS run's
    // data — invisible while set A was the only seed (identical every run), but
    // fatal to any run-varying seed like the review backlog. Same inode + WAL
    // means the server reads this run's committed seed no matter the order in
    // which Playwright brings up globalSetup and the webServer.
    resetAllData(sqlite);
    seedDatabase(db);
    const files = SET_A_DIRS.flatMap((dir) => loadDir(...dir));
    const outcomes = await importStatementFiles(db, files);
    const failed = outcomes.filter((o) => o.status === "failed");
    if (failed.length > 0) {
      throw new Error(
        `e2e seed import failures:\n${failed.map((f) => `  ${f.fileName}: ${f.error}`).join("\n")}`,
      );
    }
    // explicit final deterministic pass — category chips/coverage must exist
    // before the visual/a11y/interaction specs render
    categorizeAll(db);

    // §6 Investments: derive brokerage holdings + a controlled crypto position so
    // the portfolio table/allocation/movers/holding pages render deterministically
    await seedInvestments(db, E2E_FAKE_TODAY);

    // §7 Dashboard: a fixed set of recurring series so the upcoming-bills strip,
    // the "before your next paycheck" line, and the pace forecast have content
    await seedRecurring(db);

    // §8 Budgets: pace bars in all three tones + one expected-recurring tail
    await seedBudgets(db);

    // §9 the three decision cards no baseline has ever seen — a car, an income
    // schedule with evidence behind it, and a notice worth reading
    await seedMissingCards(db);

    // the synthetic corpus categorizes too cleanly to leave a review queue;
    // seed a deterministic clustered backlog so the §3.3 inbox + drain render
    const reviewBacklog = await seedReviewBacklog(db);

    const coverage = coverageStats(db);
    const gapPeriods = db
      .select({ id: statementPeriods.id })
      .from(statementPeriods)
      .where(eq(statementPeriods.reconciliation, "gap"))
      .all().length;
    if (gapPeriods > 0) {
      // zz-golden-path asserts the ONLY unreconciled statement is its upload
      throw new Error(`e2e seed left ${gapPeriods} unreconciled gap period(s) — set A must be gap-free`);
    }
    return {
      files: files.length,
      txns: coverage.total,
      coveragePct: coverage.coveragePct,
      gapPeriods,
      reviewBacklog,
    };
  } finally {
    sqlite.close();
  }
}
