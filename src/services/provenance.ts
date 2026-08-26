import { and, asc, count, desc, eq, inArray, lte, gte, sum } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances, type BalanceBasis } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { accountCoverage, type CoverageGrade } from "./coverage";

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
  | { kind: "netWorth"; day?: string };

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
  const weak = counted - proven - marked;

  // A total is only as proven as its weakest part, and saying so plainly is the
  // whole reason this figure gets a popover at all.
  const parts = [`${proven} of ${counted} accounts add up against a document`];
  if (marked > 0) parts.push(`${marked} ${marked === 1 ? "is" : "are"} priced from holdings`);
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
  }
}
