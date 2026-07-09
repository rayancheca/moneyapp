import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, isNull, lte, max, min, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods, type FileFormat } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { assignOccurrenceIndexes, dedupeHash, fileSha256 } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { sumCents } from "@/lib/money";
import { categorizeAll, detectTransfers } from "../categorize";
import { rebuildAccount } from "../derivation";
import { sniffFile } from "./sniff";
import { PROFILES } from "./profiles";
import { ParseError, type AccountHint, type CanonicalTxn, type ParsedStatement } from "./types";

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
  /** rows not inserted because a higher-fidelity source owns their date range */
  skippedOwned: number;
  supersededTakeover: number;
  quarantined: number;
  periods: PeriodOutcome[];
}

interface CoveredRange {
  importFileId: string;
  priority: number;
  minDay: string;
  maxDay: string;
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

function originalsDir(): string {
  return process.env.MONEYAPP_ORIGINALS_DIR ?? path.join(process.cwd(), "data", "originals");
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

async function importOneFile(
  db: AppDatabase,
  file: ReturnType<typeof sniffFile>,
  touchedAccounts: Set<string>,
): Promise<FileOutcome> {
  const sha = fileSha256(file.buffer);
  const profile = PROFILES.find((p) => p.matches(file));
  const outcome: FileOutcome = {
    fileName: file.name,
    status: "parsed",
    inserted: 0,
    deduped: 0,
    skippedOwned: 0,
    supersededTakeover: 0,
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
  // version's entire contribution atomically before importing fresh
  if (profile) {
    const stale = db
      .select()
      .from(importFiles)
      .where(and(eq(importFiles.fileSha256, sha), inArray(importFiles.status, ["parsed", "parsed_with_claude"])))
      .all()
      .filter((f) => f.parserVersion < profile.version);
    for (const old of stale) supersedeFileContribution(db, old.id);
  }

  fs.mkdirSync(originalsDir(), { recursive: true });
  // basename neutralizes traversal; truncation + control-strip neutralizes
  // pathological names (ENAMETOOLONG would abort the batch)
  const safeName = path
    .basename(file.name)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, 80);
  const storagePath = path.join(originalsDir(), `${sha.slice(0, 16)}-${safeName}`);
  if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, file.buffer);

  const fileRow =
    existing ??
    db
      .insert(importFiles)
      .values({
        fileName: file.name,
        fileSha256: sha,
        format: file.format,
        institutionId: guessInstitutionId(db, file),
        parserProfile: profile?.id ?? null,
        parserVersion: profile?.version ?? 0,
        status: "failed",
        storagePath,
        importedAt: new Date().toISOString(),
      })
      .returning()
      .get();

  if (!profile) {
    db.update(importFiles)
      .set({ status: "failed", error: "No parser profile matched this file" })
      .where(eq(importFiles.id, fileRow.id))
      .run();
    return { ...outcome, status: "failed", error: "No parser profile matched this file" };
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

  try {
    for (const statement of statements) {
      const accountId = resolveAccount(db, statement.accountHint);
      touchedAccounts.add(accountId);
      const ranges = coveredRanges(db, accountId).filter((r) => r.importFileId !== fileRow.id);
      const myPriority = FORMAT_PRIORITY[file.format];

      const indexed = assignOccurrenceIndexes(statement.txns, (t) => ({
        accountId,
        postedOn: t.postedOn,
        amountCents: t.amountCents,
        rawDescription: t.rawDescription,
      }));

      db.transaction((tx) => {
        for (const { row: t, occurrenceIndex } of indexed) {
          const coveredBy = ranges.filter((r) => t.postedOn >= r.minDay && t.postedOn <= r.maxDay);
          if (coveredBy.some((r) => r.priority < myPriority)) {
            outcome.skippedOwned += 1; // owned by higher fidelity — visible, never silent
            continue;
          }

          // takeover: a lower-fidelity source owns this day — replace its
          // best-matching row (schema.md: date, amount, description similarity)
          const lowerOwners = coveredBy.filter((r) => r.priority > myPriority);
          if (lowerOwners.length > 0) {
            const victim = pickTakeoverVictim(tx, accountId, t, lowerOwners.map((r) => r.importFileId));
            if (victim) {
              tx.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, victim.id)).run();
              outcome.supersededTakeover += 1;
              const inserted = insertTxn(tx, db, accountId, fileRow.id, t, occurrenceIndex, victim);
              if (inserted) outcome.inserted += 1;
              else outcome.deduped += 1;
              continue;
            }
          }

          const inserted = insertTxn(tx, db, accountId, fileRow.id, t, occurrenceIndex, null);
          if (inserted) outcome.inserted += 1;
          else outcome.deduped += 1;
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

  db.update(importFiles)
    .set({ status: "parsed", error: null, parserProfile: profile.id, parserVersion: profile.version })
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
  const score = (candidateDesc: string): number => {
    if (candidateDesc === incoming) return 3;
    if (candidateDesc.includes(incoming) || incoming.includes(candidateDesc)) return 2;
    let prefix = 0;
    while (prefix < Math.min(candidateDesc.length, incoming.length) && candidateDesc[prefix] === incoming[prefix]) prefix++;
    return prefix >= 8 ? 1 : 0;
  };
  const ranked = candidates
    .map((c) => ({ c, s: score(c.normalizedDescription) }))
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  return ranked[0]!.s > 0 ? ranked[0]!.c : undefined;
}

function insertTxn(
  tx: AppDatabase,
  db: AppDatabase,
  accountId: string,
  importFileId: string,
  t: CanonicalTxn,
  occurrenceIndex: number,
  carryFrom: { categoryId: string | null; categorizationSource: string | null; notes: string | null; transferGroupId: string | null; recurringSeriesId: string | null } | null,
): boolean {
  const hash = dedupeHash({
    accountId,
    postedOn: t.postedOn,
    amountCents: t.amountCents,
    rawDescription: t.rawDescription,
    occurrenceIndex,
  });
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

function guessInstitutionId(db: AppDatabase, file: { name: string; text: string }): string {
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
  return db.select({ id: institutions.id }).from(institutions).where(eq(institutions.name, name)).get()!.id;
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
}

/** Accept a gap: the user takes the statement as-is; rows return to analytics. */
export function acceptGap(db: AppDatabase, statementPeriodId: string): void {
  const period = db.select().from(statementPeriods).where(eq(statementPeriods.id, statementPeriodId)).get();
  if (!period) return;
  db.transaction((tx) => {
    tx.update(statementPeriods)
      .set({ reconciliation: "accepted" })
      .where(eq(statementPeriods.id, statementPeriodId))
      .run();
    tx.update(transactions)
      .set({ status: "active" })
      .where(
        and(
          eq(transactions.accountId, period.accountId),
          eq(transactions.importFileId, period.importFileId),
          eq(transactions.status, "quarantined"),
          gte(transactions.postedOn, period.periodStart),
          lte(transactions.postedOn, period.periodEnd),
        ),
      )
      .run();
  });
  categorizeAll(db);
  detectTransfers(db);
  rebuildAccount(db, period.accountId);
}
