import type { Metadata } from "next";
import { count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods, type ImportStatus } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { statementGaps } from "@/services/statement-gaps";
import { CoveragePanel } from "@/components/imports/CoveragePanel";
import { StatementGapsPanel } from "@/components/imports/StatementGapsPanel";
import { StatementSchedule } from "@/components/imports/StatementSchedule";
import { accountCoverage } from "@/services/coverage";
import { provenanceFor } from "@/services/provenance";
import { statementPulls } from "@/services/statement-pulls";
import { countPhrase } from "@/components/ui/blast-radius";
import { importRowQualifiers, importRowSubject } from "@/lib/import-file-label";
import { dayWindowLabel } from "@/lib/period";
import { ConfirmActionButton } from "@/components/ui/Confirm";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { formatCents } from "@/lib/money";
import { acceptGapAction, unimportFileAction, uploadStatementsAction } from "./actions";

export const metadata: Metadata = { title: "Imports" };
export const dynamic = "force-dynamic";

const STATUS_META: Record<ImportStatus, { label: string; tone: string }> = {
  parsed: { label: "Parsed", tone: "bg-positive" },
  parsed_with_claude: { label: "Parsed (Claude assisted)", tone: "bg-positive" },
  needs_claude: { label: "Waiting for Claude", tone: "bg-warning" },
  failed: { label: "Failed", tone: "bg-negative" },
  superseded: { label: "Superseded", tone: "bg-ink-faint" },
};

const RECONCILIATION_LABEL: Record<string, { label: string; tone: string }> = {
  reconciled: { label: "reconciled to the cent", tone: "text-positive" },
  value_anchor: { label: "value anchor", tone: "text-ink-muted" },
  gap: { label: "GAP", tone: "text-negative" },
  accepted: { label: "gap accepted", tone: "text-warning" },
  not_applicable: { label: "no printed balances", tone: "text-ink-faint" },
};

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The three actions on this page are `Promise<void>` form actions, so a
  // failure travels back as ?error= (the /budgets pattern). Without this read
  // the redirect landed on a page that rendered nothing — an un-import refused
  // because its restore point could not be written looked exactly like an
  // un-import that silently did nothing, which is the worst possible reading.
  const raw = await searchParams;
  const error = errorParam(raw);

  const db = getDb();
  const files = db
    .select({
      id: importFiles.id,
      fileName: importFiles.fileName,
      format: importFiles.format,
      parserProfile: importFiles.parserProfile,
      status: importFiles.status,
      error: importFiles.error,
      importedAt: importFiles.importedAt,
      txnCount: count(transactions.id),
      // the un-import blast radius, measured on the same rows the DELETE takes:
      // how many the owner categorized BY HAND (the work that cannot come back)
      // and the money the file put on both sides of the ledger
      userCategorizedCount: sql<number>`coalesce(sum(case when ${transactions.categorizationSource} = 'user' then 1 else 0 end), 0)`,
      /*
       * 🔴 …but the MONEY line names the ledger, and a superseded row is not in
       * it. `rocket-money-export-2026-08-25.csv` holds 39 rows, every one of
       * them `superseded`, and the confirmation offered "Money leaving the
       * ledger: $6,447.92 in · $4,051.25 out" — of a file whose rows no total
       * on this app can see. Eleven files are in that state.
       *
       * The row COUNT stays whole: 39 rows really are deleted, and pairing that
       * with $0.00 is the honest reading of what un-importing one of these does.
       */
      inflowCents: sql<number>`coalesce(sum(case when ${transactions.status} = 'active' and ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      outflowCents: sql<number>`coalesce(sum(case when ${transactions.status} = 'active' and ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      /*
       * ⛔ …and some of what leaves comes straight back. `unimportFile` calls
       * `restoreDuplicatesLosingTheirSurvivor` BEFORE its delete, so a row that
       * is the surviving half of a confirmed duplicate hands its money to the
       * retired twin instead of taking it out of the ledger. All 12 rows of
       * `20250302-statements-9805-.pdf` are survivors, and their twins sum to
       * the same $4,619.92 the confirmation called money leaving.
       *
       * Counted, never re-derived: the restore has slot conflicts and status
       * floors this page must not reimplement, so the confirmation names how
       * many rows are in that shape and lets the reader weigh it.
       */
      duplicateSurvivorCount: sql<number>`coalesce(sum(case when exists (
        select 1 from duplicate_candidates d
        where d.resolution = 'confirmed_duplicate'
          and d.retired_transaction_id is not null
          and d.retired_transaction_id <> ${transactions.id}
          and (d.transaction_id_a = ${transactions.id} or d.transaction_id_b = ${transactions.id})
      ) then 1 else 0 end), 0)`,
    })
    .from(importFiles)
    .leftJoin(transactions, eq(transactions.importFileId, importFiles.id))
    .groupBy(importFiles.id)
    .orderBy(desc(importFiles.importedAt))
    .all();

  /* 🔴 A name is not an identity here — see `importRowQualifiers`. 112 of the
     owner's 330 rows share one, and two of `20230810-statements-3522-.pdf`'s
     three rows are identical in every visible column while their un-import
     confirmations differ by a statement balance. Null for every unique name,
     so the column that has to stay scannable is untouched for 218 of them. */
  const qualifierById = importRowQualifiers(files);

  // the rest of what un-importing takes with it — counted per file rather than
  // joined into the query above, where they would fan out against the rows
  const anchorsByFile = new Map(
    db
      .select({ importFileId: balanceAnchors.importFileId, n: count() })
      .from(balanceAnchors)
      .where(isNotNull(balanceAnchors.importFileId))
      .groupBy(balanceAnchors.importFileId)
      .all()
      .flatMap((r) => (r.importFileId === null ? [] : [[r.importFileId, r.n] as const])),
  );
  const periodsByFile = new Map(
    db
      .select({ importFileId: statementPeriods.importFileId, n: count() })
      .from(statementPeriods)
      .groupBy(statementPeriods.importFileId)
      .all()
      .map((r) => [r.importFileId, r.n] as const),
  );

  const periods = db
    .select({
      id: statementPeriods.id,
      accountName: accounts.name,
      periodStart: statementPeriods.periodStart,
      periodEnd: statementPeriods.periodEnd,
      reconciliation: statementPeriods.reconciliation,
      gapCents: statementPeriods.gapCents,
      marketChangeCents: statementPeriods.marketChangeCents,
    })
    .from(statementPeriods)
    .innerJoin(accounts, eq(statementPeriods.accountId, accounts.id))
    .orderBy(desc(statementPeriods.periodEnd))
    .all();

  const coverage = accountCoverage(db);
  // ⚠️ NOT the `gaps` below: that is statements that arrived and did not
  // reconcile. This is statements that never arrived at all.
  const missingStatements = statementGaps(db);
  const pulls = statementPulls(db);

  /**
   * The newest periods, with what each one actually PROVED — the page has
   * always fetched `periods` and rendered only three counts from it, so the
   * question "what did this statement establish?" had no answer anywhere.
   *
   * ⚠️ Bounded at 12 deliberately. `provenanceFor` runs four queries per
   * period, one of which scans the period's transactions; over all 219 periods
   * that is a page-load cost nobody asked for, and pass 31 already found a 16x
   * regression hiding behind exactly this shape of per-row work.
   */
  const RECENT_PERIODS = 12;
  /*
   * 🔴 The list and its footer counted every row of `statement_periods`; the
   * three tiles above them count the three VERDICTS. Measured on the owner's
   * /imports on 2026-09-03: "The 12 most recent periods" + "233 older periods
   * are not listed" is 245, over tiles reading 201 + 40 + 0 = 241. The four
   * missing from the tiles are `not_applicable` — a Chase spending report, a
   * balance-less export — documents that carried nothing to check, and two of
   * them sat in a list headed "What the statements proved". They are counted
   * out loud below instead, and the list is what the tiles are.
   */
  const evidence = periods.filter((p) => p.reconciliation !== "not_applicable");
  const notApplicable = periods.length - evidence.length;
  const recentPeriods = evidence.slice(0, RECENT_PERIODS).map((p) => ({
    ...p,
    provenance: provenanceFor(db, { kind: "statementPeriod", id: p.id }),
  }));

  const reconciled = periods.filter((p) => p.reconciliation === "reconciled").length;
  const valueAnchors = periods.filter((p) => p.reconciliation === "value_anchor").length;
  const gaps = periods.filter((p) => p.reconciliation === "gap");

  return (
    <>
      <PageHeader
        title="Imports"
        description="Drop statement exports here — CSV, OFX/QFX, and PDF. Every statement must reconcile: beginning + transactions = ending, to the cent, or it is flagged with its exact gap."
      />

      {error && <ErrorBanner message={error} />}

      <div className="space-y-6">
        <SurfaceCard>
          <h2 className="mb-1 text-sm font-medium">Upload statements</h2>
          <p className="mb-4 text-xs text-ink-muted">
            Select any mix of files — accounts are detected (and created) automatically. Re-importing
            a file is always safe: duplicates are a guaranteed no-op.
          </p>
          <form action={uploadStatementsAction} className="flex flex-wrap items-center gap-3">
            {/* `min-w-0` on both boxes: a file input's min-content is its
                button plus the filename text — 318px here, against 288px of
                page at the 320 floor. As a flex item the label defaults to that
                minimum and cannot shrink, so the page scrolls sideways; the
                input is then a grid item with the same automatic minimum, which
                is why zeroing only the label is not enough. `w-full` keeps it
                filling the column once it is allowed to shrink. */}
            <label className="grid min-w-0 gap-1 text-xs font-medium text-ink-muted">
              Statement files
              <input
                type="file"
                name="files"
                multiple
                required
                accept=".csv,.CSV,.ofx,.qfx,.QFX,.pdf"
                className="w-full min-w-0 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-accent-soft file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-accent"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
            >
              Import
            </button>
          </form>
        </SurfaceCard>

        <StatementSchedule pulls={pulls} />

        <CoveragePanel coverage={coverage} />

        {/* PASS 68. Coverage answers "does the money close"; this answers "which
            documents do I not have". They disagree on this ledger — Discover is
            VERIFIED and missing five statements — so both have to be asked. */}
        <StatementGapsPanel gaps={missingStatements} />

        {periods.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            <SurfaceCard className="p-4">
              <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Reconciled periods</p>
              <p className="figures mt-1 text-2xl font-semibold text-positive">{reconciled}</p>
            </SurfaceCard>
            <SurfaceCard className="p-4">
              <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Value anchors (investment)</p>
              <p className="figures mt-1 text-2xl font-semibold">{valueAnchors}</p>
            </SurfaceCard>
            <SurfaceCard className="p-4">
              <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Open gaps</p>
              <p className={`figures mt-1 text-2xl font-semibold ${gaps.length > 0 ? "text-negative" : ""}`}>
                {gaps.length}
              </p>
            </SurfaceCard>
          </div>
        )}

        {recentPeriods.length > 0 && (
          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">What the statements proved</h2>
            <p className="mb-3 text-xs text-ink-muted">
              The {recentPeriods.length} most recent periods. A period is only evidence if something in it could
              have failed — an investment statement records a value and absorbs any difference, so it never
              proves the rows add up.
            </p>
            <ul className="space-y-1.5">
              {recentPeriods.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
                  <span className="min-w-0">
                    <span className="text-ink">{p.accountName}</span>{" "}
                    <span className="figures text-ink-faint">
                      {p.periodStart} → {p.periodEnd}
                    </span>
                  </span>
                  {p.provenance && (
                    <ProvenancePopover
                      /* the badge beside it is a data cell and keeps its ISO; this
                         string is the button's accessible NAME and reads as a
                         sentence — "How Chase Sapphire, 2026-08-03 to 2026-09-02
                         is proven". `dayWindowLabel` names a window by its two
                         ends and drops only the repeated year. */
                      label={`${p.accountName}, ${dayWindowLabel(p.periodStart, p.periodEnd)}`}
                      provenance={p.provenance}
                      placement="bottom-end"
                    />
                  )}
                </li>
              ))}
            </ul>
            {evidence.length > recentPeriods.length && (
              <p className="mt-3 text-xs text-ink-faint">
                {evidence.length - recentPeriods.length} older periods are not listed.
              </p>
            )}
            {notApplicable > 0 && (
              <p className="mt-1 text-xs text-ink-faint">
                {notApplicable} imported {notApplicable === 1 ? "document" : "documents"} carried no balance to
                check — a spending report, an export without a closing figure — and{" "}
                {notApplicable === 1 ? "is" : "are"} neither a period above nor in the counts.
              </p>
            )}
          </SurfaceCard>
        )}

        {gaps.length > 0 && (
          <SurfaceCard className="border-negative/40">
            <h2 className="mb-3 text-sm font-medium text-negative">Unreconciled statements</h2>
            <ul className="space-y-2">
              {gaps.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span>
                    {p.accountName} · <span className="figures">{p.periodStart} → {p.periodEnd}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-negative">
                      gap <Money cents={p.gapCents ?? 0} className="font-medium" />
                    </span>
                    {/* every trigger's accessible name CONTAINS its visible
                        label (WCAG 2.5.3) and adds only which row it acts on */}
                    <ConfirmActionButton
                      action={acceptGapAction}
                      fields={{ statementPeriodId: p.id }}
                      triggerLabel="Accept as-is"
                      triggerAriaLabel={`Accept as-is — ${p.accountName}, ${p.periodStart} to ${p.periodEnd}`}
                      triggerClassName="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
                      title="Accept this statement as-is"
                      confirmLabel="Accept the gap"
                      radius={{
                        headline: `${p.accountName}'s listed transactions do not add up to its printed balances for ${p.periodStart} → ${p.periodEnd}. Accepting takes the statement as printed and keeps the difference.`,
                        lines: [
                          {
                            label: "Gap kept, permanently",
                            value: formatCents(p.gapCents ?? 0),
                            irreversible: true,
                          },
                          {
                            label: "Quarantined rows returning to analytics",
                            value: "all of this period's",
                          },
                        ],
                        reassurance:
                          "This period's transactions come back into every analytic, and the derived balance stays off the printed balance by the gap until a corrected file is imported.",
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-muted">
              A gap means the listed transactions don&apos;t sum to the printed balances — a missing or
              duplicated row. Its transactions are quarantined out of every analytic until you
              re-import a corrected file or accept the statement as-is.
            </p>
          </SurfaceCard>
        )}

        {files.length === 0 ? (
          <EmptyState
            title="Nothing imported yet"
            description="Statement ingestion is the trust layer: structured exports (OFX/QFX preferred, then CSV) carry transactions; monthly statement PDFs carry the printed balances that anchor reconciliation and the 2-year backfill."
          />
        ) : (
          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">
              Imported files <span className="figures text-ink-faint">({files.length})</span>
            </h2>
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-raised">
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="py-2 pr-2 font-medium">File</th>
                    <th className="py-2 pr-2 font-medium">Profile</th>
                    <th className="py-2 pr-2 text-right font-medium">Txns</th>
                    <th className="py-2 pr-2 font-medium">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id} className="border-b border-line/60 last:border-0">
                      {/* the reason a file failed has to be readable without
                          hovering — a bulk drop of statements is exactly when
                          a silent row is most likely to be scrolled past */}
                      <td className="max-w-[16rem] py-1.5 pr-2 text-[13px]">
                        {/* ⛔ the hover tooltip is the third place this row says
                            which file it is, and it must not be the one place
                            that still cannot tell two of them apart */}
                        <div
                          className="truncate"
                          title={importRowSubject(f.fileName, qualifierById.get(f.id) ?? null)}
                        >
                          {f.fileName}
                        </div>
                        {qualifierById.get(f.id) ? (
                          <div className="figures truncate text-[11px] text-ink-faint">
                            {qualifierById.get(f.id)}
                          </div>
                        ) : null}
                        {f.error ? (
                          <div className="truncate text-[11px] text-negative" title={f.error}>
                            {f.error}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-ink-muted">{f.parserProfile ?? "—"}</td>
                      <td className="figures py-1.5 pr-2 text-right text-xs">{f.txnCount}</td>
                      <td className="py-1.5 pr-2 text-xs" title={f.error ?? undefined}>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={`size-1.5 rounded-full ${STATUS_META[f.status].tone}`}
                          />
                          {STATUS_META[f.status].label}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <ConfirmActionButton
                          action={unimportFileAction}
                          fields={{ importFileId: f.id }}
                          formClassName="inline"
                          triggerLabel="un-import"
                          triggerAriaLabel={`un-import ${importRowSubject(f.fileName, qualifierById.get(f.id) ?? null)}`}
                          triggerClassName="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-negative"
                          title="Un-import this file"
                          tone="negative"
                          confirmLabel="Delete these transactions"
                          // a file with rows costs work to lose; an empty one
                          // costs nothing, so it does not earn a checkbox
                          acknowledgement={
                            f.txnCount > 0
                              ? "I understand these transactions are deleted"
                              : undefined
                          }
                          radius={{
                            headline: `Un-importing ${importRowSubject(f.fileName, qualifierById.get(f.id) ?? null)} deletes every row it brought in. There is no undo for this inside the app.`,
                            lines: [
                              {
                                label: "Transactions deleted",
                                value: countPhrase(f.txnCount, "transaction"),
                                irreversible: f.txnCount > 0,
                              },
                              {
                                label: "Categorized by you",
                                value: countPhrase(f.userCategorizedCount, "transaction"),
                                irreversible: f.userCategorizedCount > 0,
                              },
                              {
                                label: "Money leaving the ledger",
                                value: `${formatCents(f.inflowCents)} in · ${formatCents(f.outflowCents)} out`,
                              },
                              ...(f.duplicateSurvivorCount > 0
                                ? [
                                    {
                                      label: "…of which comes back",
                                      value: `${countPhrase(f.duplicateSurvivorCount, "row")} whose retired duplicate is restored`,
                                    },
                                  ]
                                : []),
                              {
                                label: "Recorded balances removed",
                                value: countPhrase(anchorsByFile.get(f.id) ?? 0, "balance"),
                              },
                              {
                                label: "Statement periods removed",
                                value: countPhrase(periodsByFile.get(f.id) ?? 0, "period"),
                              },
                            ],
                            /* 🔴 "uncategorized" is the opposite of what
                               happens. `importStatementFiles` runs
                               `categorizeAll` and `detectTransfers` on every
                               import that touched an account, so the rules, the
                               merchant map, the bank categories and transfer
                               detection all re-apply at once. Measured
                               2026-09-10 over the rows the 130 row-carrying
                               files own: 5,987 of 10,289 currently hold a
                               categorization from exactly those engines — rule
                               2,437 · merchant map 1,263 · transfer detection
                               1,108 · bank category 1,092 — and 127 of the 130
                               files have no uncategorized row at all. Only the
                               hand-categorized rows lose anything, which the
                               second clause already said.

                               🔴 …and it left out the recurring links, which an
                               import now writes too (2026-09-14): a charge joins
                               the live series already carrying its exact
                               description, and a commitment that has never
                               posted takes its exact first charge. Before that,
                               re-importing a statement brought its bills back
                               UNLINKED, and every surface that decides "paid"
                               from links called them owed. */
                            reassurance:
                              "The statement file itself stays on disk. Re-importing brings the rows back and re-runs the rules, the merchant map, transfer detection and recurring-series linking over them — what is lost is the hand-categorization.",
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SurfaceCard>
        )}
      </div>
    </>
  );
}
