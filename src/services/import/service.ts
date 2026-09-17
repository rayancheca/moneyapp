import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, isNotNull, isNull, lte, max, min, ne, or, sql } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { KEPT_OPENING_SOURCE, balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods, type FileFormat, type ImportStatus } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import {
  transactions,
  type CategorizationSource,
  type FileLinkSource,
  type SeriesLinkSource,
  type TransactionStatus,
} from "@/db/schema/transactions";
import { migrateSplits, splitCountsByTxn } from "../transaction-splits";
import { addDays } from "@/lib/dates";
import { descriptionScore } from "@/lib/description-score";
import { assignOccurrenceIndexes, dedupeHash, fileSha256, type DuplicatePairSide } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { sumCents } from "@/lib/money";
import { RECONCILE_STATUSES, periodVerdict } from "@/lib/reconciliation";
import { postedInsidePeriod } from "@/lib/statement-period";
import { recordWithheldSections, withheldSectionNotice } from "@/lib/import-file-label";
import { categorizeAll, detectTransfers } from "../categorize";
import { rebuildAccount } from "../derivation";
import { flagDuplicateCandidates } from "../duplicate-flags";
import { linkRowsMadeActive, settleSeriesStats } from "../recurring-import-links";
import { detachTransferLegs, type StaleTransferLeg } from "../transfer-links";
import {
  accountsOfTransactions,
  claimKeptSides,
  keptSidesAmong,
  moveKeptSide,
  restoreDuplicatesLosingTheirSurvivor,
  retireStandIn,
  standInsOn,
  standInsReturnedBy,
} from "../duplicate-lifecycle";
import { accountsFormerlyNumbered, formerNumbers } from "./account-numbers";
import { accountSlug, institutionSlug } from "./account-slug";
import { ATTACHED, detachAttachedRows, keepRetiredAttachedRows, parsedFromFile, parsedRow, reattachDetachedRows } from "./attached-rows";
import {
  bookEventsByCashAccount,
  cashOnlyReadsOn,
  cashOnlyStatementsByAccount,
  copiesWithheldFor,
  equityAssetTypesOf,
  findBook,
  laterBookStatements,
  laterStatementsRefusal,
  NegativePositionError,
  removeEmptyBooks,
  removeFileEvents,
  resolveBook,
  withheldCopiesRefusal,
  writeStatementPositions,
  type LaterBookStatement,
} from "./brokerage-book";
import { handOverPrintedAnchors } from "./printed-anchors";
import {
  followingOpeningsByFile,
  handOverKeptOpenings,
  keepOpenings,
  keepRetiredOpenings,
  keptOpeningPlans,
  replaceKeptOpening,
  retiredOpenings,
  settleKeptOpenings,
} from "./kept-openings";
import {
  copyHandOvers,
  forgetStatementCopies,
  handOverToCopies,
  handedRowIds,
  lendToCopies,
  lentPeriodsOf,
  reclaimFromCopy,
  recordStatementCopy,
  settleLentPeriods,
  type CopyHandOver,
  type LentPeriod,
} from "./statement-copies";
import {
  appendPrintedLines,
  forgetPrintedLines,
  handOverToPrinters,
  heldForPrinters,
  printedLineOf,
  printedWordsOfRows,
  printerHandOvers,
  printerRowIds,
  settleHeldRows,
} from "./printed-lines";
import {
  keepStayingLegsByContent,
  moveWaitingLeg,
  relinkReturningTransfers,
  rememberTransfersTakenApart,
  waitByRowsAgain,
} from "./unimported-transfers";
import {
  forgetRemembered,
  rememberRowAttributes,
  rememberedRows,
  restoreRememberedSplits,
  splitsOf,
  type RememberedInsert,
  type RememberedSplit,
} from "./unimported-attributes";
import { sniffFile } from "./sniff";
import { PROFILES } from "./profiles";
import { extractLines } from "./profiles/pdf-profile";
import {
  ParseError,
  type AccountHint,
  type CanonicalTxn,
  type KnownAccount,
  type ParseContext,
  type ParsedFile,
  type ParsedStatement,
  type WithheldSection,
  type ParserProfile,
} from "./types";

/**
 * The import orchestrator (master-plan Phases 2a/2b): sniff → profile →
 * canonical rows → ownership/takeover → hash dedupe → statement periods →
 * reconciliation identities → quarantine → anchors → derived rebuild.
 * Import-order independence is an invariant: any permutation of the same
 * file set converges to an equivalent database.
 */

const FORMAT_PRIORITY: Record<FileFormat, number> = { ofx: 0, qfx: 0, csv: 1, pdf: 2 };

/**
 * Per-PROFILE fidelity, for sources whose FORMAT lies about how much they can
 * be trusted. Lower is more trustworthy, same scale as `FORMAT_PRIORITY`.
 *
 * ⛔ `rocket-money-csv` is a third-party re-export, not a bank's own file, and
 * it is provably incomplete: the sum of its 39 Wells Fargo rows is $2,396.67
 * and the owner's bank app disagrees. Ranked by format alone it would be a
 * `csv` at priority 1 — MORE trustworthy than every PDF statement in the app —
 * so the day it covers would "own" those days and a real Wells Fargo statement
 * would have every one of its rows silently dropped as `skippedOwned`.
 *
 * Ranking it below `pdf` inverts that correctly, and does so through machinery
 * that already exists: the takeover path below supersedes a lower-fidelity
 * source's rows when a higher-fidelity file covers the same day. So when the
 * real statement arrives, it REPLACES this export rather than being blocked by
 * it, and nothing has to be deleted by hand first.
 */
const PROFILE_FIDELITY: Record<string, number> = { "rocket-money-csv": 9 };

/** A file's trust rank: its profile's override, else its format's. */
export function fidelityOf(format: FileFormat, parserProfile: string | null | undefined): number {
  const override = parserProfile == null ? undefined : PROFILE_FIDELITY[parserProfile];
  return override ?? FORMAT_PRIORITY[format];
}

export interface PeriodOutcome {
  accountName: string;
  start: string;
  end: string;
  reconciliation: string;
  gapCents: number | null;
  marketChangeCents: number | null;
}

/** A section of a file that was NOT imported, as the owner reads it — see `WithheldSection`. */
export interface WithheldOutcome {
  /** the tracked account the section belongs to; null only when no account at the institution carries its last4 */
  accountId: string | null;
  accountName: string | null;
  last4: string | null;
  periodStart: string;
  periodEnd: string;
  /** why, in plain words */
  reason: string;
  /** the sentence /imports shows under the file, built from these facts — `withheldNoticeOf` */
  notice: string;
}

export interface FileOutcome {
  fileName: string;
  status: "parsed" | "failed" | "skipped_duplicate";
  error?: string;
  /**
   * Sections of a `parsed` file that were NOT imported because the parser could not prove them. Everything else in
   * the file imported; the file's `import_files.error` records these sections (`recordWithheldSections`) so /imports,
   * the statement-gaps panel and the scripts can read which account and which window.
   */
  withheld: WithheldOutcome[];
  inserted: number;
  deduped: number;
  /**
   * rows whose exact hash missed (different raw text across export formats)
   * but whose money the DB already records from another source — matched by
   * (account, posted_on, amount) with multiset consumption, never inserted
   */
  dedupedCrossFormat: number;
  /** rows not inserted because a higher-fidelity source owns their date range */
  skippedOwned: number;
  supersededTakeover: number;
  /**
   * rows that inherited attributes the parser cannot re-derive (a hand-set
   * or Claude's category, a note, a transfer or recurring link, an exclusion,
   * splits) from this same file's prior parser version — the re-parse
   * lifecycle, visible instead of silent
   */
  carriedForward: number;
  /**
   * rows that took back what the owner had set on the same line before an un-import removed it — a category no engine
   * sets again, a note, a recurring link, an exclusion, splits (`unimported-attributes`)
   */
  givenBack: number;
  /**
   * rows the retired read held that the new read no longer writes and another still-imported file prints: kept, with
   * everything on them, filed under that file — as un-importing the retired read keeps them (`settleHeldRows`)
   */
  keptByPrinters: number;
  quarantined: number;
  periods: PeriodOutcome[];
}

interface CoveredRange {
  importFileId: string;
  priority: number;
  minDay: string;
  maxDay: string;
}

/**
 * Cross-format reconciliation dedupe (the DB is master): the account's
 * balance-affecting rows from OTHER sources. An incoming row whose exact hash
 * misses still dedupes when one of these records the same money — described
 * with different raw text, or dated differently, by another export format.
 * Each existing row absorbs at most one incoming row, so two genuinely
 * identical same-day charges stay distinct.
 * Quarantined rows stay out (they don't affect balances, so an incoming
 * balance-affecting row must not vanish against one), and superseded rows are
 * history.
 *
 * `retiredAgain` leaves out the copies this statement retires again
 * (`standInsReturnedBy`): each is a retired row the un-import of this
 * statement put back, standing in for a line the statement now prints. Before
 * the un-import it was out of this pool, and a same-day copy left in would
 * absorb the very line it was retired for.
 */
interface IdentitySlot {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
}

function existingIdentitySlots(
  db: AppDatabase,
  accountId: string,
  excludeFileId: string,
  retiredAgain: ReadonlySet<string>,
): IdentitySlot[] {
  return db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      transactedOn: transactions.transactedOn,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        inArray(transactions.status, ["active", "excluded"]),
        sql`(${transactions.importFileId} IS NULL OR ${transactions.importFileId} != ${excludeFileId})`,
      ),
    )
    .all()
    .filter((r) => !retiredAgain.has(r.id));
}

/**
 * How surely an existing row records a line's money: same amount, and the same TRANSACTION day (2), the same posted
 * day (1), or both (3); 0 is no match. Exact days only, never a window — a window would merge genuinely distinct
 * same-amount charges (measured: 43 such pairs on Chase Sapphire).
 *
 * The transaction day exists because a source can date the SAME charge differently: a Chase card statement prints the
 * TRANSACTION day, while the Spending Report export posts it one to three days later. Keyed only on posted_on,
 * re-stating a card period inserted a duplicate of nearly every row in it.
 */
function identityWeight(line: CanonicalTxn, slot: IdentitySlot): number {
  if (line.amountCents !== slot.amountCents) return 0;
  const sameTransactionDay = line.transactedOn !== undefined && slot.transactedOn !== null && line.transactedOn === slot.transactedOn;
  return (sameTransactionDay ? 2 : 0) + (line.postedOn === slot.postedOn ? 1 : 0);
}

/**
 * Which of a statement's lines another record of the same money absorbs: a MAXIMUM matching of lines to existing rows
 * (each row absorbs at most one line), each line trying its surest rows first (`identityWeight`), the lines with the
 * surest match placed first. Returns the indexes of the absorbed lines.
 *
 * 🔴 Lines were matched one at a time to the first unused row on the posted day, then on the transaction day. A
 * statement prints RAM`S VILLAGE −$10.40 on 05-05, 05-08 and 05-11; the Spending Report posts the same three on 05-07,
 * 05-11 and 05-13. Read second, the report's 05-11 post (the 05-08 charge) took the statement's 05-11 charge, and its
 * 05-13 post (the 05-11 charge) found nothing left and was stored a second time: on a copy of the real ledger,
 * 2026-09-16, re-importing 20260602-statements-9805-.pdf and then Spending Report PDF (1).pdf left the charge counted
 * twice and all 86 of the statement's rows quarantined behind a $10.40 gap. A matching of the whole statement absorbs
 * every line some row records, whatever order the lines come in.
 *
 * Returns each absorbed line's index with the row that absorbs it.
 */
function absorbedLines(lines: readonly CanonicalTxn[], slots: readonly IdentitySlot[]): Map<number, string> {
  const byAmount = new Map<number, IdentitySlot[]>();
  for (const slot of slots) byAmount.set(slot.amountCents, [...(byAmount.get(slot.amountCents) ?? []), slot]);
  const candidates = lines.map((line) =>
    (byAmount.get(line.amountCents) ?? [])
      .map((slot) => ({ slot, weight: identityWeight(line, slot) }))
      .filter((c) => c.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.slot.id.localeCompare(b.slot.id))
      .map((c) => ({ id: c.slot.id, weight: c.weight })),
  );
  const holder = new Map<string, number>();
  const place = (line: number, seen: Set<string>): boolean => {
    for (const { id } of candidates[line]!) {
      if (seen.has(id)) continue;
      seen.add(id);
      const other = holder.get(id);
      if (other === undefined || place(other, seen)) {
        holder.set(id, line);
        return true;
      }
    }
    return false;
  };
  const order = lines
    .map((_, i) => i)
    .filter((i) => candidates[i]!.length > 0)
    .sort((a, b) => candidates[b]![0]!.weight - candidates[a]![0]!.weight || a - b);
  for (const line of order) place(line, new Set());
  return new Map([...holder].map(([id, line]) => [line, id] as const));
}

/** What the import does with one line of a statement, decided before anything is written. */
type LinePlan = { kind: "owned" } | { kind: "takeover"; victimId: string } | { kind: "absorbed"; byId: string } | { kind: "new" };

/**
 * Every line's fate, in print order: a higher-fidelity source owns its day; it takes over a lower-fidelity source's
 * row (which then records nothing, so no line may be absorbed by it); another record of the same money absorbs it
 * (`absorbedLines`); or it is new. Read-only — `pickTakeoverVictim` is told which rows earlier lines already took, as
 * the loop that follows will have superseded them.
 */
function planLines(
  tx: AppDatabase,
  accountId: string,
  lines: readonly StoredLine[],
  ranges: readonly CoveredRange[],
  myPriority: number,
  slots: readonly IdentitySlot[],
): LinePlan[] {
  const taken = new Set<string>();
  const identity: number[] = [];
  const plan = lines.map(({ printed: t, stored, hash }, i): LinePlan => {
    // `soleSource` rows opt out: the higher-fidelity source covers the
    // DAY but is documented not to carry this row type (CanonicalTxn)
    if (!t.soleSource && rangesCovering(ranges, stored.postedOn).some((r) => r.priority < myPriority)) return { kind: "owned" };
    // takeover: a lower-fidelity source covers the day this row PRINTS —
    // replace its best-matching row (schema.md: date, amount, description
    // similarity). `pickTakeoverVictim` looks for that row on the printed
    // day, so the coverage asked about is the printed day's too.
    const lowerOwners = rangesCovering(ranges, t.postedOn).filter((r) => r.priority > myPriority);
    if (lowerOwners.length > 0) {
      const victim = pickTakeoverVictim(tx, accountId, t, hash, lowerOwners.map((r) => r.importFileId), taken);
      if (victim) {
        taken.add(victim.id);
        return { kind: "takeover", victimId: victim.id };
      }
    }
    identity.push(i);
    return { kind: "new" };
  });
  // a row taken over leaves the ledger: it absorbs nothing
  const open = slots.filter((slot) => !taken.has(slot.id));
  for (const [k, byId] of absorbedLines(identity.map((i) => lines[i]!.printed), open)) plan[identity[k]!] = { kind: "absorbed", byId };
  return plan;
}

/**
 * The user-set attributes a row owns — everything the parser cannot re-derive.
 * They belong to the MONEY, not to the parse, so a re-parse at a new parser
 * version must move them onto the fresh row (schema.md lifecycle rule).
 * `categorizationSource` decides whether the category itself travels: a
 * `user` category always, with its merchant, because categorizeAll never
 * revisits a user-categorized row; an engine's only where no engine of the
 * import derives it again (`engineCategoryCarry`: Claude's, and transfer
 * detection's with its group) — rule/merchant/bank/credit categories are
 * re-derived by categorizeAll once the batch settles, so carrying one would
 * freeze a stale guess.
 * Deliberately NOT carried: needs_review (re-derived every import — except
 * with Claude's category, whose verdict it is) and
 * quarantined status (a reconciliation verdict on the OLD file's period —
 * the new file reconciles for itself).
 *
 * `fileLinkSource` travels onto the row this file inserts for the same money
 * (`applyCarry`) and nowhere else. 🔴 A version bump supersedes an attached row
 * (`attached-rows`) with the rest of its file and inserts the statement's line
 * fresh: the note, category and links moved, the marker did not, and the next
 * un-import deleted the owner's reconstruction as a parsed row (the review,
 * 2026-09-15). It never fills another source's row (`fillFromCarry`): that row
 * is filed under the file that parsed it. A takeover victim belongs to another
 * file, so `insertTxn` does not take it from one. An attached row no line of the
 * new read claims is not retired at all (`unclaimedAttachedRows`).
 */
interface CarryAttributes {
  categoryId: string | null;
  categorizationSource: CategorizationSource | null;
  categorizationConfidence: number | null;
  merchantId: string | null;
  /** travels only with an engine's category (`engineCategoryCarry`) */
  needsReview: boolean;
  notes: string | null;
  transferGroupId: string | null;
  recurringSeriesId: string | null;
  seriesLinkSource: SeriesLinkSource | null;
  fileLinkSource: FileLinkSource | null;
  status: TransactionStatus;
}

/**
 * A superseded prior-version row, still content-matchable to its successor — or a record of a row an un-import removed
 * (`unimported-attributes`), whose id is the record's and whose split parts travel with it.
 */
interface CarryRow extends CarryAttributes {
  id: string;
  dedupeHash: string;
  normalizedDescription: string;
  transactedOn: string | null;
  /** a record's split parts; a prior-version row's parts are its own row's (`adoptCarriedSplits`) */
  splits?: readonly RememberedSplit[];
}

/**
 * Carryable rows bucketed by (account, day, amount) — the money's identity —
 * under the day each was POSTED and, when it has one, the day it was
 * TRANSACTED. One claim per old row, whichever index found it.
 */
interface CarryPool {
  byPosted: Map<string, CarryRow[]>;
  byTransacted: Map<string, CarryRow[]>;
  taken: Set<string>;
}

function carryKey(accountId: string, postedOn: string, amountCents: number): string {
  return `${accountId}\x1f${postedOn}\x1f${amountCents}`;
}

/**
 * A detach — the owner's "not this one" — is a user attribute like any other:
 * stored as NO series with `series_link_source = 'user'`, and it is the only
 * thing that keeps detection and linking at import off the row.
 *
 * 🔴 The carry used to travel only WITH a series id, so a re-parse brought a
 * detached row back as NULL/NULL, filed under the new import file — which is
 * exactly the scope an upload links — and `absorbIntoLiveSeries` re-linked it
 * in that same upload. Reproduced 2026-09-14 on uc/linking: re-parsing a Chase
 * card CSV with its April NETFLIX row detached brought April back LINKED to
 * Netflix, `detected`. Before linking at import the marker was lost just the
 * same, but nothing re-linked the row until someone pressed Detect now.
 */
function isDetach(row: Pick<CarryAttributes, "recurringSeriesId" | "seriesLinkSource">): boolean {
  return row.recurringSeriesId === null && row.seriesLinkSource === "user";
}

/** The link ownership a carry passes on: with its link, or as a detach — otherwise none. */
function carriedLinkSource(
  carry: Pick<CarryAttributes, "recurringSeriesId" | "seriesLinkSource">,
): SeriesLinkSource | null {
  return carry.recurringSeriesId !== null || isDetach(carry) ? carry.seriesLinkSource : null;
}

/**
 * A category an engine gave the row that no engine of the import derives again, so a re-read that dropped it would move
 * the row — and how the successor takes it:
 *  - `claude` fills: Claude categorizes only a row no engine categorized, and an import never calls it. A category the
 *    new parser reads from the file outranks it, as it would have kept Claude away. So does a category with NO recorded
 *    source — set before sources were recorded, or by a write that recorded none: no engine sets it again either.
 *    Measured on a copy of the real ledger, 2026-09-16: 216 live rows (215 on SoFi) hold one, and a round trip of
 *    sofi-statement-2025-03.pdf moved 17 of them to Uncategorized (decision 18, `unimported-attributes`).
 *  - `transfer_detect` overwrites, with the transfer group it belongs to: detection pairs only rows with no group, and
 *    the group travels with the carry, so detection never reads the row again — its verdict on the pair stays.
 * Every other engine (rules, the merchant map, bank categories, credit matching) runs over the new row once the batch
 * settles, and carrying its answer would freeze a stale guess.
 *
 * 🔴 Only a hand-set category travelled. Measured on a copy of the real ledger, 2026-09-16: re-reading the Discover CSV
 * (v1 → v2, the money identical) re-derived 485 Claude and transfer-detection categories through the merchant map,
 * moved 7 of them — two to none — and took the uncategorized count from 38 to 40. And the same day, re-reading the 33
 * Robinhood statements at parser v5: the carry took Robinhood Agentic's +$26.64 link and left detection's category, so
 * the leg went from Investment Contribution to Internal Transfer (merchant map) while Robinhood Cash's leg stayed a
 * contribution, and /summary's 2026 money-weighted return dropped the flow (33.87% → 33.81%).
 */
function engineCategoryCarry(row: Pick<CarryAttributes, "categoryId" | "categorizationSource" | "transferGroupId">): "fill" | "overwrite" | null {
  if (row.categoryId === null) return null;
  if (row.categorizationSource === "claude" || row.categorizationSource === null) return "fill";
  if (row.categorizationSource === "transfer_detect" && row.transferGroupId !== null) return "overwrite";
  return null;
}

/** The category columns an engine's category travels with. */
function engineCategoryColumns(carry: CarryAttributes): Partial<typeof transactions.$inferInsert> {
  return {
    categoryId: carry.categoryId,
    categorizationSource: carry.categorizationSource,
    categorizationConfidence: carry.categorizationConfidence,
    // Claude's verdict includes whether it was sure (and so does a category with no source); a pair detection commits
    // leaves the review queue
    needsReview: engineCategoryCarry(carry) === "fill" ? carry.needsReview : false,
  };
}

/**
 * A category the owner set by hand — or his "Uncategorized", which `applyCorrection` writes as NO category with source
 * `user`: every engine and Claude's queue leave such a row alone (`notUserOwned`), so it is his work like any other.
 *
 * 🔴 Only a hand category with an id travelled. A round trip of Statement_092026_4208.pdf brought KnockBox AI LLC
 * (−$2.20) back as NULL/NULL, into categorization, transfer detection and Claude's queue, while the confirmation had
 * counted it as given back (the review of uc/final-integrate, 2026-09-16, on a copy of the real ledger).
 */
function isHandCategory(row: Pick<CarryAttributes, "categorizationSource">): boolean {
  return row.categorizationSource === "user";
}

/** Something a re-parse would otherwise destroy (splits handled separately). */
function hasCarryableAttributes(row: CarryRow): boolean {
  return (
    isHandCategory(row) ||
    engineCategoryCarry(row) !== null ||
    row.notes !== null ||
    row.transferGroupId !== null ||
    row.recurringSeriesId !== null ||
    isDetach(row) ||
    // an attached row with nothing else on it is still not the parser's
    row.fileLinkSource !== null ||
    row.status === "excluded"
  );
}

/**
 * Snapshot the user-set attributes of the rows a set of about-to-be-superseded
 * import files contributed. MUST run BEFORE supersedeFileContribution — after
 * it the rows are `superseded` and every lookup path skips them.
 */
function captureCarryForward(db: AppDatabase, oldFileIds: readonly string[]): CarryPool {
  const pool: CarryPool = { byPosted: new Map(), byTransacted: new Map(), taken: new Set() };
  if (oldFileIds.length === 0) return pool;
  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.importFileId, [...oldFileIds]),
        inArray(transactions.status, ["active", "quarantined", "excluded"]),
      ),
    )
    .all();
  // a split row carries even when its parent fields are empty: the parts are
  // the user's work and must land on the successor — and so does a row the
  // owner's duplicate verdict keeps (`moveKeptSide`)
  const splitCounts = splitCountsByTxn(db, rows.map((r) => r.id));
  const keptSides = keptSidesAmong(db, rows.map((r) => r.id));
  for (const row of rows) {
    if (!hasCarryableAttributes(row) && (splitCounts.get(row.id) ?? 0) === 0 && !keptSides.has(row.id)) continue;
    bucketCarry(pool.byPosted, carryKey(row.accountId, row.postedOn, row.amountCents), row);
    if (row.transactedOn !== null) {
      bucketCarry(pool.byTransacted, carryKey(row.accountId, row.transactedOn, row.amountCents), row);
    }
  }
  // deterministic order so two runs consume identical buckets identically
  for (const map of [pool.byPosted, pool.byTransacted]) {
    for (const bucket of map.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  }
  return pool;
}

/**
 * What the owner had set on rows an un-import removed (`unimported-attributes`), as rows a line may claim — never a
 * transfer (`unimported-transfers` keeps those) and never a row filed by hand (an un-import keeps those).
 */
function recallPool(db: AppDatabase): CarryPool {
  const pool: CarryPool = { byPosted: new Map(), byTransacted: new Map(), taken: new Set() };
  for (const r of rememberedRows(db)) {
    const row: CarryRow = {
      id: r.id,
      dedupeHash: r.dedupeHash,
      normalizedDescription: r.normalizedDescription,
      transactedOn: r.transactedOn,
      categoryId: r.categoryId,
      categorizationSource: r.categorizationSource,
      categorizationConfidence: r.categorizationConfidence,
      merchantId: r.merchantId,
      needsReview: r.needsReview,
      notes: r.notes,
      transferGroupId: null,
      recurringSeriesId: r.recurringSeriesId,
      seriesLinkSource: r.seriesLinkSource,
      fileLinkSource: null,
      status: r.excluded ? "excluded" : "active",
      splits: r.splits,
    };
    bucketCarry(pool.byPosted, carryKey(r.accountId, r.postedOn, r.amountCents), row);
    if (r.transactedOn !== null) bucketCarry(pool.byTransacted, carryKey(r.accountId, r.transactedOn, r.amountCents), row);
  }
  for (const map of [pool.byPosted, pool.byTransacted]) {
    for (const bucket of map.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  }
  return pool;
}

/**
 * What an un-import keeps of the rows it is about to delete — the live rows `importFileId` parsed and hands to no
 * other file — for an import to give back (`unimported-attributes`): a category no engine of an import sets again
 * (a hand-set one, and `engineCategoryCarry`'s fill: Claude's, or one with no recorded source), the note, the
 * recurring link or the owner's "not this one", the exclusion, the split parts. A transfer and its category are
 * `unimported-transfers`' to keep; a duplicate verdict is `duplicate-lifecycle`'s.
 */
function rememberedOf(tx: AppDatabase, importFileId: string): RememberedInsert[] {
  const rows = tx
    .select()
    .from(transactions)
    .where(and(parsedFromFile(importFileId), ne(transactions.status, "superseded")))
    .all();
  const parts = splitsOf(
    tx,
    rows.map((r) => r.id),
  );
  // a row another file wrote, filed here because this file prints its money, waits for this file's line, in its words
  const printedWords = printedWordsOfRows(tx, importFileId, rows);
  return rows.flatMap((row): RememberedInsert[] => {
    const splits = parts.get(row.id) ?? [];
    // 🔴 a transfer leg's hand category is the one the pair gave it (`linkTransferPair`), and `unimported-transfers`
    // gives it back only with the pair — kept here too, it came back on a leg whose transfer the owner had ended since
    // (linked elsewhere), as a transfer category that no total counts (the review of uc/final-integrate, 2026-09-16)
    const category =
      (isHandCategory(row) && row.transferGroupId === null) || engineCategoryCarry({ ...row, transferGroupId: null }) === "fill";
    const anything = category || row.notes !== null || row.recurringSeriesId !== null || isDetach(row) || row.status === "excluded" || splits.length > 0;
    if (!anything) return [];
    return [
      {
        accountId: row.accountId,
        postedOn: row.postedOn,
        transactedOn: row.transactedOn,
        amountCents: row.amountCents,
        normalizedDescription: printedWords.get(row.id) ?? row.normalizedDescription,
        dedupeHash: row.dedupeHash,
        categoryId: category ? row.categoryId : null,
        categorizationSource: category ? row.categorizationSource : null,
        categorizationConfidence: category ? row.categorizationConfidence : null,
        merchantId: category ? row.merchantId : null,
        needsReview: category ? row.needsReview : false,
        notes: row.notes,
        recurringSeriesId: row.recurringSeriesId,
        seriesLinkSource: carriedLinkSource(row),
        excluded: row.status === "excluded",
        splits: splits.length > 0 ? JSON.stringify(splits) : null,
      },
    ];
  });
}

/**
 * The rows filed under a retired read by hand (`attached-rows`) that no line of the new read claimed. Each is
 * bucketed once under its posted day, so the posted index lists every carry row exactly once.
 *
 * A claim is the new read printing the same money — same account, same day, same amount, by the lenses
 * `absorbedLines` absorbs a line by — so an unclaimed row is money the new read does not record: a section it
 * withholds, an account it no longer reads, a line it no longer prints. A claimed row follows the carry: onto the
 * row that now records its money, or out with its superseded row when another source's row records it.
 */
function unclaimedAttachedRows(pool: CarryPool): CarryRow[] {
  return [...pool.byPosted.values()].flat().filter((row) => row.fileLinkSource === ATTACHED && !pool.taken.has(row.id));
}

function bucketCarry(map: Map<string, CarryRow[]>, key: string, row: CarryRow): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(row);
  else map.set(key, [row]);
}

/**
 * Claim the prior-version row for this incoming row, if any. Same account, same
 * day, same amount — that is the same money even when a fixed parser now reads
 * the description differently; the description only RANKS candidates when a day
 * holds several equal amounts. Multiset consumption: each old row's attributes
 * migrate onto at most one successor.
 *
 * Posted day first, then transaction day to transaction day — the fallback
 * `identityWeight` already makes, for the same reason: a card statement prints
 * the TRANSACTION day. 🔴 Keyed on the posted day alone, Chase Sapphire's
 * +$100.00 payment (posted 2026-07-01, transacted and printed 06/30) lost its
 * transfer link and its note to a version bump of 20260702-statements-9805-.pdf,
 * and Chase Checking's −$100.00 was left grouped with a superseded row while
 * `ledger-check` exited 0 (measured on a copy of the real ledger, 2026-09-15).
 * Exact days only, never a window: a window would hand one charge's work to a
 * neighbouring charge of the same amount. `minScore` 1 claims only a row whose
 * words describe the same charge — for a record ANY later import may claim
 * (`recallPool`), not only the same file's next read.
 */
function takeCarry(pool: CarryPool, accountId: string, t: CanonicalTxn, hash: string, minScore = 0): CarryRow | null {
  const incoming = normalizeDescription(t.rawDescription);
  const claim = (bucket: readonly CarryRow[] | undefined): CarryRow | null => {
    const open = (bucket ?? [])
      .filter((row) => !pool.taken.has(row.id))
      .map((row) => ({
        row,
        // an unchanged dedupe hash is proof of the same parsed row
        score: row.dedupeHash === hash ? 4 : descriptionScore(row.normalizedDescription, incoming),
      }))
      .filter((c) => c.score >= minScore);
    if (open.length === 0) return null;
    const winner = open.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))[0]!.row;
    pool.taken.add(winner.id);
    return winner;
  };
  const posted = claim(pool.byPosted.get(carryKey(accountId, t.postedOn, t.amountCents)));
  if (posted !== null || t.transactedOn === undefined) return posted;
  return claim(pool.byTransacted.get(carryKey(accountId, t.transactedOn, t.amountCents)));
}

/**
 * Stamp carried attributes onto a row THIS file just inserted (it owns the row,
 * so a full overwrite is safe and idempotent). An engine's category is not
 * stamped here: `insertTxn` wrote it with the row, against the parser's own
 * (`engineCategoryCarry`).
 */
function applyCarry(tx: AppDatabase, txnId: string, carry: CarryAttributes): void {
  tx.update(transactions)
    .set({
      ...(isHandCategory(carry)
        ? {
            categoryId: carry.categoryId,
            categorizationSource: "user" as const,
            categorizationConfidence: carry.categorizationConfidence,
            merchantId: carry.merchantId,
            needsReview: false,
          }
        : {}),
      notes: carry.notes,
      // a self-group (user-marked transfer with no counterparty) keeps pointing
      // at the retired row's id — still a valid marker, and analytics must never
      // drop a row merely for carrying a group id
      transferGroupId: carry.transferGroupId,
      recurringSeriesId: carry.recurringSeriesId,
      // …and a detach travels as a detach (see `isDetach`)
      seriesLinkSource: carriedLinkSource(carry),
      // an attached row's successor stays attached (see `CarryAttributes`)
      fileLinkSource: carry.fileLinkSource,
      // a user-excluded row stays excluded — a re-parse must not resurrect it
      ...(carry.status === "excluded" ? { status: "excluded" as const } : {}),
    })
    .where(eq(transactions.id, txnId))
    .run();
}

/**
 * Re-attach carried attributes to a row that ALREADY existed (this file's row
 * deduped against another source's). Fill-only: an attribute already set on the
 * survivor wins, so a user category is never downgraded or overwritten.
 */
function fillFromCarry(tx: AppDatabase, existing: typeof transactions.$inferSelect, carry: CarryAttributes): void {
  const set: Partial<typeof transactions.$inferInsert> = {};
  if (isHandCategory(carry) && existing.categorizationSource !== "user") {
    set.categoryId = carry.categoryId;
    set.categorizationSource = "user";
    set.categorizationConfidence = carry.categorizationConfidence;
    set.merchantId = existing.merchantId ?? carry.merchantId;
    set.needsReview = false;
  }
  if (existing.categorizationSource !== "user" && set.categoryId === undefined) {
    const engine = engineCategoryCarry(carry);
    // Claude's fills an uncategorized survivor; detection's comes with the group it fills below
    const fills =
      (engine === "fill" && existing.categoryId === null) ||
      (engine === "overwrite" && existing.transferGroupId === null);
    if (fills) Object.assign(set, engineCategoryColumns(carry), { merchantId: existing.merchantId ?? carry.merchantId });
  }
  if (existing.notes === null && carry.notes !== null) set.notes = carry.notes;
  if (existing.transferGroupId === null && carry.transferGroupId !== null) {
    set.transferGroupId = carry.transferGroupId;
  }
  if (existing.recurringSeriesId === null && carry.recurringSeriesId !== null) {
    set.recurringSeriesId = carry.recurringSeriesId;
    set.seriesLinkSource = carry.seriesLinkSource;
  }
  // a detach fills a survivor nobody has linked or detached (see `isDetach`)
  if (existing.recurringSeriesId === null && existing.seriesLinkSource === null && isDetach(carry)) {
    set.seriesLinkSource = "user";
  }
  if (Object.keys(set).length === 0) return;
  tx.update(transactions).set(set).where(eq(transactions.id, existing.id)).run();
}

/**
 * Move the carried row's splits onto its successor. migrateSplits stamps the
 * source parent's category onto the destination, so a row that is NOT freshly
 * ours keeps its own work: a user category or an existing split there outranks
 * anything we could bring. The parent/parts invariant survives either way —
 * successor and carry match on amount by construction, so the parts still sum.
 */
function adoptCarriedSplits(
  tx: AppDatabase,
  carry: CarryRow,
  target: typeof transactions.$inferSelect,
  targetIsFresh: boolean,
): void {
  if (!targetIsFresh) {
    if (target.categorizationSource === "user") return;
    if ((splitCountsByTxn(tx, [target.id]).get(target.id) ?? 0) > 0) return;
  }
  if (carry.splits !== undefined) restoreRememberedSplits(tx, carry.splits, target.id);
  else migrateSplits(tx, carry.id, target.id);
}

/** The live (non-superseded) row for an account's dedupe hash, if it exists. */
function liveRowByHash(
  tx: AppDatabase,
  accountId: string,
  hash: string,
): typeof transactions.$inferSelect | undefined {
  return tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.dedupeHash, hash),
        ne(transactions.status, "superseded"),
      ),
    )
    .get();
}

/**
 * Land a claimed carry on whichever live row now represents this money (read
 * fresh, so any takeover migration that just ran is accounted for).
 * `fresh` — we inserted that row ourselves, so it is ours to stamp outright;
 * otherwise the row predates this file and only its EMPTY attributes fill in.
 * Returns false when nothing represents the money (the carry simply retires
 * with its superseded row). `onto` names the row that records the money when
 * no row has this line's hash: the row that absorbed the line.
 */
function landCarry(
  tx: AppDatabase,
  accountId: string,
  hash: string,
  carry: CarryRow,
  fresh: boolean,
  onto?: string,
): boolean {
  const target =
    liveRowByHash(tx, accountId, hash) ?? (onto === undefined ? undefined : tx.select().from(transactions).where(eq(transactions.id, onto)).get());
  if (!target) return false;
  adoptCarriedSplits(tx, carry, target, fresh);
  if (fresh) applyCarry(tx, target.id, carry);
  else fillFromCarry(tx, target, carry);
  // the row that now records the money is the one a duplicate verdict keeps
  moveKeptSide(tx, carry.id, target.id);
  // …and the one a transfer taken apart by an un-import waits by (`unimported-transfers`)
  moveWaitingLeg(tx, carry.id, target.id);
  return true;
}

function coveredRanges(db: AppDatabase, accountId: string): CoveredRange[] {
  const rows = db
    .select({
      importFileId: transactions.importFileId,
      format: importFiles.format,
      parserProfile: importFiles.parserProfile,
      minDay: min(transactions.postedOn),
      maxDay: max(transactions.postedOn),
    })
    .from(transactions)
    .innerJoin(importFiles, eq(transactions.importFileId, importFiles.id))
    .where(
      and(
        eq(transactions.accountId, accountId),
        inArray(transactions.status, ["active", "quarantined", "excluded"]),
        inArray(importFiles.status, ["parsed", "parsed_with_claude"]),
      ),
    )
    .groupBy(transactions.importFileId)
    .all();
  const fromTxns = rows
    .filter((r) => r.importFileId && r.minDay && r.maxDay)
    .map((r) => ({
      importFileId: r.importFileId!,
      priority: fidelityOf(r.format, r.parserProfile),
      minDay: r.minDay!,
      maxDay: r.maxDay!,
    }));

  // declared ranges (OFX DTSTART/DTEND, statement periods) extend coverage
  // beyond the observed transaction span — schema.md covered-range rule
  const declared = db
    .select({
      importFileId: statementPeriods.importFileId,
      format: importFiles.format,
      parserProfile: importFiles.parserProfile,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
    })
    .from(statementPeriods)
    .innerJoin(importFiles, eq(statementPeriods.importFileId, importFiles.id))
    .where(
      and(
        eq(statementPeriods.accountId, accountId),
        inArray(importFiles.status, ["parsed", "parsed_with_claude"]),
      ),
    )
    .all();
  const byFile = new Map<string, CoveredRange>();
  for (const r of [...fromTxns, ...declared.map((d) => ({
    importFileId: d.importFileId,
    priority: fidelityOf(d.format, d.parserProfile),
    minDay: d.periodStart,
    maxDay: d.periodEnd,
  }))]) {
    const existing = byFile.get(r.importFileId);
    if (!existing) byFile.set(r.importFileId, { ...r });
    else {
      existing.minDay = existing.minDay < r.minDay ? existing.minDay : r.minDay;
      existing.maxDay = existing.maxDay > r.maxDay ? existing.maxDay : r.maxDay;
    }
  }
  return [...byFile.values()];
}

/** The other files whose coverage includes `day`. */
function rangesCovering(ranges: readonly CoveredRange[], day: string): CoveredRange[] {
  return ranges.filter((r) => day >= r.minDay && day <= r.maxDay);
}

/**
 * The accounts the ledger already tracks — the last four digits a profile can
 * match an account number against, and the type it routes that account by — for
 * a file that carries several accounts and must parse only the tracked ones. An
 * account with no last4 cannot be matched by number and is left out.
 */
export function parseContextFor(db: AppDatabase, rereading: ReadonlySet<string> = new Set()): ParseContext {
  const tracked = db
    .select({ id: accounts.id, institution: institutions.name, last4: accounts.last4, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .all();
  // a number an account's statements printed before its current one is that account's too (`account-numbers`)
  const byId = new Map(tracked.map((r) => [r.id, r]));
  const earlier = formerNumbers(db).flatMap(({ accountId, last4 }) => {
    const account = byId.get(accountId);
    return account === undefined ? [] : [{ ...account, last4 }];
  });
  const rows = [...tracked, ...earlier];
  // a cash account's brokerage book, by the stored link — what a section's positions are proven against
  const books = bookEventsByCashAccount(db);
  // …and the cash account's statements that stand on no book — a positions month is never written under one
  const readAsCash = cashOnlyStatementsByAccount(db, rereading);
  const knownAccounts: Partial<Record<AccountHint["institution"], KnownAccount[]>> = {};
  for (const r of rows) {
    if (r.last4 === null) continue;
    const institution = r.institution as AccountHint["institution"];
    const events = books.get(r.id);
    const cashOnly = readAsCash.get(r.id);
    knownAccounts[institution] = [
      ...(knownAccounts[institution] ?? []),
      {
        last4: r.last4,
        type: r.type,
        subtype: r.subtype,
        ...(events === undefined ? {} : { book: { events } }),
        ...(cashOnly === undefined ? {} : { cashOnlyStatements: cashOnly }),
      },
    ];
  }
  return { knownAccounts, equityAssetTypes: equityAssetTypesOf(db) };
}

type AccountRow = typeof accounts.$inferSelect;

/** The institution a hint names; an unknown one is a parser defect. */
function institutionIdOf(db: AppDatabase, hint: AccountHint): string {
  const institution = db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.name, hint.institution))
    .get();
  if (!institution) throw new Error(`Unknown institution ${hint.institution}`);
  return institution.id;
}

/**
 * The account a hint names, read-only: `preferred` when the hint's preferred account exists (it is never upgraded).
 * The one matching rule for `resolveAccount` and for a read that must not create or change an account. A book's hint
 * (`bookOf`) is not matched here: a book is found by the stored link alone (`findBook`, `resolveBook`).
 */
function matchAccount(db: AppDatabase, hint: AccountHint): { institutionId: string; found?: AccountRow; preferred?: AccountRow } {
  const institutionId = institutionIdOf(db, hint);
  const all = db.select().from(accounts).where(eq(accounts.institutionId, institutionId)).all();
  // an existing preferred account (the P0.1 settlement-cash ledger) wins over
  // type matching; absent, the hint resolves exactly as before
  if (hint.preferName) {
    const preferred = all.find((a) => a.name === hint.preferName);
    if (preferred) return { institutionId, preferred };
  }
  const typeMatch = (a: (typeof all)[number]) =>
    hint.type !== undefined && a.type === hint.type && (hint.subtype === undefined || a.subtype === hint.subtype);

  let found = hint.last4 ? all.find((a) => a.last4 === hint.last4) : undefined;
  if (!found && hint.last4) {
    // a card reissued under a new number: its earlier statements print the old one (`account-numbers`)
    const formerly = accountsFormerlyNumbered(db, all.map((a) => a.id), hint.last4);
    if (formerly.length === 1) found = all.find((a) => a.id === formerly[0]);
  }
  if (!found && !hint.last4) {
    // files without account numbers (Discover CSV, Robinhood activity, SoFi)
    found = all.find(typeMatch);
  }
  if (!found && hint.last4) {
    // adopt: an account created from a numberless file learns its last4 now —
    // never create a duplicate for the same real-world account
    found = all.find((a) => a.last4 === null && typeMatch(a));
  }
  return { institutionId, found };
}

/** The account `resolveAccount` would file a hint under, or null where it would create one — read-only. */
export function findAccountId(db: AppDatabase, hint: AccountHint): string | null {
  if (hint.bookOf !== undefined) return findBook(db, institutionIdOf(db, hint), hint.bookOf);
  const { found, preferred } = matchAccount(db, hint);
  return (preferred ?? found)?.id ?? null;
}

/** Resolve (or create/upgrade) the account a parsed statement belongs to. */
export function resolveAccount(db: AppDatabase, hint: AccountHint): string {
  // a cash account's brokerage book: by the stored link, never by name or type — see ./brokerage-book.ts
  if (hint.bookOf !== undefined) return resolveBook(db, institutionIdOf(db, hint), hint.bookOf);
  const { institutionId, found, preferred } = matchAccount(db, hint);
  if (preferred) return preferred.id;
  if (found) {
    // upgrade auto-created stubs when a richer hint arrives (PDF names, OFX types)
    const isStub = /·{4}|\*{4}/.test(found.name);
    const updates: Partial<{ name: string; type: typeof found.type; last4: string | null }> = {};
    if (isStub && hint.name) updates.name = hint.name;
    if (isStub && hint.type && hint.type !== found.type) updates.type = hint.type;
    if (found.last4 === null && hint.last4) updates.last4 = hint.last4;
    if (Object.keys(updates).length > 0) {
      db.update(accounts).set(updates).where(eq(accounts.id, found.id)).run();
    }
    return found.id;
  }

  const created = db
    .insert(accounts)
    .values({
      institutionId,
      name: hint.name ?? `${hint.institution} ····${hint.last4 ?? "????"}`,
      type: hint.type ?? "checking",
      subtype: hint.subtype ?? null,
      last4: hint.last4 ?? null,
    })
    .returning({ id: accounts.id })
    .get();
  return created.id;
}

function categoryIdForPath(db: AppDatabase, pathStr: string): string | null {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) return null;
  if (!subName) return parent.id;
  return (
    db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
      .get()?.id ?? null
  );
}

/**
 * Root of the per-account statement archive. MONEYAPP_ORIGINALS_DIR stays the
 * override (keeps the e2e harness + unit tests off the user's real archive); the
 * default relocated from data/originals to data/statements, and every original
 * now lives under a per-account subfolder (data/statements/<account-slug>/).
 */
function statementsRoot(): string {
  return process.env.MONEYAPP_ORIGINALS_DIR ?? path.join(process.cwd(), "data", "statements");
}

/** Writes an original into <root>/<folder>/, deduping on the content-hashed name. */
function archiveTo(folder: string, archiveName: string, buffer: Buffer): string {
  const dir = path.join(statementsRoot(), folder);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, archiveName);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
  return dest;
}

/**
 * Rename, falling back to copy+unlink across filesystems: renameSync throws
 * EXDEV when the archive root (MONEYAPP_ORIGINALS_DIR) sits on a different device
 * than the source, and an uncaught throw here would abort the whole import batch.
 */
function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(src, dest);
    fs.rmSync(src);
  }
}

/** Moves an already-archived original into its resolved per-account folder. */
function relocateArchive(src: string, folder: string, archiveName: string): string {
  const dest = path.join(statementsRoot(), folder, archiveName);
  if (dest === src) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    if (fs.existsSync(src)) moveFile(src, dest);
  } else if (fs.existsSync(src)) {
    fs.rmSync(src); // dest already holds this content hash — drop the transient dup
  }
  // sweep the transient institution staging dir if the relocation emptied it
  const srcDir = path.dirname(src);
  if (
    srcDir !== path.dirname(dest) &&
    srcDir.startsWith(statementsRoot()) &&
    fs.existsSync(srcDir) &&
    fs.readdirSync(srcDir).length === 0
  ) {
    fs.rmdirSync(srcDir);
  }
  return dest;
}

function accountWithInstitution(
  db: AppDatabase,
  accountId: string,
): { account: typeof accounts.$inferSelect; institutionName: string } {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
  const inst = db
    .select({ name: institutions.name })
    .from(institutions)
    .where(eq(institutions.id, account.institutionId))
    .get()!;
  return { account, institutionName: inst.name };
}

/**
 * The archive folder for a parsed file: the per-account slug for a single-account
 * file (the norm), an <institution>-combined bucket for a multi-account file
 * (SoFi combined, multi-account QFX), or the institution bucket as a fallback.
 */
function resolveArchiveFolder(db: AppDatabase, accountIds: string[], fallbackInstitution: string): string {
  if (accountIds.length === 1) {
    const { account, institutionName } = accountWithInstitution(db, accountIds[0]!);
    return accountSlug(account, institutionName);
  }
  if (accountIds.length > 1) {
    const { institutionName } = accountWithInstitution(db, accountIds[0]!);
    return `${institutionSlug(institutionName)}-combined`;
  }
  return institutionSlug(fallbackInstitution);
}

export interface ImportInput {
  name: string;
  buffer: Buffer;
}

export async function importStatementFiles(db: AppDatabase, files: ImportInput[]): Promise<FileOutcome[]> {
  // higher-fidelity formats first so ownership settles with minimal takeovers;
  // final state is order-independent, this just does less work
  const sniffed = files
    .map((f) => sniffFile(f.name, f.buffer))
    .sort((a, b) => FORMAT_PRIORITY[a.format] - FORMAT_PRIORITY[b.format] || a.name.localeCompare(b.name));
  const selected: { file: ReturnType<typeof sniffFile>; selection: ProfileSelection }[] = [];
  for (const file of sniffed) selected.push({ file, selection: await selectProfile(file) });

  const outcomes: FileOutcome[] = [];
  const batch = batchStateOf(
    db,
    oldestFirstWhereItMatters(selected).map(({ file, selection }) => ({ file, selection, sha: fileSha256(file.buffer) })),
  );
  // the files this call wrote rows under — the only rows linking may claim
  const { touchedAccounts, writtenFileIds } = batch;

  // each turn reads a file and every file it must be read with (`importTurn`), and takes those out of the queue — and a
  // turn that faults fails its own files only (`failedUnexpectedly`)
  for (let head = batch.pending.shift(); head !== undefined; head = batch.pending.shift()) {
    outcomes.push(...(await importTurn(db, head, batch)));
  }

  // A book this call left holding nothing — a re-read that no longer proves its month, a statement that failed after
  // its book was made — leaves, as an un-import's does: a first read that withheld the section never made one.
  for (const removed of removeEmptyBooks(db, [...touchedAccounts])) touchedAccounts.delete(removed);

  // A row an un-import detached is filed again under the statement that now
  // holds its day (`attached-rows`). Before the reconcile, so a gap holds it
  // with the file's own rows, as it did before the un-import — and this call
  // did not insert it, so the linking below may not claim it.
  const refiled = new Set(reattachDetachedRows(db, [...touchedAccounts]));
  // A transfer an un-import took apart is whole again once the lines it lost are back — before categorization and
  // detection read the returning legs as unpaired rows (`unimported-transfers`)
  relinkReturningTransfers(db, rowIdsOfFiles(db, writtenFileIds).filter((id) => !refiled.has(id)));
  for (const accountId of touchedAccounts) rebuildAccount(db, accountId);
  if (touchedAccounts.size > 0) {
    categorizeAll(db);
    detectTransfers(db);
    // read BEFORE the reconcile: the ones it promotes are this call's doing too
    const quarantinedBefore = quarantinedIdsOn(db, [...touchedAccounts]);
    // reconcile ALL periods of touched accounts again — later files can close
    // or open gaps in earlier files' periods (date-range membership)
    reconcileAccounts(db, [...touchedAccounts]);
    // AFTER the reconcile, because the reconcile decides which rows are active.
    // Only what this call inserted or promoted may be claimed (owner,
    // 2026-09-14); a row the reconcile quarantined is not active and waits for
    // its gap to be accepted, which links it then.
    linkRowsMadeActive(db, [...rowIdsOfFiles(db, writtenFileIds).filter((id) => !refiled.has(id)), ...quarantinedBefore]);
    // …and a series a record gave a link back to counts that charge again (`unimported-attributes`)
    settleSeriesStats(db, batch.givenBackSeries);
    for (const accountId of touchedAccounts) rebuildAccount(db, accountId);
    // AFTER the reconcile, never before — but NOT to catch the rows the
    // reconcile promotes. reconcileAccounts only promotes when the gap
    // recomputes to exactly 0, and it stamps `reconciled` in the same
    // statement; since its sum counts quarantined rows too, with no file
    // filter, a period that closes to 0 provably holds no double count and
    // flagDuplicateCandidates correctly exempts every row in it.
    //
    // It runs here because the reconcile is the last thing that MOVES rows in
    // or out of replay, so this is the first moment the ledger is settled
    // enough to ask the question at all — for rows in `accepted` periods, in
    // `not_applicable` periods, and in no period. Running it before the
    // reconcile (as the pass it replaces did) asked the question of a ledger
    // that was still being rearranged.
    flagDuplicateCandidates(db, [...touchedAccounts]);
  }
  return outcomes;
}

/**
 * First match in registry order still wins — but a profile may add a content
 * gate (`matchesContent`) for formats whose filename cannot identify them.
 * Chase ships checking and credit-card statements under the same download
 * name, so the filename genuinely cannot decide between them; the text can.
 * The document is extracted at most once, and only when some candidate asks
 * for it, so files with an unambiguous filename cost nothing extra.
 */
interface ProfileSelection {
  readonly profile: ParserProfile | undefined;
  readonly unreadable: boolean;
  /** the text the content gates read — the file's own text, or a PDF's extraction when a gate asked for it */
  readonly content: string;
}

async function selectProfile(file: ReturnType<typeof sniffFile>): Promise<ProfileSelection> {
  const candidates = PROFILES.filter((p) => p.matches(file));
  if (candidates.length === 0) return { profile: undefined, unreadable: false, content: file.text };
  if (!candidates.some((p) => p.matchesContent)) return { profile: candidates[0], unreadable: false, content: file.text };

  let content = file.text;
  if (file.format === "pdf") {
    try {
      content = (await extractLines(file.buffer)).map((l) => l.text).join("\n");
    } catch {
      content = ""; // unreadable PDF — gates fail closed, reported below
    }
  }
  return {
    profile: candidates.find((p) => (p.matchesContent ? p.matchesContent(content) : true)),
    // a scanned/image-only statement is a different problem with a different
    // fix than one whose text simply matched no known layout — say which
    unreadable: file.format === "pdf" && content.trim() === "",
    content,
  };
}

/**
 * The batch in its import order, with the files of a profile that declares `orderKey` put OLDEST first among the
 * places those files already held — every other file keeps its place.
 *
 * 🔴 A Robinhood brokerage statement's brokerage-book positions are proven by what the book held BEFORE the period.
 * Robinhood names its files with UUIDs, so a September named b7d4e2f1… imported before an August named d41f0c83…,
 * found no August shares to be proven by, and was withheld — and a withheld month is read again only by a version
 * bump (agentic-book.test.ts). A key the profile cannot read leaves the file where the name put it.
 */
function oldestFirstWhereItMatters<T extends { file: ReturnType<typeof sniffFile>; selection: ProfileSelection }>(batch: readonly T[]): T[] {
  const keyOf = (item: T): string | null => item.selection.profile?.orderKey?.(item.selection.content) ?? null;
  const keyed = batch.flatMap((item, at) => {
    const key = keyOf(item);
    return key === null ? [] : [{ item, at, key }];
  });
  const byKey = [...keyed].sort((a, b) => a.key.localeCompare(b.key) || a.item.file.name.localeCompare(b.item.file.name));
  const ordered = [...batch];
  keyed.forEach(({ at }, i) => {
    ordered[at] = (byKey[i] as (typeof byKey)[number]).item;
  });
  return ordered;
}

/**
 * Whether an account's statement periods must close to the cent. Every type but
 * `investment`, whose periods are value anchors — `periodVerdict` books their
 * residual as market change. The reconcile and the importer's placement below
 * ask this one rule.
 */
function periodsMustClose(account: { readonly type: string }): boolean {
  return account.type !== "investment";
}

/** One parsed row as the statement prints it, and as the ledger stores it. */
interface PlacedTxn {
  printed: CanonicalTxn;
  stored: CanonicalTxn;
}

/**
 * 🔴 A statement lists the rows that POSTED in its period, but a card statement
 * prints each row's TRANSACTION day. A charge made on a cycle's last day posts
 * after it closes, so the next statement prints it dated before that statement
 * opens. Stored on the printed day it fell in the previous period — where
 * `reconcileAccounts` counts it by posted_on — and broke both. Pass 38
 * (2026-08-05) moved Chase Sapphire's four such rows onto their opening day as
 * data and left this path alone, so every re-read put them back: forcing a
 * version re-parse of the 21 Sapphire statement files on a copy of the ledger
 * (2026-09-15) sent 5 periods to `gap` and quarantined 47 rows, in either file
 * order. The chase-card parser dates 87 of 2,058 rows before their period;
 * every other statement profile, 0 of 9,475 (Discover's parser already clamps).
 *
 * The stored row posts on `postedInsidePeriod`, keeping the printed day as its
 * transaction day. The printed row is kept too, because a search for ANOTHER
 * record of the same money (identity, takeover victim, carry) must look on the
 * day the file prints: pass 38 measured that the identity match's posted lens,
 * blind to descriptions, would hand LA GAVIOTA DELI GROCERY's
 * charge to NEW BEST GOURMET DELI's on the opening day.
 *
 * Ownership is the one decision that reads the stored row. It asks which source
 * covers the day the row POSTED, and read on the printed day it was wrong both
 * ways: an export that closed on the previous statement's close day owned the
 * charge it cannot hold and dropped it, so the period gapped; and an export
 * that opened on the posting day did not own the charge it does hold, so the
 * statement recorded it a second time.
 *
 * ⚠️ Known limit: a straddler whose printed day and amount equal a DIFFERENT
 * charge the previous statement closed with consumes that row's identity slot
 * and is never stored, so its own period gaps. It is not in the Sapphire data
 * (docs/sapphire-reconciliation-finding.md §5).
 *
 * Only periods that must close to the cent: an investment statement's dates are
 * trade and settle days, and its period absorbs what moves as market change.
 */
function placeInsidePeriod(statement: ParsedStatement, periodMustClose: boolean): PlacedTxn[] {
  const { period } = statement;
  return statement.txns.map((printed) => {
    if (!period || !periodMustClose) return { printed, stored: printed };
    const postedOn = postedInsidePeriod(printed.postedOn, period);
    if (postedOn === printed.postedOn) return { printed, stored: printed };
    return { printed, stored: { ...printed, postedOn, transactedOn: printed.transactedOn ?? printed.postedOn } };
  });
}

/** A printed row, the row as the ledger stores it, and the identity it is stored under. */
export interface StoredLine {
  printed: CanonicalTxn;
  stored: CanonicalTxn;
  occurrenceIndex: number;
  /** `dedupe_hash`: the STORED posted day with the PRINTED amount and text */
  hash: string;
}

/**
 * Every row a statement prints, placed, numbered and hashed exactly as `writeMember` stores it. ONE rule: a
 * write that must give a ledger row the identity the parser gives its printed line asks this, rather than
 * restating `placeInsidePeriod`, the occurrence numbering and which fields the hash reads
 * (scripts/redate-sapphire-0630-payment-2026-09-15.ts).
 */
export function storedLines(accountId: string, account: { readonly type: string }, statement: ParsedStatement): StoredLine[] {
  // the hash and the occurrence index describe the row as STORED, so both
  // are computed on the day it posts
  return assignOccurrenceIndexes(placeInsidePeriod(statement, periodsMustClose(account)), ({ stored }) => ({
    accountId,
    postedOn: stored.postedOn,
    amountCents: stored.amountCents,
    rawDescription: stored.rawDescription,
  })).map(({ row: { printed, stored }, occurrenceIndex }) => ({
    printed,
    stored,
    occurrenceIndex,
    hash: dedupeHash({
      accountId,
      postedOn: stored.postedOn,
      amountCents: printed.amountCents,
      rawDescription: printed.rawDescription,
      occurrenceIndex,
    }),
  }));
}

/**
 * What a statement prints on an account, as `statement_copies.lines` records it (`recordStatementCopy`): each line as
 * stored, in the columns an import matches a line by. ONE rule for the import that adopts another file's period and
 * for the script that records the copies imported before the table existed (scripts/record-statement-copies.ts).
 */
export function statementCopyLines(lines: readonly StoredLine[]): DuplicatePairSide[] {
  return lines.map(({ stored }) => writtenSide(stored));
}

/**
 * A file already imported at the parser version reading it now is skipped as a duplicate — unless its row is
 * one of these. Exported so a write that must know "would the import read this file again?" asks this rule
 * rather than restating it (scripts/robinhood-agentic-account.ts).
 */
export const REIMPORTABLE_STATUSES: readonly ImportStatus[] = ["superseded", "failed"];

/** The reads of these bytes in place under an older parser version — what a read at `version` retires. */
function retiredReadsOf(db: AppDatabase, sha: string, version: number): (typeof importFiles.$inferSelect)[] {
  return db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileSha256, sha), inArray(importFiles.status, ["parsed", "parsed_with_claude"])))
    .all()
    .filter((f) => f.parserVersion < version);
}

/** What a re-read that fails adds to its cause: it retired nothing. */
const EARLIER_READ_KEPT = "nothing was changed; the earlier read of this file is still in place";
/** …and what a first read that fails inside a read of several files adds: it wrote nothing. */
const NOTHING_WRITTEN = "nothing was written";

/** One file of a call, with the bytes it is known by. */
interface BatchItem {
  readonly file: ReturnType<typeof sniffFile>;
  readonly selection: ProfileSelection;
  readonly sha: string;
}

interface BatchState {
  readonly touchedAccounts: Set<string>;
  readonly writtenFileIds: Set<string>;
  /** the recurring series a record gave a link back to (`MemberWrite.series`) */
  readonly givenBackSeries: Set<string>;
  /** the reads each file of this call retires, by its bytes: its reads in place under an older parser version */
  readonly staleBySha: ReadonlyMap<string, readonly string[]>;
  /** …and the bytes of each such read */
  readonly shaOfStale: ReadonlyMap<string, string>;
  /** the files whose turn has not come yet, in import order — a read takes the files it needs from here */
  readonly pending: BatchItem[];
}

function batchStateOf(db: AppDatabase, items: readonly BatchItem[]): BatchState {
  const staleBySha = new Map<string, readonly string[]>();
  for (const { selection, sha } of items) {
    if (!selection.profile) continue;
    const stale = retiredReadsOf(db, sha, selection.profile.version).map((f) => f.id);
    if (stale.length > 0) staleBySha.set(sha, stale);
  }
  return {
    touchedAccounts: new Set(),
    writtenFileIds: new Set(),
    givenBackSeries: new Set(),
    staleBySha,
    shaOfStale: new Map([...staleBySha].flatMap(([sha, ids]) => ids.map((id) => [id, sha] as const))),
    pending: [...items],
  };
}

/** Every later book statement of these files but themselves, newest first — each names ALL the later ones on its books. */
function laterStatementsOf(db: AppDatabase, fileIds: readonly string[]): LaterBookStatement[] {
  const found = fileIds.flatMap((id) => laterBookStatements(db, id)).filter((l) => !fileIds.includes(l.importFileId));
  return [...new Map(found.map((l) => [l.importFileId, l])).values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

/** The row a file's read is recorded under, and where its original was archived. */
interface RecordedFile {
  readonly row: typeof importFiles.$inferSelect;
  readonly institutionName: string;
  readonly archiveName: string;
  readonly currentPath: string;
}

/**
 * One file of a READ — the files one turn of an import reads together, all or nothing (`importTurn`). Filled in as the
 * turn goes: recorded once its parse context is known, parsed after that.
 */
interface ReadMember {
  readonly item: BatchItem;
  /** the row of an earlier attempt at this read that failed or was retired — reused, never duplicated */
  readonly existing: typeof importFiles.$inferSelect | undefined;
  /** the file's reads under an older parser version — what writing it retires */
  readonly staleIds: readonly string[];
  /** the files this read must take with it: the later statements on the books its older reads wrote */
  readonly laterShas: readonly string[];
  recorded?: RecordedFile;
  parsed?: { readonly statements: readonly ParsedStatement[]; readonly withheld: readonly WithheldOutcome[] };
  /** the files whose older cash-only reads its positions were proven without (`reliedShas`) */
  reliedShas: readonly string[];
}

/** Where a read stopped: the member that failed, what its outcome says, and what its row records. */
interface ReadFailure {
  readonly at: number;
  readonly outcomeError: string;
  readonly recordedError?: string;
}

const blankOutcome = (fileName: string): FileOutcome => ({
  fileName,
  status: "parsed",
  withheld: [],
  inserted: 0,
  deduped: 0,
  dedupedCrossFormat: 0,
  skippedOwned: 0,
  supersededTakeover: 0,
  carriedForward: 0,
  givenBack: 0,
  keptByPrinters: 0,
  quarantined: 0,
  periods: [],
});

/** What a member that failed on its own says it kept. */
const keptBy = (member: ReadMember): string => (member.staleIds.length > 0 ? EARLIER_READ_KEPT : NOTHING_WRITTEN);

/**
 * A file's turn opened: skipped as a duplicate, or a member of the read — with the reason it is refused, if it is.
 * Nothing is written either way.
 *
 * ⛔ A brokerage book's months come off newest first (`laterBookStatements`). A later statement on a book the file's
 * older read wrote is read in the same turn when this call re-reads it too; one it does not re-read refuses the re-read,
 * because a re-read that did not give the shares back would leave that statement's sale short. So does one this call
 * DID upload whose own turn already came and went: its re-read failed or was refused, its older read is in place, and
 * that read stands on the shares this one would take away.
 */
function openMember(
  db: AppDatabase,
  item: BatchItem,
  batch: BatchState,
  chain: readonly ReadMember[],
): { skipped: FileOutcome } | { member: ReadMember; refusal: string | null } {
  const { profile } = item.selection;
  const existing = db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileSha256, item.sha), eq(importFiles.parserVersion, profile?.version ?? 0)))
    .get();
  if (existing && !REIMPORTABLE_STATUSES.includes(existing.status)) {
    return { skipped: { ...blankOutcome(item.file.name), status: "skipped_duplicate" } };
  }
  const staleIds = profile ? retiredReadsOf(db, item.sha, profile.version).map((f) => f.id) : [];
  const later = laterStatementsOf(db, staleIds);
  const waiting = (staleId: string): string | undefined => {
    const sha = batch.shaOfStale.get(staleId);
    if (sha === undefined) return undefined;
    return batch.pending.some((i) => i.sha === sha) || chain.some((m) => m.item.sha === sha) ? sha : undefined;
  };
  const unread = later.filter((l) => waiting(l.importFileId) === undefined);
  const member: ReadMember = {
    item,
    existing,
    staleIds,
    laterShas: [...new Set(later.flatMap((l) => waiting(l.importFileId) ?? []))],
    reliedShas: [],
  };
  const uploaded = new Set(batch.shaOfStale.keys());
  return { member, refusal: unread.length === 0 ? null : laterStatementsRefusal(unread, profile?.version, uploaded) };
}

/** The reads this call has yet to retire — the files still waiting for their turn, and the members of this one. */
function rereadingIds(batch: BatchState, chain: readonly ReadMember[]): Set<string> {
  return new Set([...batch.pending, ...chain.map((m) => m.item)].flatMap((i) => batch.staleBySha.get(i.sha) ?? []));
}

/** Every older read a read retires, newest first: its members' own, the last member's first. */
function retirementOf(chain: readonly ReadMember[]): string[] {
  return [...chain].reverse().flatMap((m) => m.staleIds);
}

/**
 * Take into the read, in import order, the waiting files it needs (`laterShas`, `reliedShas`) — and every waiting file
 * of the same parser before the last of them, the months in between, so each month is read on the ones before it.
 * Returns where the read stops if a file it takes is refused.
 */
function pullNeeded(db: AppDatabase, batch: BatchState, chain: ReadMember[], skipped: FileOutcome[]): ReadFailure | null {
  const profileId = chain[0]?.item.selection.profile?.id;
  for (;;) {
    const inChain = new Set(chain.map((m) => m.item.sha));
    const needed = new Set(chain.flatMap((m) => [...m.laterShas, ...m.reliedShas]).filter((sha) => !inChain.has(sha)));
    if (needed.size === 0) return null;
    const lastNeeded = batch.pending.findLastIndex((i) => needed.has(i.sha));
    const at = batch.pending.findIndex((i, n) => n <= lastNeeded && (needed.has(i.sha) || i.selection.profile?.id === profileId));
    if (at === -1) return { at: 0, outcomeError: `the files this one is read with are no longer in the upload (${keptBy(chain[0] as ReadMember)})` };
    const [item] = batch.pending.splice(at, 1) as [BatchItem];
    const opened = openMember(db, item, batch, chain);
    if ("skipped" in opened) {
      skipped.push(opened.skipped);
      continue;
    }
    chain.push(opened.member);
    if (opened.refusal !== null) return { at: chain.length - 1, outcomeError: opened.refusal };
  }
}

/** Thrown to roll back a transaction that only reads the ledger as a read would leave it. */
class DryRun extends Error {}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The ledger member `k` of a read is parsed against: every older read the read retires, retired, and the members before
 * it written — in a transaction that is always rolled back, so nothing is written. A write that fails there stops the
 * read at the member that wrote it; a retirement that would walk a book below zero refuses member `k`
 * (`NegativePositionError`).
 *
 * The book events the retired reads wrote are not what a member is proven by — kept, a re-read's own trades would read
 * as a second copy of its month; and a later month is proven by the months before it, as they are read now.
 */
function contextFor(db: AppDatabase, chain: readonly ReadMember[], k: number, rereading: ReadonlySet<string>): { context: ParseContext } | ReadFailure {
  const retiring = retirementOf(chain);
  if (k === 0 && retiring.length === 0) return { context: parseContextFor(db, rereading) };
  let stage = -1;
  let context: ParseContext | undefined;
  try {
    db.transaction((tx) => {
      const dry = { writes: [] as MemberWrite[], series: new Set<string>() };
      writeRead(tx, chain.slice(0, k), retiring, (j) => {
        stage = j;
      }, dry.writes, dry.series);
      context = parseContextFor(tx, rereading);
      throw new DryRun();
    });
  } catch (error: unknown) {
    if (!(error instanceof DryRun)) {
      if (stage >= 0) {
        const failed = chain[stage] as ReadMember;
        return { at: stage, outcomeError: messageOf(error), recordedError: `Failed mid-import (${keptBy(failed)}): ${messageOf(error)}` };
      }
      if (error instanceof NegativePositionError) return { at: k, outcomeError: error.message };
      throw error;
    }
  }
  if (context === undefined) throw new Error("the dry run of a read's retirement read nothing");
  return { context };
}

/** Record the file's read: the row it is known by, and its original archived. Before its parse, after its refusals. */
function recordFile(db: AppDatabase, member: ReadMember): RecordedFile {
  if (member.recorded) return member.recorded;
  const { existing } = member;
  const { file, sha, selection } = member.item;
  const { profile } = selection;
  const institution = guessInstitution(db, file);
  // basename neutralizes traversal; truncation + control-strip neutralizes
  // pathological names (ENAMETOOLONG would abort the batch)
  const safeName = path
    .basename(file.name)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, 80);
  const archiveName = `${sha.slice(0, 16)}-${safeName}`;
  // archive into the institution bucket first — the correct resting place for a
  // parse failure; a successful single-account parse relocates it to the
  // per-account folder once the account is known. A re-parse keeps the physical
  // file wherever the prior import left it.
  const currentPath = existing ? existing.storagePath : archiveTo(institutionSlug(institution.name), archiveName, file.buffer);
  const row =
    existing ??
    db
      .insert(importFiles)
      .values({
        fileName: file.name,
        fileSha256: sha,
        format: file.format,
        institutionId: institution.id,
        parserProfile: profile?.id ?? null,
        parserVersion: profile?.version ?? 0,
        status: "failed",
        storagePath: currentPath,
        importedAt: new Date().toISOString(),
      })
      .returning()
      .get();
  const recorded = { row, institutionName: institution.name, archiveName, currentPath };
  member.recorded = recorded;
  return recorded;
}

/**
 * The files whose older cash-only reads a member's positions were proven WITHOUT: later statements of the cash
 * account its book is paired with, left out of its parse context because this call reads them again
 * (`cashOnlyStatementsByAccount`). They are read with it — a month is proven under a later month read as cash only
 * only because that month is about to be read again.
 */
function reliedShas(db: AppDatabase, batch: BatchState, statements: readonly ParsedStatement[], rereading: ReadonlySet<string>): string[] {
  const shas = new Set<string>();
  for (const statement of statements) {
    const { positions, accountHint } = statement;
    const end = statement.period?.end ?? statement.declaredRange?.end ?? statement.ledger?.asOf;
    if (!positions || accountHint.bookOf === undefined || end === undefined) continue;
    const cash = db
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
      .where(and(eq(institutions.name, accountHint.institution), eq(accounts.last4, accountHint.bookOf), eq(accounts.type, "checking")))
      .all();
    for (const read of cash.length === 1 ? cashOnlyReadsOn(db, (cash[0] as { id: string }).id) : []) {
      const sha = batch.shaOfStale.get(read.importFileId);
      if (read.end > end && rereading.has(read.importFileId) && sha !== undefined) shas.add(sha);
    }
  }
  return [...shas];
}

/** Parse member `k` of a read against the ledger the read leaves before it, and take in the files it needs. */
async function readMember(db: AppDatabase, batch: BatchState, chain: ReadMember[], k: number, skipped: FileOutcome[]): Promise<ReadFailure | null> {
  const member = chain[k] as ReadMember;
  const { file, selection } = member.item;
  const { profile, unreadable } = selection;
  const rereading = rereadingIds(batch, chain);
  const planned = contextFor(db, chain, k, rereading);
  if ("at" in planned) return planned;
  const { row } = recordFile(db, member);

  if (!profile) {
    const message = unreadable
      ? "No text could be extracted — this looks like a scanned or image-only PDF"
      : "No parser profile matched this file";
    return { at: k, outcomeError: message };
  }
  try {
    const { statements, withheld } = asParsedFile(await profile.parse(file, planned.context));
    // named BEFORE anything is written, and read-only — a section that was not imported must not change which accounts exist
    member.parsed = { statements, withheld: withheld.map((section) => withheldOutcome(db, section)) };
  } catch (error: unknown) {
    const cause = error instanceof ParseError ? error.message : `Unexpected: ${String(error)}`;
    // nothing has been retired yet: the read this version would replace is still the one in place
    const message = member.staleIds.length > 0 ? `${cause} (${EARLIER_READ_KEPT})` : cause;
    db.update(importFiles).set({ parserProfile: profile.id }).where(eq(importFiles.id, row.id)).run();
    return { at: k, outcomeError: message };
  }
  member.reliedShas = reliedShas(db, batch, member.parsed.statements, rereading);
  return pullNeeded(db, batch, chain, skipped);
}

/**
 * A read that stopped at member `at`: it and every member before it fail — none of them wrote anything — and the
 * members after it wait for turns of their own, read on the older reads still in place.
 */
function failRead(db: AppDatabase, batch: BatchState, chain: readonly ReadMember[], failure: ReadFailure): FileOutcome[] {
  const failed = chain[failure.at] as ReadMember;
  const outcomes = chain.slice(0, failure.at + 1).map((member, j) => {
    const again = member.staleIds.length > 0 ? "again " : "";
    const error =
      j === failure.at
        ? failure.outcomeError
        : `${failed.item.file.name} failed, and this statement is read ${again}only together with it (${keptBy(member)})`;
    const recorded = j === failure.at ? (failure.recordedError ?? error) : error;
    if (member.recorded) {
      db.update(importFiles).set({ status: "failed", error: recorded }).where(eq(importFiles.id, member.recorded.row.id)).run();
    }
    return { ...blankOutcome(member.item.file.name), status: "failed" as const, error };
  });
  batch.pending.unshift(...chain.slice(failure.at + 1).map((m) => m.item));
  return outcomes;
}

/**
 * One turn of an import: the file whose turn it is, and every file it must be read WITH — all read, or none.
 *
 * Re-parse lifecycle (schema.md): a newer parser version retires the old version's entire contribution — AFTER the
 * new version has read the file, and in one transaction with everything it writes.
 *
 * 🔴 The retired read was superseded before the new version parsed, and each statement committed on its own. A
 * version that could not read the file, or failed part-way through it, had already taken the file's rows, periods
 * and anchors away — the rows the owner filed under it by hand with them — and uploading the bytes again or
 * un-importing the failed row brought none of it back. Measured on a copy of the real ledger, 2026-09-16: a throwing
 * re-read of the January 2026 Sapphire statement superseded its 4 attached payments ($1,223.54) and left the account
 * 8 rows and a period short.
 *
 * ⛔ A brokerage book's months are ONE read (`openMember`, `pullNeeded`):
 *  - a re-read of a month takes the later months on the same book that this call also re-reads, and the write
 *    retires them newest first, so a later month's sale never stands without the buy it sold;
 *  - a month proven under a later month read as cash only — left out of its parse context because this call reads
 *    that month again — takes that month (`reliedShas`);
 *  - and each takes the months of the same parser in between, so every month is proven by the ones before it as
 *    they are read now (`contextFor`).
 * If any of them cannot be read or written, none is. 🔴 Before, the earliest month's write retired the later ones and
 * each later month was read at its own turn: a September the new version could not read left August's re-read in
 * place and September's older read gone (measured 2026-09-16: Robinhood Agentic's Sep 30 from $12.70 anchored to $1.64
 * carried, the book from 0.15 to 0.25 WMT, the owner's note and filed row superseded for good); and an October that
 * could not be read kept its cash-only read over the August shares already written under it ($56.68 where $28.95 is
 * true).
 */
async function importTurn(db: AppDatabase, head: BatchItem, batch: BatchState): Promise<FileOutcome[]> {
  const chain: ReadMember[] = [];
  const skipped: FileOutcome[] = [];
  try {
    const opened = openMember(db, head, batch, []);
    if ("skipped" in opened) return [opened.skipped];
    chain.push(opened.member);
    // a refusal comes before anything is written, the file's row included: the file stays read at the version it was
    let failure: ReadFailure | null = opened.refusal === null ? pullNeeded(db, batch, chain, skipped) : { at: 0, outcomeError: opened.refusal };
    for (let k = 0; failure === null && k < chain.length; k++) failure = await readMember(db, batch, chain, k, skipped);
    return [...(failure === null ? writeTurn(db, batch, chain) : failRead(db, batch, chain, failure)), ...skipped];
  } catch (error: unknown) {
    // a fault outside the steps that report their own failure fails this turn's files, and the upload goes on
    const members = chain.length > 0 ? chain : [{ item: head, recorded: undefined }];
    return [...members.map((m) => failedUnexpectedly(db, m.item.file, m.recorded?.row.id, error)), ...skipped];
  }
}

/** What one member's write did: its tallies, and the accounts it resolved. */
interface MemberWrite {
  readonly tally: FileOutcome;
  readonly accounts: Set<string>;
  /** the recurring series a record gave a link back to — their stats settle once the batch has (`settleSeriesStats`) */
  readonly series: Set<string>;
}

/**
 * Retire `retiring`, newest first, then write each member's new read. The old rows' user-set attributes are
 * snapshotted FIRST — superseding them hides them from every lookup path, and the fresh rows inherit them by content
 * match. Without this a parser improvement would silently destroy every hand-set category, note, transfer link,
 * exclusion and split on the file. `onMember` hears which member is being written (−1 while retiring).
 */
function writeRead(
  db: AppDatabase,
  members: readonly ReadMember[],
  retiring: readonly string[],
  onMember: (index: number) => void,
  writes: MemberWrite[],
  series: Set<string>,
): { retired: Set<string>; writes: MemberWrite[] } {
  const pools = members.map((m) => captureCarryForward(db, m.staleIds));
  onMember(-1);
  // what un-importing the retired reads would keep under another still-imported file, and the openings it would keep
  // with those rows — read while their rows and periods are live (`settleHeldRows`, `keepRetiredOpenings`)
  const copyPlans = retiring.length === 0 ? new Map<string, CopyHandOver[]>() : copyHandOvers(db, retiring);
  const held = heldForPrinters(db, copyPlans, retiring);
  const openings = retiredOpenings(db, retiring, held.plans, new Set([...copyPlans.values()].flat().map((p) => p.periodId)));
  const retired = new Set<string>();
  const lent: LentPeriod[] = [];
  for (const id of retiring) {
    const retirement = supersedeFileContribution(db, id);
    for (const accountId of retirement.accounts) retired.add(accountId);
    lent.push(...retirement.lent);
  }
  // one pool for the whole read: a record is given back once
  const recall = recallPool(db);
  members.forEach((member, j) => {
    onMember(j);
    const write: MemberWrite = { tally: blankOutcome(member.item.file.name), accounts: new Set(), series };
    writes.push(write);
    writeMember(db, member, pools[j] as CarryPool, recall, write);
  });
  // a month lent to a copy that no member took back is the copy's, with the rows it prints (`settleLentPeriods`) —
  // and a transfer waiting on one of them waits by that row again
  waitByRowsAgain(db, settleLentPeriods(db, lent));
  // ⚖️ owner decisions 15, 16, 20: a row the new read no longer writes that another still-imported file prints stays,
  // under that file, as the retired read's un-import keeps it — and so does the opening kept with such rows.
  // 🔴 A re-read that stopped reading Wells Fargo retired its 39 rows the Rocket Money export prints, and its balances:
  // net worth 11,312,501 → 11,072,834 cents (the review of uc/final-integrate, 2026-09-17).
  const heldBack = settleHeldRows(
    db,
    held,
    members.map((m) => ({ successorId: (m.recorded as RecordedFile).row.id, staleIds: m.staleIds })),
  );
  waitByRowsAgain(db, heldBack.flatMap((p) => p.rowIds));
  members.forEach((member, j) => {
    const stale = new Set(member.staleIds);
    (writes[j] as MemberWrite).tally.keptByPrinters = heldBack
      .filter((p) => stale.has(p.fromFileId))
      .reduce((n, p) => n + p.rowIds.length, 0);
    // an opening a retired read kept for a statement he un-imported follows the rows it keeps (`kept-openings`)
    settleKeptOpenings(db, member.staleIds, (member.recorded as RecordedFile).row.id, heldBack);
  });
  keepRetiredOpenings(db, openings, heldBack);
  return { retired, writes };
}

/** One member's new read, statement by statement — each in a transaction of its own inside whatever encloses it. */
function writeMember(db: AppDatabase, member: ReadMember, carryPool: CarryPool, recall: CarryPool, write: MemberWrite): void {
  const { file } = member.item;
  const profile = member.item.selection.profile as ParserProfile;
  const fileRow = (member.recorded as RecordedFile).row;
  const statements = member.parsed?.statements ?? [];
  const outcome = write.tally;
  const fileAccountIds = write.accounts;
  // a failed read's row is read again: what it prints is recorded afresh, with the statements below
  forgetPrintedLines(db, fileRow.id);
  for (const statement of statements) {
    const accountId = resolveAccount(db, statement.accountHint);
    fileAccountIds.add(accountId);
    const ranges = coveredRanges(db, accountId).filter((r) => r.importFileId !== fileRow.id);
    const myPriority = fidelityOf(file.format, profile.id);
    const account = db.select({ type: accounts.type }).from(accounts).where(eq(accounts.id, accountId)).get()!;

    const lines = storedLines(accountId, account, statement);

    // ⚖️ the owner's confirmed duplicates whose kept line this statement
    // prints again: an un-import of it put their retired copies back
    // (`duplicate-lifecycle`), and the lines they stand in for are here
    const returning = standInsReturnedBy(
      accountId,
      lines.map(({ stored }) => writtenSide(stored)),
      standInsOn(db, accountId),
    );
    const slots = existingIdentitySlots(db, accountId, fileRow.id, new Set(returning.map((s) => s.copy.id)));

    db.transaction((tx) => {
      // every line the statement prints, whichever row ends up recording it (`printed-lines`)
      appendPrintedLines(tx, fileRow.id, accountId, lines.map(({ printed, stored }) => printedLineOf(printed, stored)));
      // the hashes of the rows this statement inserts, in print order
      const written: string[] = [];
      // `t` is the row as printed, `stored` the row as written. Ownership asks
      // who covers the day the row POSTED, so it reads `stored`; takeover,
      // identity and carry look for another row recording the same money,
      // which sits on the day the file prints, so they read `t`.
      const plan = planLines(tx, accountId, lines, ranges, myPriority, slots);
      for (const [i, { printed: t, stored, occurrenceIndex, hash }] of lines.entries()) {
        const fate = plan[i]!;
        if (fate.kind === "owned") {
          outcome.skippedOwned += 1; // owned by higher fidelity — visible, never silent
          continue;
        }

        // this file's own prior-version row for the same money, if the user
        // had put anything on it (claimed here so a row skipped as owned
        // above leaves its attributes for whichever row does materialize)…
        const prior = takeCarry(carryPool, accountId, t, hash);
        // …else what the owner had set on the same line before an un-import removed it (`unimported-attributes`)
        const recalled = prior === null ? takeCarry(recall, accountId, t, hash, 1) : null;
        const carried = prior ?? recalled;
        const landed = (fresh: boolean, onto?: string): void => {
          if (carried === null || !landCarry(tx, accountId, hash, carried, fresh, onto)) return;
          if (recalled === null) {
            outcome.carriedForward += 1;
            return;
          }
          forgetRemembered(tx, recalled.id);
          if (recalled.recurringSeriesId !== null) write.series.add(recalled.recurringSeriesId);
          outcome.givenBack += 1;
        };

        if (fate.kind === "takeover") {
          const victim = tx.select().from(transactions).where(eq(transactions.id, fate.victimId)).get()!;
          tx.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, victim.id)).run();
          outcome.supersededTakeover += 1;
          // the re-parse carry wins over the victim: same file lineage, so
          // it is the row the user actually edited
          const inserted = insertTxn(tx, db, accountId, fileRow.id, stored, hash, occurrenceIndex, prior ?? victim);
          if (inserted) {
            outcome.inserted += 1;
            written.push(hash);
          } else outcome.deduped += 1;
          // move any user-entered splits off the superseded victim onto its
          // replacement (the SAME real charge, so amounts match) — found by
          // the replacement's own dedupe hash. Covers both the freshly-
          // inserted and the deduped (existing active twin) branches.
          const replacement = liveRowByHash(tx, accountId, hash);
          if (replacement) {
            migrateSplits(tx, victim.id, replacement.id);
            // …and the owner's duplicate verdict, as a re-parse hands it on
            // (`landCarry`): the replacement records the victim's money now
            moveKeptSide(tx, victim.id, replacement.id);
            // …and a transfer an un-import took apart waits by the replacement now, as a re-parse moves it (`landCarry`).
            // 🔴 Without it the next relink found the waiting row superseded and forgot the owner's hand-linked pair.
            moveWaitingLeg(tx, victim.id, replacement.id);
          }
          // the carry lands last: same file lineage as the row the user
          // actually edited, so it outranks the victim's attributes. A record
          // does not: the victim is the live record of the money and holds the
          // owner's work since the un-import, so the record only fills what it
          // left empty — and is spent, so a later un-import of this row keeps
          // ONE record of the line, the newer one.
          // 🔴 It was left waiting, and the next round trip gave back the older
          // of two records of one line (review of uc/final-integrate, 2026-09-16).
          landed(inserted && recalled === null);
          continue;
        }

        if (fate.kind === "absorbed") {
          // another source already records this money movement — classify by
          // whether the raw text matched exactly (visible, never silent)
          const exact = tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                eq(transactions.accountId, accountId),
                eq(transactions.dedupeHash, hash),
                sql`${transactions.status} != 'superseded'`,
              ),
            )
            .get();
          if (exact) outcome.deduped += 1;
          else outcome.dedupedCrossFormat += 1;
          // …and the bank's bucket the line prints goes to the record that keeps its money, where it has none
          fillBankCategory(tx, fate.byId, t.bankCategory);
          // the survivor belongs to another file: fill only the attributes it
          // lacks, never overwrite (its own user category outranks ours). On a
          // cross-format dedupe (hash miss) the survivor is the row that
          // absorbed the line (`absorbedLines`) — the live record of the money,
          // as a takeover victim is. A record landed there is spent, so the line
          // keeps ONE record: the one that row leaves when it goes.
          // 🔴 The carry retired with its superseded row and a record waited
          // beside the survivor: a re-read lost the owner's note, and a later
          // round trip gave back the older of two records of the line (2026-09-17).
          landed(false, fate.byId);
          continue;
        }

        const inserted = insertTxn(tx, db, accountId, fileRow.id, stored, hash, occurrenceIndex, carried);
        if (inserted) {
          outcome.inserted += 1;
          written.push(hash);
        } else outcome.deduped += 1;
        // `inserted === false` means an active twin already held this hash —
        // that row is not ours to overwrite, only to fill
        landed(inserted);
      }

      // …and a copy is retired again only for a line that became a row
      // here, in this transaction, so the charge is never counted twice. A
      // line owned elsewhere or absorbed by another record leaves its copy
      // standing in. `written` holds only hashes this loop inserted, and the
      // partial unique index allows one live row per hash, so each resolves
      // to the row inserted here.
      const fresh = written.flatMap((h) => {
        const r = liveRowByHash(tx, accountId, h);
        return r === undefined ? [] : [r];
      });
      for (const { standIn, keptId } of claimKeptSides(accountId, fresh, returning)) {
        retireStandIn(tx, accountId, standIn, keptId);
      }

      // anchors: point-in-time ledger observations and statement balances
      if (statement.ledger) {
        upsertAnchor(tx, accountId, statement.ledger.asOf, statement.ledger.cents, "ofx_ledger", fileRow.id, null);
      }
      if (statement.declaredRange && !statement.period) {
        // OFX DTSTART/DTEND: coverage without balances (covered-range rule)
        tx.insert(statementPeriods)
          .values({
            importFileId: fileRow.id,
            accountId,
            periodStart: statement.declaredRange.start,
            periodEnd: statement.declaredRange.end,
            reconciliation: "not_applicable",
          })
          .onConflictDoNothing()
          .run();
      }
      if (statement.period) {
        // a re-downloaded statement of the SAME period adopts the existing
        // row instead of duplicating it; reissued balances win and re-reconcile
        const duplicate = tx
          .select()
          .from(statementPeriods)
          .where(
            and(
              eq(statementPeriods.accountId, accountId),
              eq(statementPeriods.periodStart, statement.period.start),
              eq(statementPeriods.periodEnd, statement.period.end),
            ),
          )
          .get();
        let periodId: string | null;
        if (duplicate) {
          periodId = duplicate.id;
          // another download of the same statement owns the period: this file prints it too (`statement-copies`) —
          // unless the owner holds it only as a copy, and gives it back to the file that writes it (`reclaimFromCopy`)
          if (duplicate.importFileId !== fileRow.id && !reclaimFromCopy(tx, duplicate, fileRow.id)) {
            recordStatementCopy(tx, {
              importFileId: fileRow.id,
              accountId,
              periodStart: duplicate.periodStart,
              periodEnd: duplicate.periodEnd,
              lines: statementCopyLines(lines),
            });
          }
          const balancesChanged =
            duplicate.beginningBalanceCents !== statement.period.beginCents ||
            duplicate.endingBalanceCents !== statement.period.endCents;
          if (balancesChanged) {
            tx.update(statementPeriods)
              .set({
                beginningBalanceCents: statement.period.beginCents,
                endingBalanceCents: statement.period.endCents,
                reconciliation: "not_applicable",
                gapCents: null,
              })
              .where(eq(statementPeriods.id, duplicate.id))
              .run();
          }
        } else {
          periodId =
            tx
              .insert(statementPeriods)
              .values({
                importFileId: fileRow.id,
                accountId,
                periodStart: statement.period.start,
                periodEnd: statement.period.end,
                beginningBalanceCents: statement.period.beginCents,
                endingBalanceCents: statement.period.endCents,
                reconciliation: "not_applicable", // reconciled after batch settles
              })
              .onConflictDoNothing()
              .returning({ id: statementPeriods.id })
              .get()?.id ?? null;
        }
        upsertAnchor(tx, accountId, statement.period.end, statement.period.endCents, "statement", fileRow.id, periodId);
        upsertAnchorAtDayBefore(tx, accountId, statement.period.start, statement.period.beginCents, fileRow.id, periodId);
      }
      // a brokerage book's trades, in the same transaction as its value anchor — ./brokerage-book.ts
      if (statement.positions) {
        const asOf = statement.period?.end ?? statement.declaredRange?.end ?? statement.ledger?.asOf;
        if (asOf === undefined) throw new Error("a positions statement carries no window to prove its positions through");
        writeStatementPositions(tx, accountId, fileRow.id, statement.positions, asOf);
      }
    });
  }
  // after every line has claimed what it carries: a row filed by hand that no line took over is the owner's, not the
  // retired read's (`keepRetiredAttachedRows`)
  keepRetiredAttachedRows(db, unclaimedAttachedRows(carryPool));
}

/**
 * Write a read whose members all parsed. A fresh read of one file keeps the statements it wrote before a failure, for
 * un-import to remove; a read that retires anything, or reads several files, is all or nothing, so a failure leaves in
 * place every read it would have replaced.
 */
function writeTurn(db: AppDatabase, batch: BatchState, chain: readonly ReadMember[]): FileOutcome[] {
  const { touchedAccounts, writtenFileIds } = batch;
  const retiring = retirementOf(chain);
  // a read of several files always retires something: every file a read takes in is needed by a re-read (`pullNeeded`)
  const whole = retiring.length > 0;
  // before the write: a statement that fails mid-file leaves its earlier
  // statements' rows committed and active, and those are this upload's rows too
  for (const member of chain) writtenFileIds.add((member.recorded as RecordedFile).row.id);
  let stage = -1;
  const writes: MemberWrite[] = [];
  let retired: Set<string>;
  try {
    const run = () => {
      const written = writeRead(db, chain, retiring, (j) => (stage = j), writes, batch.givenBackSeries).retired;
      // each file is `parsed` in the same write as what it read (`markParsed`)
      for (const member of chain) markParsed(db, member);
      return written;
    };
    retired = whole ? db.transaction(() => run()) : run();
  } catch (error: unknown) {
    const message = messageOf(error);
    const at = Math.max(stage, 0);
    const failed = chain[at] as ReadMember;
    if (whole) {
      // rolled back: nothing to rebuild, and an account the read had resolved may no longer exist
      return failRead(db, batch, chain, { at, outcomeError: message, recordedError: `Failed mid-import (${keptBy(failed)}): ${message}` });
    }
    // statement-level failure: earlier statements' committed rows remain and
    // are removable via un-import; the file is marked failed with the cause
    for (const accountId of writes[0]?.accounts ?? []) touchedAccounts.add(accountId);
    db.update(importFiles)
      .set({ status: "failed", error: `Failed mid-import (un-import to clean up): ${message}` })
      .where(eq(importFiles.id, (failed.recorded as RecordedFile).row.id))
      .run();
    return [{ ...(writes[0]?.tally ?? blankOutcome(failed.item.file.name)), status: "failed", error: message }];
  }
  // whether or not a new read wrote to them again: the retired reads' rows, periods and anchors — and the shares a
  // retired read held on a brokerage book — left these accounts; and every account a member resolved
  for (const accountId of [...retired, ...writes.flatMap((w) => [...w.accounts])]) touchedAccounts.add(accountId);
  return chain.map((member, j) => settleMember(db, member, writes[j] as MemberWrite));
}

/**
 * A member's row `parsed`, in the same write as what it read: in the read's transaction, or straight after a fresh
 * read's last statement.
 *
 * 🔴 It was marked `parsed` only after the original had been moved into its account's folder. A move that threw
 * (EACCES) left a re-read's rows, periods and anchors live under a file still marked `failed` with no error, the read
 * it replaced already retired — measured on a copy of the real ledger, 2026-09-16: the Feb 2026 Robinhood PDF
 * (v3 → v4), 25 live rows under a "Failed" file and `[stale-verdict]` on both Robinhood accounts.
 */
function markParsed(db: AppDatabase, member: ReadMember): void {
  const profile = member.item.selection.profile as ParserProfile;
  const withheld = member.parsed?.withheld ?? [];
  db.update(importFiles)
    .set({
      status: "parsed",
      // ⛔ durable and visible: a file that left a section out must not read as if every account in it were read.
      // FACTS, not the sentence — see `WithheldSectionFacts` for the three readers that need the window.
      error: withheld.length === 0 ? null : recordWithheldSections(withheld),
      parserProfile: profile.id,
      parserVersion: profile.version,
    })
    .where(eq(importFiles.id, (member.recorded as RecordedFile).row.id))
    .run();
}

/** A member written and parsed: its original archived beside its accounts, its outcome settled. */
function settleMember(db: AppDatabase, member: ReadMember, { tally, accounts: fileAccountIds }: MemberWrite): FileOutcome {
  const { row, institutionName, archiveName, currentPath } = member.recorded as RecordedFile;
  // relocate the archived original from the institution bucket into its resolved
  // per-account folder — the per-account storage the DB now points at
  const finalFolder = resolveArchiveFolder(db, [...fileAccountIds], institutionName);
  const finalPath = relocateArchiveOrStay(currentPath, finalFolder, archiveName);
  if (finalPath !== row.storagePath) {
    db.update(importFiles).set({ storagePath: finalPath }).where(eq(importFiles.id, row.id)).run();
  }
  return { ...tally, withheld: [...(member.parsed?.withheld ?? [])] };
}

/**
 * `relocateArchive`, never fatal: the read is in the ledger by now, and the original is archived where it lies. A move
 * that fails leaves `storage_path` naming wherever the file is — the destination, if the move got that far — and says
 * why on the server log.
 */
function relocateArchiveOrStay(src: string, folder: string, archiveName: string): string {
  try {
    return relocateArchive(src, folder, archiveName);
  } catch (error: unknown) {
    const dest = path.join(statementsRoot(), folder, archiveName);
    const restingPlace = !fs.existsSync(src) && fs.existsSync(dest) ? dest : src;
    console.error(`[import] ${archiveName} stays archived at ${restingPlace}: moving it into ${folder}/ failed`, error);
    return restingPlace;
  }
}

/**
 * An import that faulted outside the steps that report their own failure (a parse, a write): the file fails with its
 * cause, and the upload goes on. A row already `parsed` stays parsed — its read is in the ledger — and only the
 * outcome says what faulted. 🔴 The fault left the upload — the files after it were never read, and the ones before
 * it were never categorized, reconciled, linked or rebuilt (the review, 2026-09-16).
 */
function failedUnexpectedly(db: AppDatabase, file: { name: string }, fileRowId: string | undefined, error: unknown): FileOutcome {
  const cause = `Unexpected: ${error instanceof Error ? error.message : String(error)}`;
  const row = fileRowId === undefined ? undefined : db.select().from(importFiles).where(eq(importFiles.id, fileRowId)).get();
  if (row !== undefined && row.status !== "parsed") {
    // nothing was written: a read of these bytes at an older version is still the one in place
    const kept = retiredReadsOf(db, row.fileSha256, row.parserVersion).length > 0;
    db.update(importFiles)
      .set({ status: "failed", error: kept ? `${cause} (${EARLIER_READ_KEPT})` : cause })
      .where(eq(importFiles.id, row.id))
      .run();
  }
  return {
    fileName: file.name,
    status: "failed",
    error: cause,
    withheld: [],
    inserted: 0,
    deduped: 0,
    dedupedCrossFormat: 0,
    skippedOwned: 0,
    supersededTakeover: 0,
    carriedForward: 0,
    givenBack: 0,
    keptByPrinters: 0,
    quarantined: 0,
    periods: [],
  };
}

/**
 * A profile that never withholds returns its statements alone; one that can returns what it left out beside them.
 * Exported so a write that reads a file with a profile outside the import (scripts/redate-sapphire-0630-payment-2026-09-15.ts)
 * asks this rule rather than restating it.
 */
export function asParsedFile(parsed: ParsedStatement[] | ParsedFile): ParsedFile {
  return Array.isArray(parsed) ? { statements: parsed, withheld: [] } : parsed;
}

/**
 * Name the account a withheld section belongs to: by institution and last4, and read-only.
 *
 * ⛔ Never `resolveAccount`. It CREATES an account it cannot find and ADOPTS one of the same type with no last4 —
 * handed Robinhood Agentic's hint with a type, it would stamp ····9651 on Robinhood Cash — and nothing about a
 * section that was not imported may change which accounts exist.
 */
function withheldOutcome(db: AppDatabase, section: WithheldSection): WithheldOutcome {
  const { institution, last4 } = section.accountHint;
  const atInstitution =
    last4 === undefined
      ? []
      : db
          .select({ id: accounts.id, name: accounts.name, last4: accounts.last4 })
          .from(accounts)
          .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
          .where(eq(institutions.name, institution))
          .all();
  const current = atInstitution.filter((a) => a.last4 === last4);
  // …or the number its statements printed before (`account-numbers`), as `resolveAccount` reads it
  const formerly =
    current.length > 0 || last4 === undefined ? [] : accountsFormerlyNumbered(db, atInstitution.map((a) => a.id), last4);
  const named = current.length > 0 ? current : atInstitution.filter((a) => formerly.includes(a.id));
  const [only] = named.length === 1 ? named : [];
  const facts = {
    accountId: only?.id ?? null,
    accountName: only?.name ?? null,
    last4: last4 ?? null,
    periodStart: section.period.start,
    periodEnd: section.period.end,
    reason: section.reason,
  };
  return { ...facts, notice: withheldSectionNotice(facts) };
}

/**
 * Takeover victim selection (schema.md): among same-day equal-amount rows
 * from lower-fidelity files, pick by description similarity with a
 * deterministic tie-break; no plausible match ⇒ no supersede (the fuzzy
 * review pass surfaces the residual pair instead of guessing).
 *
 * 🔴 …and a row this very line wrote before (the same `dedupe_hash`) first. Of two equal charges a line could retire
 * the other one's row, then find its own still live under its hash and write nothing: one charge gone. A file's own
 * rows sit under a lower-fidelity file once an un-import hands them to one that prints them (`printed-lines`); on a
 * copy of the real ledger, 2026-09-16, re-importing Discover-AllAvailable-20260710.csv that way took Discover from
 * 1,044 active rows to 1,039 and put three periods into gap.
 */
function pickTakeoverVictim(
  tx: AppDatabase,
  accountId: string,
  t: CanonicalTxn,
  hash: string,
  lowerFileIds: string[],
  // rows an earlier line of the same statement takes over
  taken: ReadonlySet<string>,
): typeof transactions.$inferSelect | undefined {
  const candidates = tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.postedOn, t.postedOn),
        eq(transactions.amountCents, t.amountCents),
        inArray(transactions.status, ["active", "quarantined"]),
        inArray(transactions.importFileId, lowerFileIds),
        // ⚖️ a row filed under the file by hand is the owner's, never the file's parse (owner, 2026-09-15): it absorbs
        // the line as any row entered by hand does. 🔴 Taken over, it was retired behind the new line, and un-importing
        // the more trusted file deleted the payment where its statement had no record of what it prints.
        parsedRow(),
      ),
    )
    .all()
    .filter((c) => !taken.has(c.id));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const incoming = normalizeDescription(t.rawDescription);
  const sameLine = (c: typeof transactions.$inferSelect) => (c.dedupeHash === hash ? 1 : 0);
  const ranked = candidates
    .map((c) => ({ c, s: descriptionScore(c.normalizedDescription, incoming) }))
    .sort((a, b) => sameLine(b.c) - sameLine(a.c) || b.s - a.s || a.c.id.localeCompare(b.c.id));
  return ranked[0]!.s > 0 ? ranked[0]!.c : undefined;
}

/**
 * Gives an absorbed line's bank category to the row that absorbed it, where that row has none; `categorizeAll` then
 * reads it as it reads any row's.
 *
 * 🔴 The category went with the line. Measured on a copy of the real ledger, 2026-09-16: un-importing
 * 20260602-statements-9805-.pdf and Spending Report PDF (1).pdf, then importing the statement and then the report, took
 * uncategorized 32 -> 86 — of the 80 May rows the round trip rewrote, 55 had held the report's bank category and 7 a
 * hand one. With the bucket given to the statement's rows: 32 -> 32.
 */
function fillBankCategory(tx: AppDatabase, rowId: string, bankCategory: string | undefined): void {
  if (bankCategory === undefined || bankCategory === "") return;
  tx.update(transactions)
    .set({ bankCategory })
    .where(and(eq(transactions.id, rowId), isNull(transactions.bankCategory)))
    .run();
}

/**
 * The columns `insertTxn` writes that a duplicate pair's key reads — asked
 * before a line lands, so the importer knows which retired copies it returns.
 */
function writtenSide(t: CanonicalTxn): DuplicatePairSide {
  return {
    postedOn: t.postedOn,
    transactedOn: t.transactedOn ?? null,
    amountCents: t.amountCents,
    normalizedDescription: normalizeDescription(t.rawDescription),
  };
}

function insertTxn(
  tx: AppDatabase,
  db: AppDatabase,
  accountId: string,
  importFileId: string,
  t: CanonicalTxn,
  hash: string,
  occurrenceIndex: number,
  // the row this one replaces (takeover victim or re-parse predecessor); the
  // remaining carried attributes land in applyCarry once the row exists
  carryFrom: CarryAttributes | null,
): boolean {
  const categoryId = t.categoryPath ? categoryIdForPath(db, t.categoryPath) : null;
  const carriesHand = carryFrom !== null && isHandCategory(carryFrom);
  const engine = carryFrom === null || carriesHand ? null : engineCategoryCarry(carryFrom);
  // the parser's own category, unless an engine's travels over it (`engineCategoryCarry`) — or a hand-set one does,
  // with the merchant and confidence it came with, as `applyCarry` moves them.
  // 🔴 A takeover victim's hand category travelled alone, and categorizeAll never names a merchant on a categorized
  // row: on a copy of the real ledger, 2026-09-16, a round trip of Discover-AllAvailable-20260710.csv (whose re-import
  // takes back the rows the statements kept) left 16 hand-categorized charges with no merchant and no confidence.
  const category =
    carryFrom !== null && (engine === "overwrite" || (engine === "fill" && categoryId === null))
      ? { ...engineCategoryColumns(carryFrom), merchantId: carryFrom.merchantId }
      : carryFrom !== null && carriesHand
        ? {
            categoryId: carryFrom.categoryId,
            categorizationSource: "user" as const,
            categorizationConfidence: carryFrom.categorizationConfidence,
            merchantId: carryFrom.merchantId,
          }
        : { categoryId, categorizationSource: categoryId ? ("rule" as const) : null };
  const result = tx
    .insert(transactions)
    .values({
      accountId,
      importFileId,
      ...writtenSide(t),
      rawDescription: t.rawDescription,
      bankCategory: t.bankCategory ?? null,
      fitid: t.fitid ?? null,
      occurrenceIndex,
      dedupeHash: hash,
      ...category,
      notes: carryFrom?.notes ?? null,
      transferGroupId: carryFrom?.transferGroupId ?? null,
      recurringSeriesId: carryFrom?.recurringSeriesId ?? null,
      // a takeover victim's link keeps its owner, and its detach stays a detach —
      // without it the successor landed NULL/NULL inside this upload's linking
      // scope, and absorption re-linked a charge the owner had unlinked
      seriesLinkSource: carryFrom ? carriedLinkSource(carryFrom) : null,
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

function upsertAnchor(
  tx: AppDatabase,
  accountId: string,
  anchoredOn: string,
  balanceCents: number,
  source: "statement" | "ofx_ledger",
  importFileId: string,
  statementPeriodId: string | null,
): void {
  // a document records the day again: an opening kept from an un-imported statement makes way (`kept-openings`)
  replaceKeptOpening(tx, accountId, anchoredOn);
  tx.insert(balanceAnchors)
    .values({ accountId, anchoredOn, balanceCents, source, importFileId, statementPeriodId })
    .onConflictDoUpdate({
      target: [balanceAnchors.accountId, balanceAnchors.anchoredOn, balanceAnchors.source],
      // all three provenance fields move together — a reissued statement must
      // never leave an anchor pointing at one file and another file's period
      set: { balanceCents, importFileId, statementPeriodId },
    })
    .run();
}

/** Begin-balance anchor at period_start − 1 day, symmetric with the end anchor. */
function upsertAnchorAtDayBefore(
  tx: AppDatabase,
  accountId: string,
  periodStart: string,
  balanceCents: number,
  importFileId: string,
  statementPeriodId: string | null,
): void {
  // the statement is imported again: the opening kept when it was un-imported makes way (`kept-openings`)
  replaceKeptOpening(tx, accountId, addDays(periodStart, -1));
  tx.run(sql`
    INSERT INTO balance_anchors (id, account_id, anchored_on, balance_cents, source, import_file_id, statement_period_id, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${accountId}, date(${periodStart}, '-1 day'), ${balanceCents}, 'statement', ${importFileId}, ${statementPeriodId}, datetime('now'), datetime('now'))
    ON CONFLICT (account_id, anchored_on, source) DO UPDATE SET
      balance_cents = excluded.balance_cents,
      import_file_id = excluded.import_file_id,
      statement_period_id = excluded.statement_period_id
  `);
}

/** Ids of every row filed under these import files, whatever their status. */
function rowIdsOfFiles(db: AppDatabase, fileIds: ReadonlySet<string>): string[] {
  if (fileIds.size === 0) return [];
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.importFileId, [...fileIds]))
    .all()
    .map((r) => r.id);
}

/** Quarantined rows on these accounts — the rows a reconcile may promote. */
function quarantinedIdsOn(db: AppDatabase, accountIds: readonly string[]): string[] {
  if (accountIds.length === 0) return [];
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(inArray(transactions.accountId, [...accountIds]), eq(transactions.status, "quarantined")))
    .all()
    .map((r) => r.id);
}

/**
 * Takes away a file's balances — its anchors and its periods — for both paths that remove a file's contribution:
 * `supersedeFileContribution` and `unimportFile`. Each hands a period another download of the statement prints to that
 * download first (`statement-copies`: `lendToCopies`, `handOverToCopies`), so what is left here is the file's own; an
 * anchor another file's period still prints is handed over (`handOverPrintedAnchors`), not deleted.
 *
 * An opening the file keeps for a statement he un-imported (`kept-openings`) goes with it — except while a re-read
 * retires the file (`keepOpenings`): the successor takes it once it is written (`settleKeptOpenings`).
 */
function removeFileBalances(tx: AppDatabase, importFileId: string, { keepOpenings: keep = false } = {}): void {
  handOverPrintedAnchors(tx, importFileId);
  tx.delete(balanceAnchors)
    .where(and(eq(balanceAnchors.importFileId, importFileId), keep ? ne(balanceAnchors.source, KEPT_OPENING_SOURCE) : undefined))
    .run();
  // anchors owned by OTHER files may reference this file's periods — detach
  // them before the periods go (FK integrity under foreign_keys=ON)
  tx.run(sql`
    UPDATE balance_anchors SET statement_period_id = NULL
    WHERE statement_period_id IN (SELECT id FROM statement_periods WHERE import_file_id = ${importFileId})
  `);
  tx.delete(statementPeriods).where(eq(statementPeriods.importFileId, importFileId)).run();
}

/**
 * Supersede everything an import file contributed (re-parse lifecycle). Returns every account it had written to —
 * read before anything moves — and every brokerage book whose shares it held, for the caller to rebuild.
 *
 * ⛔ Its holding events are DELETED, not kept beside the re-read: the file's successor reads the same trades again,
 * and events carry no status to retire them by — kept, a re-read would add every share a second time. A book the
 * deletion would walk below zero throws (`NegativePositionError`) and the whole retirement rolls back.
 *
 * 🔴 The import rebuilt only the accounts the NEW parse read. An account the retired version wrote and the new one
 * does not (a section it now withholds, or one it no longer reads) lost its rows, periods and anchors here and kept
 * its daily_balances: `anchored` on a day no anchor names, provenance "checked through" a period that no longer
 * exists, and a balance still counting superseded rows. Measured on a copy of the real ledger, 2026-09-16:
 * re-reading the August 2026 Robinhood brokerage PDF at a bumped version that withholds #655929651's section left
 * Robinhood Agentic `anchored` on 2026-08-31 (anchors only Jun 30 / Jul 31) and checked through 2026-08-31. With
 * the scope: 08-31 carried, checked through 2026-07-31.
 */
function supersedeFileContribution(db: AppDatabase, oldFileId: string): { accounts: string[]; lent: LentPeriod[] } {
  return db.transaction((tx) => {
    const written = accountsWrittenBy(tx, oldFileId);
    const books = removeFileEvents(tx, oldFileId);
    // what a copy of the statement prints, read while the rows are live (`settleLentPeriods` reads it once the new
    // read is written)
    const lent = lentPeriodsOf(tx, oldFileId);
    // a transfer an un-import took apart may be waiting on a row this retires: the re-read writes its line again
    keepStayingLegsByContent(tx, oldFileId);
    tx.update(transactions)
      .set({ status: "superseded" })
      .where(and(eq(transactions.importFileId, oldFileId), inArray(transactions.status, ["active", "quarantined", "excluded"])))
      .run();
    // a period another download of the statement prints stays, lent to that download — the period alone: the
    // successor writes the rows again, and takes the period back where it writes it again (`lendToCopies`)
    lendToCopies(
      tx,
      lent.map((l) => l.plan),
    );
    // …but an opening it keeps for a statement he un-imported waits for the successor (`settleKeptOpenings`)
    removeFileBalances(tx, oldFileId, { keepOpenings: true });
    // its successor records again what it prints, as a copy or not (`statement-copies`, `printed-lines`)
    forgetStatementCopies(tx, oldFileId);
    forgetPrintedLines(tx, oldFileId);
    // a parsed file's error is only ever the sections it withheld (`markParsed`); its successor reads them again
    // and says for itself what is still missing, so the retired row must not keep claiming a section is absent
    tx.update(importFiles).set({ status: "superseded", error: null }).where(eq(importFiles.id, oldFileId)).run();
    return { accounts: [...new Set([...written, ...books])], lent };
  });
}

function guessInstitution(db: AppDatabase, file: { name: string; text: string }): { id: string; name: string } {
  const haystack = `${file.name} ${file.text.slice(0, 400)}`.toLowerCase();
  const name = haystack.includes("chase")
    ? "Chase"
    : haystack.includes("discover")
      ? "Discover"
      : haystack.includes("capital") || /^\d{4}_transaction/.test(file.name)
        ? "Capital One"
        : haystack.includes("sofi")
          ? "SoFi"
          : haystack.includes("robinhood")
            ? "Robinhood"
            : "Chase";
  const id = db.select({ id: institutions.id }).from(institutions).where(eq(institutions.name, name)).get()!.id;
  return { id, name };
}

/**
 * Reconciliation over date-range membership (schema.md): cash/credit must
 * close to the cent; investment periods are value anchors with a computed
 * market_change. Gap periods quarantine the rows their own file contributed.
 */
export function reconcileAccounts(db: AppDatabase, accountIds: string[]): void {
  for (const accountId of accountIds) {
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) continue;
    const periods = db
      .select()
      .from(statementPeriods)
      .where(eq(statementPeriods.accountId, accountId))
      .all();

    for (const period of periods) {
      if (period.reconciliation === "accepted") continue;
      if (period.beginningBalanceCents === null || period.endingBalanceCents === null) continue;

      const rows = db
        .select({ amountCents: transactions.amountCents })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            // 'excluded' hides a txn from ANALYTICS — the money still moved,
            // so reconciliation and balances must include it
            inArray(transactions.status, [...RECONCILE_STATUSES]),
            gte(transactions.postedOn, period.periodStart),
            lte(transactions.postedOn, period.periodEnd),
          ),
        )
        .all();
      const total = sumCents(rows.map((r) => r.amountCents));

      // The grading rule itself lives in lib/reconciliation so `pnpm
      // ledger-check` can recompute a verdict with the SAME arithmetic that
      // wrote it — a checker with its own copy of the rule can only report
      // disagreements with itself.
      const verdict = periodVerdict(period, total, { isInvestment: !periodsMustClose(account) });

      if (verdict.reconciliation === "value_anchor") {
        db.update(statementPeriods)
          .set({
            reconciliation: verdict.reconciliation,
            marketChangeCents: verdict.marketChangeCents,
            gapCents: verdict.gapCents,
          })
          .where(eq(statementPeriods.id, period.id))
          .run();
        continue;
      }

      const gap = verdict.gapCents ?? 0;
      db.transaction((tx) => {
        tx.update(statementPeriods)
          .set({ reconciliation: verdict.reconciliation, gapCents: verdict.gapCents })
          .where(eq(statementPeriods.id, period.id))
          .run();
        // quarantine policy: this period's own file's rows hold until resolved
        const target = gap === 0 ? "active" : "quarantined";
        const from = gap === 0 ? "quarantined" : "active";
        tx.update(transactions)
          .set({ status: target })
          .where(
            and(
              eq(transactions.accountId, accountId),
              eq(transactions.importFileId, period.importFileId),
              eq(transactions.status, from),
              gte(transactions.postedOn, period.periodStart),
              lte(transactions.postedOn, period.periodEnd),
            ),
          )
          .run();
      });
    }
  }
}

export interface StorageMigration {
  importFileId: string;
  fileName: string;
  from: string;
  to: string;
  moved: boolean;
}

/**
 * Relocates already-imported originals into the per-account archive
 * (data/statements/<account-slug>/), for files ingested before per-account
 * storage existed. Each file's folder is derived from the account(s) its
 * transactions/periods resolve to — the real account, not the file's guessed
 * institution. With move: false it only rewrites storage_path (dry validation);
 * with move: true it also relocates the physical file. Idempotent.
 */
export function migrateStorageLayout(db: AppDatabase, opts: { move: boolean }): StorageMigration[] {
  const rows = db.select().from(importFiles).all();
  const results: StorageMigration[] = [];
  for (const row of rows) {
    const fromTxns = db
      .selectDistinct({ accountId: transactions.accountId })
      .from(transactions)
      .where(eq(transactions.importFileId, row.id))
      .all()
      .map((r) => r.accountId);
    const fromPeriods = db
      .selectDistinct({ accountId: statementPeriods.accountId })
      .from(statementPeriods)
      .where(eq(statementPeriods.importFileId, row.id))
      .all()
      .map((r) => r.accountId);
    const accountIds = [...new Set([...fromTxns, ...fromPeriods])];

    const fallback = db
      .select({ name: institutions.name })
      .from(institutions)
      .where(eq(institutions.id, row.institutionId))
      .get()!.name;
    const folder = resolveArchiveFolder(db, accountIds, fallback);
    const dest = path.join(statementsRoot(), folder, path.basename(row.storagePath));
    if (dest === row.storagePath) continue;

    let moved = false;
    if (opts.move) {
      if (fs.existsSync(dest)) {
        // dest already holds this content — drop a stale source dup
        if (fs.existsSync(row.storagePath) && row.storagePath !== dest) fs.rmSync(row.storagePath);
        moved = true;
      } else if (fs.existsSync(row.storagePath)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        moveFile(row.storagePath, dest);
        moved = true;
      }
      // only repoint the DB when the file actually lives at dest now — never
      // leave storage_path dangling at a path with no file (dry runs preview
      // the mapping via the returned results without touching disk-of-record)
      if (moved) db.update(importFiles).set({ storagePath: dest }).where(eq(importFiles.id, row.id)).run();
    }
    results.push({ importFileId: row.id, fileName: row.fileName, from: row.storagePath, to: dest, moved });
  }
  return results;
}

/** Group ids per query — well under SQLite's bound-parameter limit. */
const GROUP_ID_CHUNK = 500;

/**
 * The transfer legs deleting a file's rows would leave ALONE in their group:
 * live rows outside the file whose group keeps exactly one of them.
 *
 * 🔴 Un-importing deleted the rows and left their partners pointing at a group
 * with no second leg, and `detectTransfers` pairs only rows whose group IS
 * NULL — so a re-import never paired them again. Measured on a copy of the real
 * ledger, 2026-09-15: un-importing and re-importing 20260702 + 20260302 took
 * the single-leg groups 23 → 34, eight of them Chase Checking card payments
 * whose Sapphire leg had been deleted. A group that keeps two or more legs
 * outside the file is still a group, and is left alone.
 */
function legsLeftAloneBy(tx: AppDatabase, importFileId: string): StaleTransferLeg[] {
  const groupIds = [
    ...new Set(
      tx
        .select({ groupId: transactions.transferGroupId })
        .from(transactions)
        .where(and(eq(transactions.importFileId, importFileId), isNotNull(transactions.transferGroupId)))
        .all()
        .map((r) => r.groupId!),
    ),
  ];
  const alone: StaleTransferLeg[] = [];
  for (let i = 0; i < groupIds.length; i += GROUP_ID_CHUNK) {
    const outside = tx
      .select({ id: transactions.id, transferGroupId: transactions.transferGroupId })
      .from(transactions)
      .where(
        and(
          inArray(transactions.transferGroupId, groupIds.slice(i, i + GROUP_ID_CHUNK)),
          ne(transactions.status, "superseded"),
          or(isNull(transactions.importFileId), ne(transactions.importFileId, importFileId)),
        ),
      )
      .all();
    const byGroup = new Map<string, StaleTransferLeg[]>();
    for (const leg of outside) byGroup.set(leg.transferGroupId!, [...(byGroup.get(leg.transferGroupId!) ?? []), leg]);
    for (const legs of byGroup.values()) if (legs.length === 1) alone.push(legs[0]!);
  }
  return alone;
}

/**
 * Every account an import file wrote to: its rows, its periods, its anchors.
 * Read BEFORE the delete — afterwards nothing names the file. Both paths that
 * take a file's contribution away read it: `unimportFile` and
 * `supersedeFileContribution`.
 *
 * 🔴 The rebuild scope was the accounts the file had ROWS on. A statement that
 * gave an account a period and a balance anchor and nothing else lost both and
 * was never rebuilt, so daily_balances stayed `anchored` on a day no anchor
 * names and provenance said "checked through" it. Measured on a copy of the
 * real ledger, 2026-09-15: un-importing the August 2026 Robinhood brokerage PDF
 * left Robinhood Agentic anchored on 2026-08-31 with anchors only on Jun 30 and
 * Jul 31.
 */
function accountsWrittenBy(db: AppDatabase, importFileId: string): string[] {
  const of = (rows: { accountId: string }[]) => rows.map((r) => r.accountId);
  return [
    ...new Set([
      ...of(db.selectDistinct({ accountId: transactions.accountId }).from(transactions).where(eq(transactions.importFileId, importFileId)).all()),
      ...of(db.selectDistinct({ accountId: statementPeriods.accountId }).from(statementPeriods).where(eq(statementPeriods.importFileId, importFileId)).all()),
      // ⚠️ a brokerage book the file wrote shares to is here through its period: every positions statement carries one
      ...of(db.selectDistinct({ accountId: balanceAnchors.accountId }).from(balanceAnchors).where(eq(balanceAnchors.importFileId, importFileId)).all()),
    ]),
  ];
}

/**
 * Un-import: removes what a file parsed, its periods, its anchors and the trades
 * it wrote to a brokerage book atomically, and detaches the rows attached to it
 * (`attached-rows`); derived state rebuilt. A period another download of the
 * statement still prints goes to that download with the rows it prints, and is
 * not removed (`statement-copies`); a row another imported file prints goes to
 * that file (`printed-lines`).
 */
export function unimportFile(db: AppDatabase, importFileId: string): void {
  const file = db.select().from(importFiles).where(eq(importFiles.id, importFileId)).get();
  if (!file) return;
  // ⛔ a brokerage book's months come off newest first — refused before anything is snapshotted or written
  const later = laterBookStatements(db, importFileId);
  if (later.length > 0) throw new Error(laterStatementsRefusal(later));
  // …and a second download that withheld the month this file reads comes off first (`copiesWithheldFor`)
  const copies = copiesWithheldFor(db, importFileId);
  if (copies.length > 0) throw new Error(withheldCopiesRefusal(copies));
  const affected = accountsWrittenBy(db, importFileId);
  // a period another download of the statement also prints goes to it, with the rows it prints (`statement-copies`)
  const copyPlans = copyHandOvers(db, [importFileId]);
  const handOvers = copyPlans.get(importFileId) ?? [];
  // …and a row another imported file prints goes to that file (`printed-lines`)
  const printers = printerHandOvers(db, copyPlans, [importFileId]).get(importFileId) ?? [];
  const handed = new Set([...handedRowIds([handOvers]), ...printerRowIds([printers])]);

  const doomedRows = db
    .select({ id: transactions.id, seriesId: transactions.recurringSeriesId })
    .from(transactions)
    .where(parsedFromFile(importFileId))
    .all()
    .filter((r) => !handed.has(r.id));
  const doomed = doomedRows.map((r) => r.id);
  // every series about to lose a linked row: its stats describe the rows it had
  const seriesLosingRows = doomedRows.flatMap((r) => (r.seriesId === null ? [] : [r.seriesId]));

  // The rows the file parsed leave the database entirely — re-importing
  // re-parses the original, but every correction made to those rows since is
  // gone. A row attached to the file stays, and a re-import files it again.
  withPreMutationSnapshot(db, "unimport-file", () => {
    let restored: string[] = [];
    // the brokerage books whose shares the file held
    let heldShares: string[] = [];
    db.transaction((tx) => {
      // First: what the other download takes is no longer this file's, so nothing below reads it as the file's rows,
      // and the anchor hand-over below finds the period under its new file
      handOverToCopies(tx, handOvers);
      handOverToPrinters(tx, printers);
      // ⚖️ owner, 2026-09-17: an account whose rows another file keeps keeps the opening this statement printed, when
      // nothing else records its balance — read while the file's own periods are still here (`kept-openings`)
      const openings = keptOpeningPlans(tx, importFileId, printers);
      // …and an opening this file keeps for a statement he un-imported goes with the rows it carries
      handOverKeptOpenings(tx, followingOpeningsByFile(tx, new Map([[importFileId, printers]])).get(importFileId) ?? []);
      // A charge this file's rows are the SURVIVING copy of has a retired twin
      // sitting `superseded` in another file. Delete the survivor without putting
      // that twin back and the money is recorded by zero live rows: it vanishes
      // from balances and net worth silently, because the owner asked to remove a
      // FILE and got a missing CHARGE.
      //
      // Inside this transaction, and before the delete, so the restore and the
      // delete cannot come apart: on the bare db each restore would autocommit
      // on its own, and a later failure would leave rows restored beside
      // survivors that were never deleted — the double count, from the fix.
      restored = restoreDuplicatesLosingTheirSurvivor(tx, doomed);
      // ⚖️ owner, 2026-09-15: a row ATTACHED to this file was never the file's
      // to take. Detached before anything below reads "the file's rows", so the
      // partners left alone and the delete see only what the file parsed — and
      // a kept leg keeps its partner linked.
      detachAttachedRows(tx, importFileId);
      // after the restore (a restored twin is a live leg) and before the delete
      // (the rows naming the groups are still here to be read)
      // …kept first, so importing the same lines again links the transfer again (`unimported-transfers`)
      rememberTransfersTakenApart(tx, importFileId);
      // …and what the owner set on the rows, given back to the same lines by a later import (`unimported-attributes`)
      rememberRowAttributes(tx, rememberedOf(tx, importFileId));
      detachTransferLegs(tx, legsLeftAloneBy(tx, importFileId));
      tx.delete(transactions).where(parsedFromFile(importFileId)).run();
      removeFileBalances(tx, importFileId);
      keepOpenings(tx, openings);
      // the trades the file printed leave with it — before the file row, whose id they reference
      heldShares = removeFileEvents(tx, importFileId);
      forgetStatementCopies(tx, importFileId);
      forgetPrintedLines(tx, importFileId);
      tx.delete(importFiles).where(eq(importFiles.id, importFileId)).run();
    });
    // a book the file created and nothing else holds leaves too: the un-import restores the ledger it found
    const written = [...new Set([...affected, ...heldShares])];
    const removedBooks = new Set(removeEmptyBooks(db, written));
    const scope = [...new Set([...written, ...accountsOfTransactions(db, restored)])].filter((id) => !removedBooks.has(id));
    const quarantinedBefore = quarantinedIdsOn(db, scope);
    reconcileAccounts(db, scope);
    // A restored twin, or a row whose gap this removal closed, is back in the
    // ledger — link it the way an import would. Nothing else may be claimed.
    linkRowsMadeActive(db, [...restored, ...quarantinedBefore]);
    // …and the series whose rows just went: `last_matched_on` must not keep
    // naming a posting that no longer exists
    settleSeriesStats(db, seriesLosingRows);
    for (const accountId of scope) rebuildAccount(db, accountId);
    // removing a file can CLOSE another file's gap, and reconcileAccounts then
    // promotes that period's quarantined rows — the same seam as an import
    flagDuplicateCandidates(db, scope);
  });
}

/** Accept a gap: the user takes the statement as-is; rows return to analytics. */
export function acceptGap(db: AppDatabase, statementPeriodId: string): void {
  const period = db.select().from(statementPeriods).where(eq(statementPeriods.id, statementPeriodId)).get();
  if (!period) return;
  // Un-quarantining is a one-way door: the reconciliation verdict that put
  // those rows aside is overwritten, and nothing recomputes it.
  withPreMutationSnapshot(db, "accept-gap", () => {
    let promoted: string[] = [];
    db.transaction((tx) => {
      tx.update(statementPeriods)
        .set({ reconciliation: "accepted" })
        .where(eq(statementPeriods.id, statementPeriodId))
        .run();
      const held = and(
        eq(transactions.accountId, period.accountId),
        eq(transactions.importFileId, period.importFileId),
        eq(transactions.status, "quarantined"),
        gte(transactions.postedOn, period.periodStart),
        lte(transactions.postedOn, period.periodEnd),
      );
      // the SAME predicate as the promotion, read first — these are the rows
      // this acceptance makes active, and the only ones linking may claim
      promoted = tx.select({ id: transactions.id }).from(transactions).where(held).all().map((r) => r.id);
      tx.update(transactions).set({ status: "active" }).where(held).run();
    });
    categorizeAll(db);
    detectTransfers(db);
    linkRowsMadeActive(db, promoted);
    rebuildAccount(db, period.accountId);
    // The rows just promoted were invisible to the import-time identity pool
    // for as long as they sat quarantined, so an overlapping export imported
    // during the quarantine may already record the same charges. They are
    // FLAGGED, never superseded: an earlier revision picked a winner here on
    // (day, amount) alone and silently destroyed real charges (reverted in
    // 3e5a7fc). Outside the transaction above, because flagging writes.
    flagDuplicateCandidates(db, [period.accountId]);
  });
}
