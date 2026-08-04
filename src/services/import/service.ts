import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, isNull, lte, max, min, ne, sql } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods, type FileFormat } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import {
  transactions,
  type CategorizationSource,
  type SeriesLinkSource,
  type TransactionStatus,
} from "@/db/schema/transactions";
import { migrateSplits, splitCountsByTxn } from "../transaction-splits";
import { assignOccurrenceIndexes, dedupeHash, fileSha256 } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { sumCents } from "@/lib/money";
import { categorizeAll, detectTransfers } from "../categorize";
import { rebuildAccount } from "../derivation";
import { accountSlug, institutionSlug } from "./account-slug";
import { sniffFile } from "./sniff";
import { PROFILES } from "./profiles";
import { extractLines } from "./profiles/pdf-profile";
import { ParseError, type AccountHint, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "./types";

/**
 * The import orchestrator (master-plan Phases 2a/2b): sniff → profile →
 * canonical rows → ownership/takeover → hash dedupe → statement periods →
 * reconciliation identities → quarantine → anchors → derived rebuild.
 * Import-order independence is an invariant: any permutation of the same
 * file set converges to an equivalent database.
 */

const FORMAT_PRIORITY: Record<FileFormat, number> = { ofx: 0, qfx: 0, csv: 1, pdf: 2 };

export interface PeriodOutcome {
  accountName: string;
  start: string;
  end: string;
  reconciliation: string;
  gapCents: number | null;
  marketChangeCents: number | null;
}

export interface FileOutcome {
  fileName: string;
  status: "parsed" | "failed" | "skipped_duplicate";
  error?: string;
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
   * rows that inherited user-set attributes (category/notes/transfer link/
   * recurring link/exclusion/splits) from this same file's prior parser
   * version — the re-parse lifecycle, visible instead of silent
   */
  carriedForward: number;
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
 * balance-affecting rows from OTHER sources, indexed by amount under BOTH the
 * dates they carry. An incoming row whose exact hash misses still dedupes when
 * this pool holds an unconsumed match — the same money described with
 * different raw text, or dated differently, by another export format.
 * One slot per existing row, taken at most once no matter which index found
 * it, so two genuinely identical same-day charges stay distinct: each existing
 * row absorbs at most one incoming row.
 * Quarantined rows stay out of the pool (they don't affect balances, so an
 * incoming balance-affecting row must not vanish against one), and superseded
 * rows are history.
 */
interface IdentityPool {
  /** one slot per existing row, consumed at most once however it is matched */
  used: boolean[];
  byPosted: Map<string, number[]>;
  byTransacted: Map<string, number[]>;
}

function existingIdentityPool(db: AppDatabase, accountId: string, excludeFileId: string): IdentityPool {
  const rows = db
    .select({
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
    .all();

  const pool: IdentityPool = { used: rows.map(() => false), byPosted: new Map(), byTransacted: new Map() };
  rows.forEach((r, i) => {
    index(pool.byPosted, identityKey(r.postedOn, r.amountCents), i);
    if (r.transactedOn !== null) index(pool.byTransacted, identityKey(r.transactedOn, r.amountCents), i);
  });
  return pool;
}

function index(map: Map<string, number[]>, key: string, i: number): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(i);
  else map.set(key, [i]);
}

function identityKey(day: string, amountCents: number): string {
  return `${day}\x1f${amountCents}`;
}

function takeSlot(pool: IdentityPool, map: Map<string, number[]>, key: string): boolean {
  for (const i of map.get(key) ?? []) {
    if (pool.used[i]) continue;
    pool.used[i] = true;
    return true;
  }
  return false;
}

/**
 * Consume one existing row that records this same money; false when none is
 * left. Posted-vs-posted is tried first, so behaviour is unchanged wherever
 * the two sources agree on the date.
 *
 * The fallback exists because a source can date the SAME charge differently:
 * a Chase card statement prints the TRANSACTION date, while the rows already
 * stored from the Spending Report export carry the POST date, typically one
 * to three days later. Keyed only on posted_on, re-stating a card period
 * inserted a duplicate of nearly every row in it. Matching transacted-to-
 * transacted bridges that without widening into a fuzzy date window — a window
 * would merge genuinely distinct same-amount charges (measured: 43 such pairs
 * on this one card), whereas this only ever matches two records that claim the
 * same transaction day.
 */
function consumeIdentity(pool: IdentityPool, postedOn: string, transactedOn: string | undefined, amountCents: number): boolean {
  if (takeSlot(pool, pool.byPosted, identityKey(postedOn, amountCents))) return true;
  if (transactedOn === undefined) return false;
  return takeSlot(pool, pool.byTransacted, identityKey(transactedOn, amountCents));
}

/**
 * The user-set attributes a row owns — everything the parser cannot re-derive.
 * They belong to the MONEY, not to the parse, so a re-parse at a new parser
 * version must move them onto the fresh row (schema.md lifecycle rule).
 * `categorizationSource` decides whether the category itself travels: only a
 * `user` category is user-set — rule/merchant/bank/transfer categories are
 * re-derived by categorizeAll once the batch settles, so carrying one would
 * freeze a stale guess. A user category takes its merchant along, because
 * categorizeAll never revisits a user-categorized row.
 * Deliberately NOT carried: needs_review (re-derived every import) and
 * quarantined status (a reconciliation verdict on the OLD file's period —
 * the new file reconciles for itself).
 */
interface CarryAttributes {
  categoryId: string | null;
  categorizationSource: CategorizationSource | null;
  categorizationConfidence: number | null;
  merchantId: string | null;
  notes: string | null;
  transferGroupId: string | null;
  recurringSeriesId: string | null;
  seriesLinkSource: SeriesLinkSource | null;
  status: TransactionStatus;
}

/** A superseded prior-version row, still content-matchable to its successor. */
interface CarryRow extends CarryAttributes {
  id: string;
  dedupeHash: string;
  normalizedDescription: string;
}

/** Carryable rows bucketed by (account, day, amount) — the money's identity. */
type CarryPool = Map<string, CarryRow[]>;

function carryKey(accountId: string, postedOn: string, amountCents: number): string {
  return `${accountId}\x1f${postedOn}\x1f${amountCents}`;
}

/** Something a re-parse would otherwise destroy (splits handled separately). */
function hasCarryableAttributes(row: CarryRow): boolean {
  return (
    (row.categorizationSource === "user" && row.categoryId !== null) ||
    row.notes !== null ||
    row.transferGroupId !== null ||
    row.recurringSeriesId !== null ||
    row.status === "excluded"
  );
}

/**
 * Snapshot the user-set attributes of the rows a set of about-to-be-superseded
 * import files contributed. MUST run BEFORE supersedeFileContribution — after
 * it the rows are `superseded` and every lookup path skips them.
 */
function captureCarryForward(db: AppDatabase, oldFileIds: readonly string[]): CarryPool {
  const pool: CarryPool = new Map();
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
  // the user's work and must land on the successor
  const splitCounts = splitCountsByTxn(db, rows.map((r) => r.id));
  for (const row of rows) {
    if (!hasCarryableAttributes(row) && (splitCounts.get(row.id) ?? 0) === 0) continue;
    const key = carryKey(row.accountId, row.postedOn, row.amountCents);
    const bucket = pool.get(key);
    if (bucket) bucket.push(row);
    else pool.set(key, [row]);
  }
  // deterministic order so two runs consume identical buckets identically
  for (const bucket of pool.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  return pool;
}

/**
 * Claim the prior-version row for this incoming row, if any. Same account, same
 * day, same amount — that is the same money even when a fixed parser now reads
 * the description differently; the description only RANKS candidates when a day
 * holds several equal amounts. Multiset consumption: each old row's attributes
 * migrate onto at most one successor.
 */
function takeCarry(pool: CarryPool, accountId: string, t: CanonicalTxn, hash: string): CarryRow | null {
  const key = carryKey(accountId, t.postedOn, t.amountCents);
  const bucket = pool.get(key);
  if (!bucket || bucket.length === 0) return null;
  const incoming = normalizeDescription(t.rawDescription);
  const ranked = bucket
    .map((row, index) => ({
      row,
      index,
      // an unchanged dedupe hash is proof of the same parsed row
      score: row.dedupeHash === hash ? 4 : descriptionScore(row.normalizedDescription, incoming),
    }))
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const winner = ranked[0]!;
  bucket.splice(winner.index, 1);
  return winner.row;
}

/**
 * Stamp carried attributes onto a row THIS file just inserted (it owns the row,
 * so a full overwrite is safe and idempotent).
 */
function applyCarry(tx: AppDatabase, txnId: string, carry: CarryAttributes): void {
  const userCategory = carry.categorizationSource === "user" && carry.categoryId !== null;
  tx.update(transactions)
    .set({
      ...(userCategory
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
      seriesLinkSource: carry.recurringSeriesId ? carry.seriesLinkSource : null,
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
  if (
    carry.categorizationSource === "user" &&
    carry.categoryId !== null &&
    existing.categorizationSource !== "user"
  ) {
    set.categoryId = carry.categoryId;
    set.categorizationSource = "user";
    set.categorizationConfidence = carry.categorizationConfidence;
    set.merchantId = existing.merchantId ?? carry.merchantId;
    set.needsReview = false;
  }
  if (existing.notes === null && carry.notes !== null) set.notes = carry.notes;
  if (existing.transferGroupId === null && carry.transferGroupId !== null) {
    set.transferGroupId = carry.transferGroupId;
  }
  if (existing.recurringSeriesId === null && carry.recurringSeriesId !== null) {
    set.recurringSeriesId = carry.recurringSeriesId;
    set.seriesLinkSource = carry.seriesLinkSource;
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
  migrateSplits(tx, carry.id, target.id);
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
 * with its superseded row).
 */
function landCarry(
  tx: AppDatabase,
  accountId: string,
  hash: string,
  carry: CarryRow,
  fresh: boolean,
): boolean {
  const target = liveRowByHash(tx, accountId, hash);
  if (!target) return false;
  adoptCarriedSplits(tx, carry, target, fresh);
  if (fresh) applyCarry(tx, target.id, carry);
  else fillFromCarry(tx, target, carry);
  return true;
}

function coveredRanges(db: AppDatabase, accountId: string): CoveredRange[] {
  const rows = db
    .select({
      importFileId: transactions.importFileId,
      format: importFiles.format,
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
      priority: FORMAT_PRIORITY[r.format],
      minDay: r.minDay!,
      maxDay: r.maxDay!,
    }));

  // declared ranges (OFX DTSTART/DTEND, statement periods) extend coverage
  // beyond the observed transaction span — schema.md covered-range rule
  const declared = db
    .select({
      importFileId: statementPeriods.importFileId,
      format: importFiles.format,
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
    priority: FORMAT_PRIORITY[d.format],
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

/** Resolve (or create/upgrade) the account a parsed statement belongs to. */
export function resolveAccount(db: AppDatabase, hint: AccountHint): string {
  const institution = db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.name, hint.institution))
    .get();
  if (!institution) throw new Error(`Unknown institution ${hint.institution}`);

  const all = db.select().from(accounts).where(eq(accounts.institutionId, institution.id)).all();
  // an existing preferred account (the P0.1 settlement-cash ledger) wins over
  // type matching; absent, the hint resolves exactly as before
  if (hint.preferName) {
    const preferred = all.find((a) => a.name === hint.preferName);
    if (preferred) return preferred.id;
  }
  const typeMatch = (a: (typeof all)[number]) =>
    hint.type !== undefined && a.type === hint.type && (hint.subtype === undefined || a.subtype === hint.subtype);

  let found = hint.last4 ? all.find((a) => a.last4 === hint.last4) : undefined;
  if (!found && !hint.last4) {
    // files without account numbers (Discover CSV, Robinhood activity, SoFi)
    found = all.find(typeMatch);
  }
  if (!found && hint.last4) {
    // adopt: an account created from a numberless file learns its last4 now —
    // never create a duplicate for the same real-world account
    found = all.find((a) => a.last4 === null && typeMatch(a));
  }
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
      institutionId: institution.id,
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

  const outcomes: FileOutcome[] = [];
  const touchedAccounts = new Set<string>();

  for (const file of sniffed) {
    const outcome = await importOneFile(db, file, touchedAccounts);
    outcomes.push(outcome);
  }

  for (const accountId of touchedAccounts) rebuildAccount(db, accountId);
  if (touchedAccounts.size > 0) {
    categorizeAll(db);
    detectTransfers(db);
    flagFuzzyDuplicates(db);
    // reconcile ALL periods of touched accounts again — later files can close
    // or open gaps in earlier files' periods (date-range membership)
    reconcileAccounts(db, [...touchedAccounts]);
    for (const accountId of touchedAccounts) rebuildAccount(db, accountId);
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
async function selectProfile(
  file: ReturnType<typeof sniffFile>,
): Promise<{ profile: ParserProfile | undefined; unreadable: boolean }> {
  const candidates = PROFILES.filter((p) => p.matches(file));
  if (candidates.length === 0) return { profile: undefined, unreadable: false };
  if (!candidates.some((p) => p.matchesContent)) return { profile: candidates[0], unreadable: false };

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
  };
}

async function importOneFile(
  db: AppDatabase,
  file: ReturnType<typeof sniffFile>,
  touchedAccounts: Set<string>,
): Promise<FileOutcome> {
  const sha = fileSha256(file.buffer);
  const { profile, unreadable } = await selectProfile(file);
  const outcome: FileOutcome = {
    fileName: file.name,
    status: "parsed",
    inserted: 0,
    deduped: 0,
    dedupedCrossFormat: 0,
    skippedOwned: 0,
    supersededTakeover: 0,
    carriedForward: 0,
    quarantined: 0,
    periods: [],
  };

  const existing = db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileSha256, sha), eq(importFiles.parserVersion, profile?.version ?? 0)))
    .get();
  if (existing && existing.status !== "superseded" && existing.status !== "failed") {
    return { ...outcome, status: "skipped_duplicate" };
  }

  // re-parse lifecycle (schema.md): a newer parser version supersedes the old
  // version's entire contribution atomically before importing fresh. The old
  // rows' user-set attributes are snapshotted FIRST — superseding them hides
  // them from every lookup path, and the fresh rows inherit them by content
  // match below. Without this a parser improvement would silently destroy every
  // hand-set category, note, transfer link, exclusion and split on the file.
  const stale = profile
    ? db
        .select()
        .from(importFiles)
        .where(and(eq(importFiles.fileSha256, sha), inArray(importFiles.status, ["parsed", "parsed_with_claude"])))
        .all()
        .filter((f) => f.parserVersion < profile.version)
    : [];
  const carryPool = captureCarryForward(db, stale.map((f) => f.id));
  for (const old of stale) supersedeFileContribution(db, old.id);

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
  const currentPath = existing
    ? existing.storagePath
    : archiveTo(institutionSlug(institution.name), archiveName, file.buffer);

  const fileRow =
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

  if (!profile) {
    const message = unreadable
      ? "No text could be extracted — this looks like a scanned or image-only PDF"
      : "No parser profile matched this file";
    db.update(importFiles)
      .set({ status: "failed", error: message })
      .where(eq(importFiles.id, fileRow.id))
      .run();
    return { ...outcome, status: "failed", error: message };
  }

  let statements: ParsedStatement[];
  try {
    statements = await profile.parse(file);
  } catch (error: unknown) {
    const message = error instanceof ParseError ? error.message : `Unexpected: ${String(error)}`;
    db.update(importFiles)
      .set({ status: "failed", error: message, parserProfile: profile.id })
      .where(eq(importFiles.id, fileRow.id))
      .run();
    return { ...outcome, status: "failed", error: message };
  }

  const fileAccountIds = new Set<string>();
  try {
    for (const statement of statements) {
      const accountId = resolveAccount(db, statement.accountHint);
      touchedAccounts.add(accountId);
      fileAccountIds.add(accountId);
      const ranges = coveredRanges(db, accountId).filter((r) => r.importFileId !== fileRow.id);
      const myPriority = FORMAT_PRIORITY[file.format];

      const indexed = assignOccurrenceIndexes(statement.txns, (t) => ({
        accountId,
        postedOn: t.postedOn,
        amountCents: t.amountCents,
        rawDescription: t.rawDescription,
      }));

      const identityPool = existingIdentityPool(db, accountId, fileRow.id);

      db.transaction((tx) => {
        for (const { row: t, occurrenceIndex } of indexed) {
          const coveredBy = ranges.filter((r) => t.postedOn >= r.minDay && t.postedOn <= r.maxDay);
          if (coveredBy.some((r) => r.priority < myPriority)) {
            outcome.skippedOwned += 1; // owned by higher fidelity — visible, never silent
            continue;
          }

          const hash = dedupeHash({
            accountId,
            postedOn: t.postedOn,
            amountCents: t.amountCents,
            rawDescription: t.rawDescription,
            occurrenceIndex,
          });
          // this file's own prior-version row for the same money, if the user
          // had put anything on it (claimed here so a row skipped as owned
          // above leaves its attributes for whichever row does materialize)
          const carried = takeCarry(carryPool, accountId, t, hash);

          // takeover: a lower-fidelity source owns this day — replace its
          // best-matching row (schema.md: date, amount, description similarity)
          const lowerOwners = coveredBy.filter((r) => r.priority > myPriority);
          if (lowerOwners.length > 0) {
            const victim = pickTakeoverVictim(tx, accountId, t, lowerOwners.map((r) => r.importFileId));
            if (victim) {
              tx.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, victim.id)).run();
              outcome.supersededTakeover += 1;
              // the victim leaves the ledger — release its identity so a later
              // same-day equal-amount row can't consume the superseded slot
              if (victim.status !== "quarantined") consumeIdentity(identityPool, t.postedOn, t.transactedOn, t.amountCents);
              // the re-parse carry wins over the victim: same file lineage, so
              // it is the row the user actually edited
              const inserted = insertTxn(tx, db, accountId, fileRow.id, t, hash, occurrenceIndex, carried ?? victim);
              if (inserted) outcome.inserted += 1;
              else outcome.deduped += 1;
              // move any user-entered splits off the superseded victim onto its
              // replacement (the SAME real charge, so amounts match) — found by
              // the replacement's own dedupe hash. Covers both the freshly-
              // inserted and the deduped (existing active twin) branches.
              const replacement = liveRowByHash(tx, accountId, hash);
              if (replacement) migrateSplits(tx, victim.id, replacement.id);
              // the carry lands last: same file lineage as the row the user
              // actually edited, so it outranks the victim's attributes
              if (carried && landCarry(tx, accountId, hash, carried, inserted)) {
                outcome.carriedForward += 1;
              }
              continue;
            }
          }

          if (consumeIdentity(identityPool, t.postedOn, t.transactedOn, t.amountCents)) {
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
            // the survivor belongs to another file: fill only the attributes it
            // lacks, never overwrite (its own user category outranks ours). A
            // cross-format dedupe (hash miss) has no identifiable survivor, so
            // that carry retires with its superseded row rather than guess.
            if (carried && landCarry(tx, accountId, hash, carried, false)) {
              outcome.carriedForward += 1;
            }
            continue;
          }

          const inserted = insertTxn(tx, db, accountId, fileRow.id, t, hash, occurrenceIndex, carried);
          if (inserted) outcome.inserted += 1;
          else outcome.deduped += 1;
          // `inserted === false` means an active twin already held this hash —
          // that row is not ours to overwrite, only to fill
          if (carried && landCarry(tx, accountId, hash, carried, inserted)) {
            outcome.carriedForward += 1;
          }
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
      });
    }
  } catch (error: unknown) {
    // statement-level failure: earlier statements' committed rows remain and
    // are removable via un-import; the file is marked failed with the cause
    const message = error instanceof Error ? error.message : String(error);
    db.update(importFiles)
      .set({ status: "failed", error: `Failed mid-import (un-import to clean up): ${message}` })
      .where(eq(importFiles.id, fileRow.id))
      .run();
    return { ...outcome, status: "failed", error: message };
  }

  // relocate the archived original from the institution bucket into its resolved
  // per-account folder — the per-account storage the DB now points at
  const finalFolder = resolveArchiveFolder(db, [...fileAccountIds], institution.name);
  const finalPath = relocateArchive(currentPath, finalFolder, archiveName);

  db.update(importFiles)
    .set({
      status: "parsed",
      error: null,
      parserProfile: profile.id,
      parserVersion: profile.version,
      storagePath: finalPath,
    })
    .where(eq(importFiles.id, fileRow.id))
    .run();
  return outcome;
}

/**
 * Takeover victim selection (schema.md): among same-day equal-amount rows
 * from lower-fidelity files, pick by description similarity with a
 * deterministic tie-break; no plausible match ⇒ no supersede (the fuzzy
 * review pass surfaces the residual pair instead of guessing).
 */
function pickTakeoverVictim(
  tx: AppDatabase,
  accountId: string,
  t: CanonicalTxn,
  lowerFileIds: string[],
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
      ),
    )
    .all();
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const incoming = normalizeDescription(t.rawDescription);
  const ranked = candidates
    .map((c) => ({ c, s: descriptionScore(c.normalizedDescription, incoming) }))
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  return ranked[0]!.s > 0 ? ranked[0]!.c : undefined;
}

/**
 * How closely two normalized descriptions describe the same charge: 3 equal,
 * 2 one contains the other, 1 a long shared prefix, 0 unrelated. Shared by
 * takeover-victim selection (where 0 vetoes the supersede) and re-parse
 * carry-forward (where it only ranks candidates that already match on money).
 */
function descriptionScore(candidate: string, incoming: string): number {
  if (candidate === incoming) return 3;
  if (candidate.includes(incoming) || incoming.includes(candidate)) return 2;
  let prefix = 0;
  while (prefix < Math.min(candidate.length, incoming.length) && candidate[prefix] === incoming[prefix]) prefix++;
  return prefix >= 8 ? 1 : 0;
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
  const carryUserCategory = carryFrom?.categorizationSource === "user" ? carryFrom.categoryId : null;
  const result = tx
    .insert(transactions)
    .values({
      accountId,
      importFileId,
      postedOn: t.postedOn,
      transactedOn: t.transactedOn ?? null,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      normalizedDescription: normalizeDescription(t.rawDescription),
      bankCategory: t.bankCategory ?? null,
      fitid: t.fitid ?? null,
      occurrenceIndex,
      dedupeHash: hash,
      categoryId: carryUserCategory ?? categoryId,
      categorizationSource: carryUserCategory ? "user" : categoryId ? "rule" : null,
      notes: carryFrom?.notes ?? null,
      transferGroupId: carryFrom?.transferGroupId ?? null,
      recurringSeriesId: carryFrom?.recurringSeriesId ?? null,
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
  tx.run(sql`
    INSERT INTO balance_anchors (id, account_id, anchored_on, balance_cents, source, import_file_id, statement_period_id, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${accountId}, date(${periodStart}, '-1 day'), ${balanceCents}, 'statement', ${importFileId}, ${statementPeriodId}, datetime('now'), datetime('now'))
    ON CONFLICT (account_id, anchored_on, source) DO UPDATE SET
      balance_cents = excluded.balance_cents,
      import_file_id = excluded.import_file_id,
      statement_period_id = excluded.statement_period_id
  `);
}

/** Supersede everything an import file contributed (re-parse lifecycle). */
function supersedeFileContribution(db: AppDatabase, oldFileId: string): void {
  db.transaction((tx) => {
    tx.update(transactions)
      .set({ status: "superseded" })
      .where(and(eq(transactions.importFileId, oldFileId), inArray(transactions.status, ["active", "quarantined", "excluded"])))
      .run();
    tx.run(sql`
      UPDATE balance_anchors SET statement_period_id = NULL
      WHERE statement_period_id IN (SELECT id FROM statement_periods WHERE import_file_id = ${oldFileId})
        AND import_file_id != ${oldFileId}
    `);
    tx.delete(balanceAnchors).where(eq(balanceAnchors.importFileId, oldFileId)).run();
    tx.delete(statementPeriods).where(eq(statementPeriods.importFileId, oldFileId)).run();
    tx.update(importFiles).set({ status: "superseded" }).where(eq(importFiles.id, oldFileId)).run();
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
            inArray(transactions.status, ["active", "quarantined", "excluded"]),
            gte(transactions.postedOn, period.periodStart),
            lte(transactions.postedOn, period.periodEnd),
          ),
        )
        .all();
      const total = sumCents(rows.map((r) => r.amountCents));

      if (account.type === "investment") {
        const marketChange = period.endingBalanceCents - period.beginningBalanceCents - total;
        db.update(statementPeriods)
          .set({ reconciliation: "value_anchor", marketChangeCents: marketChange, gapCents: null })
          .where(eq(statementPeriods.id, period.id))
          .run();
        continue;
      }

      const gap = period.endingBalanceCents - (period.beginningBalanceCents + total);
      db.transaction((tx) => {
        tx.update(statementPeriods)
          .set({ reconciliation: gap === 0 ? "reconciled" : "gap", gapCents: gap === 0 ? null : gap })
          .where(eq(statementPeriods.id, period.id))
          .run();
        // quarantine policy: this period's own file's rows hold until resolved.
        // Deliberately a blind flip, unlike acceptGap's promoteQuarantinedRows:
        // the gap above is summed over active AND quarantined rows for this
        // account and date range, so a gap of 0 is a verdict reached WITH these
        // rows counted. Setting any of them aside here would change the very
        // sum that just reconciled and re-open the gap on the next run.
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

/** Residual probable duplicates across files: never silently deleted, only flagged. */
function flagFuzzyDuplicates(db: AppDatabase): void {
  const dupes = db.all<{ id: string }>(sql`
    SELECT t1.id FROM transactions t1
    JOIN transactions t2
      ON t1.account_id = t2.account_id
     AND t1.posted_on = t2.posted_on
     AND t1.amount_cents = t2.amount_cents
     AND t1.id != t2.id
     AND t1.import_file_id != t2.import_file_id
     AND t1.normalized_description = t2.normalized_description
    WHERE t1.status = 'active' AND t2.status = 'active'
      AND t1.transfer_group_id IS NULL AND t2.transfer_group_id IS NULL
  `);
  if (dupes.length === 0) return;
  db.update(transactions)
    .set({ needsReview: true })
    .where(inArray(transactions.id, dupes.map((d) => d.id)))
    .run();
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

/** Un-import: removes a file's contributions atomically; derived state rebuilt. */
export function unimportFile(db: AppDatabase, importFileId: string): void {
  const file = db.select().from(importFiles).where(eq(importFiles.id, importFileId)).get();
  if (!file) return;
  const affected = db
    .select({ accountId: transactions.accountId })
    .from(transactions)
    .where(eq(transactions.importFileId, importFileId))
    .groupBy(transactions.accountId)
    .all()
    .map((r) => r.accountId);

  // The file's rows leave the database entirely — re-importing re-parses the
  // original, but every correction made to those rows since is gone.
  withPreMutationSnapshot(db, "unimport-file", () => {
    db.transaction((tx) => {
      tx.delete(transactions).where(eq(transactions.importFileId, importFileId)).run();
      tx.delete(balanceAnchors).where(eq(balanceAnchors.importFileId, importFileId)).run();
      // anchors owned by OTHER files may reference this file's periods — detach
      // them before the periods go (FK integrity under foreign_keys=ON)
      tx.run(sql`
        UPDATE balance_anchors SET statement_period_id = NULL
        WHERE statement_period_id IN (SELECT id FROM statement_periods WHERE import_file_id = ${importFileId})
      `);
      tx.delete(statementPeriods).where(eq(statementPeriods.importFileId, importFileId)).run();
      tx.delete(importFiles).where(eq(importFiles.id, importFileId)).run();
    });
    reconcileAccounts(db, affected);
    for (const accountId of affected) rebuildAccount(db, accountId);
  });
}

/**
 * Return a period's quarantined rows to analytics — except any whose money
 * another file has since recorded as a live row.
 *
 * Quarantined rows are deliberately kept OUT of the import-time identity pool
 * (see IdentityPool): they do not affect balances, so an incoming
 * balance-affecting row must not vanish against one. The price of that choice
 * is that a period which sat quarantined while an overlapping export was
 * imported now holds a second copy of its own rows. Promoting them all would
 * turn every such pair into a double count — measured at 66 rows on one real
 * card period, and the reconciliation sum at reconcileAccounts() counts both
 * copies too, because it is scoped by account and date, not by file.
 *
 * So promotion replays the very match the importer would have made had these
 * rows been active at the time, and supersedes the losers. That is the same
 * `consumeIdentity` machinery, so a row is only ever set aside for one that
 * claims the same day (posted or transacted) AND the same amount — never a
 * fuzzy window. The surviving copy is the other file's, not this one's, so the
 * money and the row count are right; strict order-independence would also
 * require the same FILE to win, which would mean superseding already-active
 * rows and destroying whatever the user has since set on them.
 */
function promoteQuarantinedRows(
  tx: AppDatabase,
  accountId: string,
  importFileId: string,
  periodStart: string,
  periodEnd: string,
): { activated: number; superseded: number } {
  const rows = tx
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
        eq(transactions.importFileId, importFileId),
        eq(transactions.status, "quarantined"),
        gte(transactions.postedOn, periodStart),
        lte(transactions.postedOn, periodEnd),
      ),
    )
    // deterministic: which duplicate absorbs which slot must not depend on
    // SQLite's row order
    .orderBy(transactions.postedOn, transactions.id)
    .all();

  const pool = existingIdentityPool(tx, accountId, importFileId);
  let superseded = 0;
  for (const row of rows) {
    const alreadyRecorded = consumeIdentity(pool, row.postedOn, row.transactedOn ?? undefined, row.amountCents);
    tx.update(transactions)
      .set({ status: alreadyRecorded ? "superseded" : "active" })
      .where(eq(transactions.id, row.id))
      .run();
    if (alreadyRecorded) superseded++;
  }
  return { activated: rows.length - superseded, superseded };
}

/** Accept a gap: the user takes the statement as-is; rows return to analytics. */
export function acceptGap(db: AppDatabase, statementPeriodId: string): void {
  const period = db.select().from(statementPeriods).where(eq(statementPeriods.id, statementPeriodId)).get();
  if (!period) return;
  // Un-quarantining is a one-way door: the reconciliation verdict that put
  // those rows aside is overwritten, and nothing recomputes it.
  withPreMutationSnapshot(db, "accept-gap", () => {
    db.transaction((tx) => {
      tx.update(statementPeriods)
        .set({ reconciliation: "accepted" })
        .where(eq(statementPeriods.id, statementPeriodId))
        .run();
      promoteQuarantinedRows(tx, period.accountId, period.importFileId, period.periodStart, period.periodEnd);
    });
    categorizeAll(db);
    detectTransfers(db);
    rebuildAccount(db, period.accountId);
  });
}
