import { and, asc, count, desc, eq, inArray, lte, gte, sum } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, type AssetType } from "@/db/schema/holdings";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { diffDays, todayIso } from "@/lib/dates";
import { isStaleClose } from "@/lib/holding-price-age";
import { formatCents } from "@/lib/money";
import { accountCoverage, type CoverageGrade } from "./coverage";
import { MIN_OCCURRENCES } from "./recurring";

/**
 * "Prove it" — given a figure the app has rendered, what is it standing on?
 *
 * Sixty passes bought a ledger where every number is checkable and no UI
 * anywhere shows the check. Four tables already hold the whole chain and
 * nothing joins them for a reader:
 *
 *   `import_files`      the document, its parser and when it was read
 *   `statement_periods` the arithmetic gate and its verdict
 *   `balance_anchors`   the observation a day's balance rests on, and which
 *                       document it came from (`import_file_id`)
 *   `daily_balances`    what the replay concluded about each day (`basis`)
 *
 * ## The honest answer is often "derived", and that is the point
 *
 * This service exists as much to say *"nothing checks this"* as to say *"a
 * statement says so"*. `derived_unverified` is the app's own admission that it
 * replayed past its last anchor with nothing to land on, and surfacing that is
 * worth more than another confident-looking number. A figure with no proof must
 * come back {@link ProvenanceVerdict} `unverified`, never a shrug.
 *
 * ## Two arbiters, not one
 *
 * ⛔ Counting coverage by `statement_periods` alone overstates the hole roughly
 * threefold, and two agents in one pass disagreed by exactly that. There are
 * TWO independent gates and an account needs only one of them:
 *
 *  1. **Statement reconciliation** — `previous + activity = new`, per period.
 *  2. **The anchor chain** — a day is `derived` only if replaying every
 *     transaction forward from one anchor lands EXACTLY on the next.
 *
 * Chase Checking has a 22-month stretch with no statement and not one `gap`
 * day: its CSV closes the chain, so the money is checked, coarsely. Reporting
 * it as unproven because a PDF is missing would be false.
 *
 * ⚠️ And the reverse: for an INVESTMENT account `derived` is written by the
 * price walk, not by a transaction replay, and reconciliation stamps
 * `value_anchor` unconditionally — it cannot fail. Those figures are marked to
 * market, so they get their own verdict rather than borrowing a word that means
 * something stronger elsewhere.
 */

export type ProvenanceVerdict =
  /** a source document states this number */
  | "sourced"
  /** computed, and the arithmetic closes against a source document */
  | "derived"
  /** priced from holdings — a value, not an arithmetic result */
  | "market_value"
  /** computed, and nothing checks it */
  | "unverified"
  /** the owner entered this by hand; he is the source */
  | "manual"
  /** computed, and the arithmetic provably does NOT close */
  | "broken"
  /** nothing to stand on yet */
  | "unknown";

/** Ordered worst-first: a total is only as proven as its weakest input. */
const VERDICT_RANK: Record<ProvenanceVerdict, number> = {
  broken: 0,
  unknown: 1,
  unverified: 2,
  market_value: 3,
  manual: 4,
  derived: 5,
  sourced: 6,
};

export function weakestVerdict(verdicts: readonly ProvenanceVerdict[]): ProvenanceVerdict {
  if (verdicts.length === 0) return "unknown";
  return verdicts.reduce((worst, v) => (VERDICT_RANK[v] < VERDICT_RANK[worst] ? v : worst));
}

export interface ProvenanceSource {
  kind: "document" | "period" | "anchor" | "hand-entered";
  /** the document's own name, or what the owner did */
  label: string;
  /** what this source contributes — a verdict, a balance, a date */
  detail?: string;
  /** the day this source speaks about */
  on?: string;
}

/** One contributing figure, for totals assembled out of other numbers. */
export interface ProvenanceInput {
  label: string;
  verdict: ProvenanceVerdict;
  detail?: string;
}

export interface Provenance {
  verdict: ProvenanceVerdict;
  /**
   * One sentence, written for a reader rather than a developer.
   *
   * ⚠️ Figures ARE allowed here, unlike in `InfoTip`. That rule exists because
   * a Tooltip's body is live DOM even while closed, so its text collides with
   * page-level assertions; `Popover` gates its children on `open` and mounts
   * nothing until then. The distinction is why this ships on Popover.
   */
  headline: string;
  sources: ProvenanceSource[];
  /** the last day the money behind this figure provably added up */
  checkedThrough: string | null;
  /** for a total: what it was assembled from, each carrying its own verdict */
  inputs: ProvenanceInput[];
  /**
   * Overrides the badge's word for a COMPOSITE figure.
   *
   * ⛔ The weakest-verdict rule is right about correctness and wrong about
   * vocabulary. Net worth takes `unknown` from one empty-balance account, and
   * a badge reading "no basis yet" beside a figure where 6 of 12 accounts add
   * up is simply false — it was on screen before a screenshot caught it. The
   * TONE still comes from the verdict, because a hole really is a weakness;
   * only the word changes, to one that describes the mixture.
   */
  badgeWord?: string;
}

export type FigureRef =
  | { kind: "transaction"; id: string }
  | { kind: "accountBalance"; accountId: string; day?: string }
  | { kind: "statementPeriod"; id: string }
  | { kind: "netWorth"; day?: string }
  /**
   * Any total assembled by summing transactions in a category over a window —
   * a category page's spend, a budget's actual, a month's line on /spending.
   * They are ONE figure kind because they are one question: which documents is
   * this sum standing on, and is any of it unchecked?
   */
  | { kind: "categorySpend"; categoryId: string; from: string; to: string; label?: string }
  /**
   * A position's market value, aggregated across accounts by `(symbol,
   * assetType)` exactly as `holdingDetail` reports it. NOT `categorySpend`: a
   * holding's value is a share count times a price, and the two halves are
   * proven — or not — in completely different ways.
   */
  | { kind: "holding"; symbol: string; assetType: AssetType; day?: string }
  /** A recurring series' expected amount — a forecast, graded by its evidence. */
  | { kind: "recurringSeries"; id: string };

/**
 * Cash accounts only: what a day's `basis` proves about its balance.
 *
 * ⛔ `carried` is NOT a weak basis, and reading it as one is the first thing
 * this service got wrong. `deriveForward` (derivation.ts) writes
 * `sawTxn ? "derived_unverified" : "carried"` — so `carried` means **no
 * transaction has happened since the last recorded balance**, and the number is
 * therefore exactly as proven as the anchor it came from. Between two anchors
 * it is written only when the two AGREE (`a.balanceCents === b.balanceCents`);
 * when they disagree the day is `gap`.
 *
 * Today is almost always after the newest statement with nothing posted since,
 * so most accounts read `carried` on most days. Grading that "unverified" made
 * the first draft of this service announce "0 of 12 accounts add up against a
 * document" on a ledger with **zero** gap days — false, and the kind of false
 * that teaches a reader to ignore the badge.
 */
const BASIS_VERDICT: Record<BalanceBasis, ProvenanceVerdict> = {
  anchored: "sourced",
  derived: "derived",
  carried: "derived",
  derived_unverified: "unverified",
  gap: "broken",
};

/** `accountCoverage`'s per-account grade, in this service's vocabulary. */
const GRADE_VERDICT: Record<CoverageGrade, ProvenanceVerdict> = {
  verified: "derived",
  unverified: "unverified",
  broken: "broken",
  market_value: "market_value",
  manual: "manual",
  unknown: "unknown",
};

function isInvestment(type: string): boolean {
  return type === "investment" || type === "crypto";
}

/** `2026-08-24` → `Aug 24, 2026`, for a sentence rather than a table cell. */
function readableDay(day: string): string {
  const [y, m, d] = day.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m) - 1];
  if (!y || !month || !d) return day;
  return `${month} ${Number(d)}, ${y}`;
}

const PERIOD_VERDICT_TEXT: Record<string, string> = {
  reconciled: "reconciled to the cent",
  value_anchor: "value recorded — an investment statement sets a value, it never proves the rows add up",
  not_applicable: "coverage declared, but this file carries no balances to check against",
};

/* ── transaction ──────────────────────────────────────────────────────── */

function transactionProvenance(db: AppDatabase, id: string): Provenance | null {
  const txn = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!txn) return null;

  const account = db.select().from(accounts).where(eq(accounts.id, txn.accountId)).get();
  const day = db
    .select({ basis: dailyBalances.basis })
    .from(dailyBalances)
    .where(and(eq(dailyBalances.accountId, txn.accountId), eq(dailyBalances.day, txn.postedOn)))
    .get();

  if (txn.importFileId === null) {
    return {
      verdict: "manual",
      headline: "You entered this row by hand. No statement carries it, so nothing else can confirm it.",
      sources: [{ kind: "hand-entered", label: "entered by hand", on: txn.postedOn }],
      checkedThrough: null,
      inputs: [],
    };
  }

  const file = db.select().from(importFiles).where(eq(importFiles.id, txn.importFileId)).get();
  // the file's period FOR THIS ACCOUNT — a single file can carry several
  const period = db
    .select()
    .from(statementPeriods)
    .where(and(eq(statementPeriods.importFileId, txn.importFileId), eq(statementPeriods.accountId, txn.accountId)))
    .get();

  const sources: ProvenanceSource[] = [];
  if (file) {
    sources.push({
      kind: "document",
      label: file.fileName,
      detail: `read by ${file.parserProfile ?? "an unnamed parser"}`,
      on: file.importedAt.slice(0, 10),
    });
  }
  if (period) {
    sources.push({
      kind: "period",
      label: `${period.periodStart} → ${period.periodEnd}`,
      detail: PERIOD_VERDICT_TEXT[period.reconciliation] ?? period.reconciliation,
    });
  }

  /**
   * ⛔ A row is NOT proven merely because a file carried it, and treating it
   * that way put a green "on a statement" badge on a row from the Rocket Money
   * export — a third-party re-export that carries no balances and is the least
   * trustworthy source in the app. Caught by opening the sheet and reading it.
   *
   * Both arbiters count, exactly as `accountCoverage` has them:
   *
   *  1. **The period reconciled** — opening + rows = closing, to the cent. That
   *     is a document proving this row's neighbourhood adds up.
   *  2. **The anchor chain** — the day's `basis`. A CSV import supplies a
   *     running balance as an ANCHOR and creates no period at all, so judging
   *     by periods alone would call every CSV-imported row unchecked when the
   *     chain closes on it exactly.
   *
   * With neither, the honest answer is the day's own verdict — `unknown` for
   * the Wells Fargo rows, which have no derived balance because the app refuses
   * to invent one.
   */
  const reconciled = period?.reconciliation === "reconciled";
  const dayVerdict: ProvenanceVerdict =
    day && account ? (isInvestment(account.type) ? "market_value" : BASIS_VERDICT[day.basis]) : "unknown";
  const verdict: ProvenanceVerdict = reconciled ? "sourced" : dayVerdict;

  const headline = reconciled
    ? `This row came from ${file?.fileName ?? "a statement"}, and that statement's balances reconcile to the cent.`
    : dayVerdict === "derived"
      ? `This row came from ${file?.fileName ?? "an imported file"}. That file carries no balances of its own, but ${account?.name ?? "the account"}'s chain closes across this day.`
      : `This row came from ${file?.fileName ?? "an imported file"} — which carries no balances, so nothing checks the total it sits in.`;

  return {
    verdict,
    headline,
    sources,
    checkedThrough: reconciled ? period.periodEnd : null,
    inputs:
      day && account
        ? [
            {
              label: `${account.name} on ${readableDay(txn.postedOn)}`,
              verdict: dayVerdict,
              detail: `the day's balance is ${day.basis.replace(/_/g, " ")}`,
            },
          ]
        : [],
  };
}

/* ── account balance ──────────────────────────────────────────────────── */

function accountBalanceProvenance(db: AppDatabase, accountId: string, day: string | undefined): Provenance | null {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return null;

  const row = day
    ? db
        .select()
        .from(dailyBalances)
        .where(and(eq(dailyBalances.accountId, accountId), eq(dailyBalances.day, day)))
        .get()
    : db
        .select()
        .from(dailyBalances)
        .where(eq(dailyBalances.accountId, accountId))
        .orderBy(desc(dailyBalances.day))
        .get();

  if (!row) {
    return {
      verdict: "unknown",
      headline: `Nothing is derived for ${account.name} yet — import a statement to start its chain.`,
      sources: [],
      checkedThrough: null,
      inputs: [],
    };
  }

  const verdict: ProvenanceVerdict = isInvestment(account.type) ? "market_value" : BASIS_VERDICT[row.basis];

  // the anchor this day rests on: the newest observation at or before it
  const anchor = db
    .select()
    .from(balanceAnchors)
    .where(and(eq(balanceAnchors.accountId, accountId), lte(balanceAnchors.anchoredOn, row.day)))
    .orderBy(desc(balanceAnchors.anchoredOn))
    .get();

  const sources: ProvenanceSource[] = [];
  if (anchor) {
    const file = anchor.importFileId
      ? db.select().from(importFiles).where(eq(importFiles.id, anchor.importFileId)).get()
      : undefined;
    sources.push({
      kind: "anchor",
      label:
        anchor.source === "manual"
          ? "a balance you entered"
          : anchor.source === "live"
            ? "a live price reading"
            : file?.fileName ?? `a ${anchor.source.replace(/_/g, " ")} observation`,
      detail: `balance recorded on ${readableDay(anchor.anchoredOn)}`,
      on: anchor.anchoredOn,
    });
  }

  // periods covering this day, and what each concluded
  const periods = db
    .select()
    .from(statementPeriods)
    .where(
      and(
        eq(statementPeriods.accountId, accountId),
        lte(statementPeriods.periodStart, row.day),
        gte(statementPeriods.periodEnd, row.day),
      ),
    )
    .all();
  for (const p of periods) {
    sources.push({
      kind: "period",
      label: `${p.periodStart} → ${p.periodEnd}`,
      detail: PERIOD_VERDICT_TEXT[p.reconciliation] ?? p.reconciliation,
    });
  }

  // last day this account's chain was closed
  const lastClosed = db
    .select({ day: dailyBalances.day })
    .from(dailyBalances)
    .where(and(eq(dailyBalances.accountId, accountId), inArray(dailyBalances.basis, ["anchored", "derived"])))
    .orderBy(desc(dailyBalances.day))
    .get();

  return {
    verdict,
    headline: headlineForBalance(account.name, account.type, row.basis, row.day),
    sources,
    checkedThrough: isInvestment(account.type) ? null : (lastClosed?.day ?? null),
    inputs: [],
  };
}

function headlineForBalance(name: string, type: string, basis: BalanceBasis, day: string): string {
  const on = readableDay(day);
  if (isInvestment(type)) {
    return `${name} is priced from its holdings on ${on}. A brokerage statement sets a value; it never proves the transactions add up.`;
  }
  switch (basis) {
    case "anchored":
      return `A statement records ${name}'s balance on ${on} directly. This is the number the bank printed.`;
    case "derived":
      return `Every transaction was replayed forward from a recorded balance and landed exactly on the next one, through ${on}.`;
    case "derived_unverified":
      return `Replayed past the last recorded balance, so nothing checks ${name} on ${on}. The rows are real; the total is unconfirmed.`;
    case "carried":
      return `${name} had no activity to replay on ${on}, so the last known balance was carried forward.`;
    case "gap":
      return `The replay did NOT land on ${name}'s next recorded balance. Money is provably missing or double-counted around ${on}.`;
  }
}

/* ── statement period ─────────────────────────────────────────────────── */

function statementPeriodProvenance(db: AppDatabase, id: string): Provenance | null {
  const period = db.select().from(statementPeriods).where(eq(statementPeriods.id, id)).get();
  if (!period) return null;
  const file = db.select().from(importFiles).where(eq(importFiles.id, period.importFileId)).get();
  const account = db.select().from(accounts).where(eq(accounts.id, period.accountId)).get();

  const rows = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, period.accountId),
        gte(transactions.postedOn, period.periodStart),
        lte(transactions.postedOn, period.periodEnd),
        inArray(transactions.status, ["active", "excluded"]),
      ),
    )
    .all();

  const verdict: ProvenanceVerdict =
    period.reconciliation === "reconciled"
      ? "sourced"
      : period.reconciliation === "value_anchor"
        ? "market_value"
        : "unverified";

  const headline =
    period.reconciliation === "reconciled"
      ? `The opening balance plus every row in this period equals the closing balance, to the cent. ${rows.length} rows were checked.`
      : period.reconciliation === "value_anchor"
        ? `This is an investment statement: it records what ${account?.name ?? "the account"} was worth, and any difference is absorbed as market movement. There is no arithmetic here that could fail.`
        : `This file declares which days it covers but carries no balances, so nothing in it can be checked against a total.`;

  const sources: ProvenanceSource[] = [];
  if (file) {
    sources.push({
      kind: "document",
      label: file.fileName,
      detail: `read by ${file.parserProfile ?? "an unnamed parser"}`,
      on: file.importedAt.slice(0, 10),
    });
  }
  if (period.gapCents !== null && period.gapCents !== 0) {
    sources.push({ kind: "period", label: "unexplained difference", detail: `${period.gapCents} cents` });
  }

  return {
    verdict,
    headline,
    sources,
    checkedThrough: period.reconciliation === "reconciled" ? period.periodEnd : null,
    inputs: [],
  };
}

/* ── net worth ────────────────────────────────────────────────────────── */

function netWorthProvenance(db: AppDatabase, day: string | undefined): Provenance {
  const asOf = day ?? todayIso();
  /**
   * Per-account grading is `accountCoverage`'s job, not this service's. It
   * already encodes the two-arbiter doctrine — an account with no statement can
   * still be fully checked if its anchors close — and the investment branch,
   * where `derived` is written by the price walk and means only "prices were
   * fresh". Re-deriving any of that here would give the app two answers to one
   * question, and the second one would be the untested one.
   */
  const coverage = accountCoverage(db, asOf);

  /**
   * An account with no derived balance is `unknown` either way, but the two
   * cases are not the same figure:
   *
   *  - **no balance AND no rows** — genuinely empty, contributes $0, and
   *    nothing is missing. Dragging the whole total's verdict down for it is
   *    noise, and noise is what teaches a reader to stop reading.
   *  - **no balance BUT rows** — a HOLE. Wells Fargo holds 39 transactions
   *    netting $2,396.67 that this total cannot see, because the app refuses to
   *    derive a balance from the same rows a balance exists to check. That is
   *    the single most useful thing this popover can say, so it says the amount.
   */
  const rowSums = new Map(
    (
      db
        .select({ accountId: transactions.accountId, n: count(), cents: sum(transactions.amountCents) })
        .from(transactions)
        .where(inArray(transactions.status, ["active", "excluded"]))
        .groupBy(transactions.accountId)
        .all() as { accountId: string; n: number; cents: string | null }[]
    ).map((r) => [r.accountId, { n: r.n, cents: Number(r.cents ?? 0) }]),
  );
  const holes = coverage.filter((c) => c.grade === "unknown" && (rowSums.get(c.accountId)?.n ?? 0) > 0);
  const emptyAccountIds = new Set(
    coverage.filter((c) => c.grade === "unknown" && (rowSums.get(c.accountId)?.n ?? 0) === 0).map((c) => c.accountId),
  );

  const inputs: ProvenanceInput[] = coverage.map((c) => ({
    label: c.accountName,
    verdict: GRADE_VERDICT[c.grade],
    detail:
      c.grade === "verified" && c.verifiedThrough
        ? `adds up through ${readableDay(c.verifiedThrough)}`
        : c.grade === "broken" && c.brokenSince
          ? `stopped adding up on ${readableDay(c.brokenSince)}`
          : c.grade === "unverified" && c.unverifiedSince
            ? `nothing checks it since ${readableDay(c.unverifiedSince)}`
            : c.grade === "market_value"
              ? "priced from holdings"
              : c.grade === "manual"
                ? c.lastManualUpdate
                  ? `you last counted it on ${readableDay(c.lastManualUpdate)}`
                  : "you are the statement"
                : (rowSums.get(c.accountId)?.n ?? 0) > 0
                  ? `${rowSums.get(c.accountId)!.n} rows but no recorded balance — not in this total`
                  : "empty — no rows, no balance",
  }));

  // an empty account is not a weakness, it is an absence of anything at all
  const weighed = inputs.filter((_, i) => !emptyAccountIds.has(coverage[i]!.accountId));
  const verdict = weakestVerdict(weighed.map((i) => i.verdict));
  const counted = inputs.length;
  const proven = inputs.filter((i) => i.verdict === "derived" || i.verdict === "sourced").length;
  const marked = inputs.filter((i) => i.verdict === "market_value").length;
  // `manual` is a basis, not an absence — see the note in categorySpendProvenance
  const byHand = inputs.filter((i) => i.verdict === "manual").length;
  const weak = counted - proven - marked - byHand;

  // A total is only as proven as its weakest part, and saying so plainly is the
  // whole reason this figure gets a popover at all.
  const parts = [`${proven} of ${counted} accounts add up against a document`];
  if (marked > 0) parts.push(`${marked} ${marked === 1 ? "is" : "are"} priced from holdings`);
  if (byHand > 0) parts.push(`${byHand} you count yourself`);
  if (weak > 0) parts.push(`${weak} ${weak === 1 ? "has" : "have"} nothing checking ${weak === 1 ? "it" : "them"}`);
  const holeText = holes
    .map((h) => {
      const r = rowSums.get(h.accountId)!;
      return `${h.accountName} holds ${r.n} rows worth ${formatCents(r.cents)} that this total cannot see, because it has no recorded balance`;
    })
    .join("; ");

  const closed = coverage
    .filter((c) => c.grade === "verified" && c.verifiedThrough)
    .map((c) => c.verifiedThrough!)
    .sort();

  return {
    verdict,
    badgeWord: `${proven} of ${counted} add up`,
    headline: `${parts.join(", ")}. A total is only as proven as its weakest part.${holeText ? ` ⚠️ ${holeText}.` : ""}`,
    sources: [],
    // the OLDEST closed account bounds the whole figure: the total cannot be
    // proven past the first account that stops being checked
    checkedThrough: closed[0] ?? null,
    inputs,
  };
}


/* ── a holding ────────────────────────────────────────────────────────── */

/**
 * A holding's value stands on TWO independent things, and only one of them is
 * checkable. Saying so is the whole reason this kind exists rather than
 * borrowing `accountBalance`'s vocabulary.
 *
 *  - **the share count** — `holdings.quantity_e8` against the sum of every
 *    `holding_events` delta. That is a real arithmetic gate and it either
 *    closes or it does not. Measured on the live ledger: all ten active
 *    holdings close EXACTLY, including AAPL's 244 events back to 2023-12-05.
 *  - **the price** — a market observation from Yahoo or Coinbase. No document
 *    in the ledger states it and none ever will, so no amount of checking can
 *    promote it. It gets named, dated and aged instead.
 *
 * ⛔ Note this is strictly MORE than the account can say. `accountCoverage`
 * grades every investment account `market_value` unconditionally, because
 * `reconcileAccounts` absorbs a discrepancy into `market_change_cents` and
 * cannot fail — so at account level there is no gate at all. At HOLDING level
 * there is one, and it is the share count. A reader deserves the stronger
 * statement where the stronger statement is true.
 *
 * Aggregated across accounts by `(symbol, assetType)`, matching `holdingDetail`
 * — the figure on screen is the position, not one account's leg of it.
 */
function holdingProvenance(db: AppDatabase, symbol: string, assetType: AssetType, day: string | undefined): Provenance | null {
  const legs = db
    .select({
      accountId: holdings.accountId,
      accountName: accounts.name,
      quantityE8: holdings.quantityE8,
      isActive: holdings.isActive,
    })
    .from(holdings)
    .innerJoin(accounts, eq(accounts.id, holdings.accountId))
    .where(and(eq(holdings.symbol, symbol), eq(holdings.assetType, assetType)))
    .all();
  if (legs.length === 0) return null;

  const asOf = day ?? todayIso();
  const storedE8 = legs.reduce((t, l) => t + l.quantityE8, 0);

  /* ── basis 1: does the share count add up against its own events? ── */
  const events = db
    .select({
      accountId: holdingEvents.accountId,
      occurredOn: holdingEvents.occurredOn,
      deltaE8: holdingEvents.quantityDeltaE8,
    })
    .from(holdingEvents)
    .where(
      and(
        inArray(
          holdingEvents.accountId,
          legs.map((l) => l.accountId),
        ),
        eq(holdingEvents.symbol, symbol),
        eq(holdingEvents.assetType, assetType),
      ),
    )
    .all();
  const eventsE8 = events.reduce((t, e) => t + e.deltaE8, 0);
  const countMatches = eventsE8 === storedE8;
  /**
   * ⛔ A holding with NO events has nothing to check against, and
   * `0 === 0` would quietly report that as proof. That is the same shape as
   * pass 56's `Math.sign(0)` ruler — a check that passes because it never ran.
   * An unchecked count is `unknown`, never "adds up", and the two directions
   * are pinned by their own tests.
   */
  const countIsChecked = events.length > 0;

  /* ── basis 2: the price, which is an observation and cannot be promoted ── */
  const price = db
    .select({ close: priceCache.close, quotedOn: priceCache.quotedOn, source: priceCache.source })
    .from(priceCache)
    .where(and(eq(priceCache.symbol, symbol), eq(priceCache.assetType, assetType), lte(priceCache.quotedOn, asOf)))
    .orderBy(desc(priceCache.quotedOn))
    .limit(1)
    .get();

  /**
   * ⛔ `isStaleClose` is imported, not re-derived. `lib/holding-price-age`
   * exists precisely so the page note and the per-row date "can never disagree
   * about where the boundary is", and a third opinion in this service would
   * break the guarantee that docstring makes. The app's boundary is strict —
   * anything not quoted TODAY is stale — and a looser one here would let the
   * popover call a price fresh in the same breath the row beside it calls it
   * old.
   */
  const priceIsStale = price !== undefined && isStaleClose(price.quotedOn, asOf, diffDays);
  const priceAgeDays = price ? diffDays(price.quotedOn, asOf) : null;
  const agePhrase = priceAgeDays === null ? "" : `${priceAgeDays} ${priceAgeDays === 1 ? "day" : "days"} old`;

  const sources: ProvenanceSource[] = [];
  if (price) {
    sources.push({
      kind: price.source === "manual" ? "hand-entered" : "document",
      label: price.source === "manual" ? "a price you entered by hand" : `${price.source}'s close`,
      detail: priceIsStale ? `$${price.close.toFixed(2)} — ${agePhrase}` : `$${price.close.toFixed(2)}`,
      on: price.quotedOn,
    });
  }
  if (countIsChecked) {
    const firstDay = events.map((e) => e.occurredOn).sort()[0]!;
    sources.push({
      kind: "anchor",
      label: `${events.length} recorded ${events.length === 1 ? "buy or sell" : "buys and sells"}`,
      detail: countMatches
        ? "they sum exactly to the share count above"
        : `they sum to ${(eventsE8 / 1e8).toFixed(8).replace(/0+$/, "")}, not the share count above`,
      on: firstDay,
    });
  }

  /**
   * ⛔ Verdict order matters. A share count that provably does NOT close is the
   * loudest thing here and outranks any question about the price — the position
   * itself is wrong, so what it is worth is beside the point.
   */
  const verdict: ProvenanceVerdict = countIsChecked && !countMatches ? "broken" : !price ? "unknown" : "market_value";

  const shares = (storedE8 / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
  const unit = assetType === "crypto" ? "coins" : "shares";
  const countSentence = countIsChecked
    ? `The ${unit === "coins" ? "coin" : "share"} count adds up — ${events.length} recorded ${events.length === 1 ? "trade sums" : "trades sum"} exactly to it.`
    : `Nothing checks the ${unit === "coins" ? "coin" : "share"} count: no buys or sells are recorded for it.`;

  /**
   * ⛔ A CLOSED position is its own sentence. The probe caught the generic one
   * reading "0 shares × yahoo's $179.44 close … now 208 days old" for PM — a
   * true statement that wastes the reader's attention on a price that cannot
   * move a figure which is $0 whatever the price does. When the quantity is
   * zero the price is not stale, it is IRRELEVANT, and saying "208 days old"
   * invites a fix for something that is not broken.
   */
  const headline =
    storedE8 === 0
      ? `This position is closed — nothing is held, so it is worth $0 whatever ${symbol} is trading at. ${countSentence}`
      : !price
        ? `No price has ever been recorded for ${symbol}, so there is nothing to value ${shares} ${unit} at. ${countSentence}`
        : countIsChecked && !countMatches
          ? `⚠️ ${symbol}'s ${unit === "coins" ? "coin" : "share"} count does not add up: ${events.length} recorded buys and sells do not sum to the ${shares} on file. This value is ${shares} × a price, and the ${shares} is in doubt.`
          : `${shares} ${unit} × ${price.source === "manual" ? "a price you entered" : `${price.source}'s $${price.close.toFixed(2)} close`} on ${readableDay(price.quotedOn)}${priceIsStale ? `, now ${agePhrase}` : ""}. ${countSentence} The price is an observation, not a document — no statement in the ledger states it.`;

  const inputs: ProvenanceInput[] =
    legs.length > 1
      ? legs.map((l) => ({
          label: l.accountName,
          verdict,
          detail: `${(l.quantityE8 / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0"} ${assetType === "crypto" ? "coins" : "shares"}`,
        }))
      : [];

  return {
    verdict,
    /**
     * `market_value` already presents as "market value", which is exactly right
     * here, so the badge is overridden for ONE state: a share count that
     * provably does not close.
     *
     * ⛔ Deliberately NOT for price age. /investments already discloses that,
     * twice — a page note gated on the newest close and a per-row date gated on
     * the row's own (`lib/holding-price-age`) — and a badge repeating it would
     * be a third disclosure of one fact, on the one column that has to stay
     * scannable. The age is still named inside the panel, which the reader
     * opened on purpose.
     */
    badgeWord: countIsChecked && !countMatches ? "share count is off" : undefined,
    headline,
    sources,
    /**
     * ⛔ `null`, always, and deliberately. `checkedThrough` renders as
     * "Checked through <date>", which is a claim that the MONEY added up to
     * that day. A price date is not that claim and must never be printed as
     * one — the price's day is already named in `sources`, where it reads as
     * what it is.
     */
    checkedThrough: null,
    inputs,
  };
}

/* ── a recurring series' amount ───────────────────────────────────────── */

/**
 * What a forecast amount is standing on.
 *
 * ⚠️ The handoff predicted this could reuse `categorySpend`'s "sum of rows"
 * shape. It cannot, and the schema says why: the figure on screen is
 * `user_amount_cents ?? next_expected_amount_cents` (`effectiveSeries`) — an
 * owner override, or a forecast built from an average. It is not a sum of
 * anything, so the question "which documents is this sum standing on?" is the
 * wrong question. The right one is **how much evidence is behind the guess, and
 * did the evidence agree?**
 *
 * ⛔ `MIN_OCCURRENCES` is imported rather than re-picked. `recurring-calendar`
 * already reasons about exactly this — zero postings means a human authored it,
 * one or two means detection extrapolated from too little, three or more means
 * it was measured — and its docstring says outright that the threshold is
 * shared so the codebase keeps ONE definition of "enough occurrences to be a
 * statistic". A second opinion here would be a second definition.
 *
 * Measured on the live ledger: Rocket Money has 16 postings at ONE amount;
 * Flamingo rent has 3 postings at THREE different amounts; the car lease and
 * car insurance have ZERO and are pure owner assertions. Those three cases must
 * not read alike, and before this they all read as a plain number.
 */
function recurringSeriesProvenance(db: AppDatabase, id: string): Provenance | null {
  const series = db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get();
  if (!series) return null;

  const postings = db
    .select({ amountCents: transactions.amountCents, postedOn: transactions.postedOn })
    .from(transactions)
    .where(and(eq(transactions.recurringSeriesId, id), eq(transactions.status, "active")))
    .all();

  const n = postings.length;
  const distinct = new Set(postings.map((p) => p.amountCents));
  const days = postings.map((p) => p.postedOn).sort();
  const userSet = series.userAmountCents !== null;

  const sources: ProvenanceSource[] = [];
  if (userSet) {
    sources.push({
      kind: "hand-entered",
      label: `you set this to ${formatCents(series.userAmountCents!)}`,
      detail: "an override — detection does not get a vote on it",
    });
  }
  if (n > 0) {
    sources.push({
      kind: "period",
      label: `${n} tagged ${n === 1 ? "posting" : "postings"} in the ledger`,
      detail:
        distinct.size === 1
          ? // ⚠️ "every one of them" over a single posting is a plural claim
            // about a population of one — it read exactly that way for FPL.
            n === 1
            ? `it was ${formatCents([...distinct][0]!)}`
            : `every one of them ${formatCents([...distinct][0]!)}`
          : `${distinct.size} different amounts, ${formatCents(Math.min(...distinct))} to ${formatCents(Math.max(...distinct))}`,
      on: days[0],
    });
  }

  /**
   * ⛔ The verdict grades the EVIDENCE, not the forecast. A forecast is always a
   * guess about the future and no amount of evidence makes it a fact, so the
   * strongest word available here is `derived` — never `sourced`, which would
   * claim a document states next month's amount.
   */
  const verdict: ProvenanceVerdict = userSet
    ? "manual"
    : n === 0
      ? "unknown"
      : n < MIN_OCCURRENCES
        ? "unverified"
        : distinct.size === 1
          ? "derived"
          : "unverified";

  /**
   * ⛔ `unverified` presents as "nothing checks it", and that is FALSE of both
   * populations it lands on here. Rent seen three times at three different
   * amounts IS checked — by three documents that disagree. FPL seen once is
   * checked by one document, which is too thin to be a pattern but is not
   * nothing. That is the §2.4 mistake in miniature: a bucket right about the
   * arithmetic and insulting to the source.
   *
   * The TONE stays soft in both cases, because thin evidence and disagreeing
   * evidence both really do make a forecast soft. Only the word is corrected,
   * to one that says which of the two it is.
   */
  const badgeWord = userSet
    ? undefined
    : n === 0
      ? undefined
      : n < MIN_OCCURRENCES
        ? `seen ${n === 1 ? "once" : `${n} times`}`
        : distinct.size > 1
          ? `${distinct.size} different amounts`
          : undefined;

  const observed = (): string => {
    if (n === 0) return "Nothing tagged to it has ever posted, so there is no evidence behind it at all.";
    if (n < MIN_OCCURRENCES)
      return `Only ${n} tagged ${n === 1 ? "posting has" : "postings have"} ever landed — below the ${MIN_OCCURRENCES} this app requires before calling a repeat a pattern, so it is an anecdote rather than a statistic.`;
    if (distinct.size === 1)
      return `All ${n} tagged postings since ${readableDay(days[0]!)} were ${formatCents([...distinct][0]!)}, exactly.`;
    return `Its ${n} tagged postings since ${readableDay(days[0]!)} were ${distinct.size} different amounts, from ${formatCents(Math.min(...distinct))} to ${formatCents(Math.max(...distinct))} — so any single figure for it is an average, not a repeat.`;
  };

  const disagreement =
    userSet && series.amountCentsAvg !== null && series.amountCentsAvg !== series.userAmountCents
      ? ` ⚠️ The ledger's own average of what actually posted is ${formatCents(series.amountCentsAvg)}, which is not what you set.`
      : "";

  const headline = userSet
    ? `You set this amount yourself, so it is exactly as right as you are. ${observed()}${disagreement}`
    : `This is a forecast, not a record — it says what the app expects next, and nothing has happened yet to check it against. ${observed()}`;

  return {
    verdict,
    badgeWord,
    headline,
    sources,
    // a forecast is never "checked through" a day; the evidence's own dates are
    // named in `sources`, where they read as evidence rather than as a guarantee
    checkedThrough: null,
    inputs: [],
  };
}

/* ── an aggregate over transactions ───────────────────────────────────── */

/** Top few documents named, the rest counted — a list of 40 files is not evidence. */
const SOURCES_NAMED = 4;

/**
 * A total's proof is the proof of the rows underneath it, and its weakest row
 * sets the verdict.
 *
 * ⚠️ Per-ROW day lookups would be one query each, and a category page can hold
 * hundreds. `accountCoverage` answers per account in one call and already
 * carries the two dates that matter — `verifiedThrough` (the last day the chain
 * closed) and `brokenSince` (the first day it did not) — so a row is graded by
 * comparing its own date against its account's, with no extra query at all.
 */
function categorySpendProvenance(
  db: AppDatabase,
  categoryId: string,
  from: string,
  to: string,
  label: string | undefined,
): Provenance | null {
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!category) return null;

  // a parent's total includes its children, the same way the app reports it
  const childIds = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId))
    .all()
    .map((c) => c.id);
  const ids = [categoryId, ...childIds];

  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      importFileId: transactions.importFileId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.categoryId, ids),
        eq(transactions.status, "active"),
        gte(transactions.postedOn, from),
        lte(transactions.postedOn, to),
      ),
    )
    .all();

  const subject = label ?? category.name;
  if (rows.length === 0) {
    return {
      verdict: "unknown",
      headline: `No rows in ${subject} between ${readableDay(from)} and ${readableDay(to)}, so this total is zero rather than unproven.`,
      sources: [],
      checkedThrough: null,
      inputs: [],
    };
  }

  const coverage = new Map(accountCoverage(db, to).map((c) => [c.accountId, c]));
  const gradeRow = (accountId: string, postedOn: string): ProvenanceVerdict => {
    const c = coverage.get(accountId);
    if (!c) return "unknown";
    if (c.grade === "market_value" || c.grade === "manual") return GRADE_VERDICT[c.grade];
    if (c.brokenSince !== null && postedOn >= c.brokenSince) return "broken";
    if (c.verifiedThrough !== null && postedOn <= c.verifiedThrough) return "derived";
    return c.grade === "unknown" ? "unknown" : "unverified";
  };

  const handEntered = rows.filter((r) => r.importFileId === null).length;
  const verdicts = rows.map((r) => (r.importFileId === null ? "manual" : gradeRow(r.accountId, r.postedOn)));
  const proven = verdicts.filter((v) => v === "derived" || v === "sourced").length;
  /**
   * ⛔ Three buckets, not two. Folding `market_value` into "not checked" told
   * the truth about arithmetic and lied about the figure: every
   * `Investments > Buys` row read "0 of 404 checked", as though 404 rows were
   * missing evidence, when what they actually are is priced from holdings —
   * a different kind of basis, not an absent one.
   */
  const marked = verdicts.filter((v) => v === "market_value").length;
  /**
   * ⛔ FOUR buckets. `manual` is a basis, not an absence — for cash in a safe
   * the owner IS the best evidence that will ever exist, and calling his own
   * count "nothing checking it" is both wrong and insulting to the only source
   * there is. It read exactly that way on /budgets before this.
   */
  const byHand = verdicts.filter((v) => v === "manual").length;
  const weak = rows.length - proven - marked - byHand;
  const verdict = weakestVerdict(verdicts);

  const fileIds = [...new Set(rows.map((r) => r.importFileId).filter((f): f is string => f !== null))];
  const files =
    fileIds.length === 0
      ? []
      : db.select().from(importFiles).where(inArray(importFiles.id, fileIds)).orderBy(desc(importFiles.importedAt)).all();

  const sources: ProvenanceSource[] = files.slice(0, SOURCES_NAMED).map((f) => ({
    kind: "document" as const,
    label: f.fileName,
    detail: `read by ${f.parserProfile ?? "an unnamed parser"}`,
    on: f.importedAt.slice(0, 10),
  }));
  if (files.length > SOURCES_NAMED) {
    sources.push({
      kind: "document",
      label: `and ${files.length - SOURCES_NAMED} more documents`,
      detail: "not listed",
    });
  }
  if (handEntered > 0) {
    sources.push({
      kind: "hand-entered",
      label: `${handEntered} ${handEntered === 1 ? "row" : "rows"} you entered by hand`,
      detail: handEntered === 1 ? "no statement carries it" : "no statement carries them",
    });
  }

  const parts = [
    `${rows.length} ${rows.length === 1 ? "row" : "rows"} from ${files.length} ${files.length === 1 ? "document" : "documents"}`,
  ];
  if (marked > 0) parts.push(`${marked} ${marked === 1 ? "is" : "are"} priced from holdings rather than checked by arithmetic`);
  if (byHand > 0) parts.push(`${byHand} you entered yourself`);
  if (weak > 0) parts.push(`${weak} ${weak === 1 ? "has" : "have"} nothing checking ${weak === 1 ? "it" : "them"}`);

  // the last day EVERY contributing row is still covered — the first account to
  // stop being checked bounds the whole total, exactly as it does for net worth
  const closed = [...new Set(rows.map((r) => r.accountId))]
    .map((a) => coverage.get(a)?.verifiedThrough)
    .filter((d): d is string => typeof d === "string")
    .sort();

  return {
    verdict,
    // the badge only overrides when rows are genuinely UNCHECKED — a category
    // that is entirely market value should read "market value", not a fraction
    badgeWord: weak === 0 ? undefined : `${rows.length - weak} of ${rows.length} checked`,
    headline: `This total is the sum of ${parts.join(", ")}. A total is only as proven as its weakest row.`,
    sources,
    checkedThrough: closed[0] ?? null,
    inputs: [],
  };
}

/* ── entry point ──────────────────────────────────────────────────────── */

/**
 * What backs a rendered figure. Returns `null` only when the figure's subject
 * does not exist — an unproven figure is an answer, not an absence.
 */
export function provenanceFor(db: AppDatabase, ref: FigureRef): Provenance | null {
  switch (ref.kind) {
    case "transaction":
      return transactionProvenance(db, ref.id);
    case "accountBalance":
      return accountBalanceProvenance(db, ref.accountId, ref.day);
    case "statementPeriod":
      return statementPeriodProvenance(db, ref.id);
    case "netWorth":
      return netWorthProvenance(db, ref.day);
    case "categorySpend":
      return categorySpendProvenance(db, ref.categoryId, ref.from, ref.to, ref.label);
    case "holding":
      return holdingProvenance(db, ref.symbol, ref.assetType, ref.day);
    case "recurringSeries":
      return recurringSeriesProvenance(db, ref.id);
  }
}
