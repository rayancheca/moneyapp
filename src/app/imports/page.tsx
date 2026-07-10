import type { Metadata } from "next";
import { count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { importFiles, statementPeriods, type ImportStatus } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
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

export default function ImportsPage() {
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
    })
    .from(importFiles)
    .leftJoin(transactions, eq(transactions.importFileId, importFiles.id))
    .groupBy(importFiles.id)
    .orderBy(desc(importFiles.importedAt))
    .all();

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

  const reconciled = periods.filter((p) => p.reconciliation === "reconciled").length;
  const valueAnchors = periods.filter((p) => p.reconciliation === "value_anchor").length;
  const gaps = periods.filter((p) => p.reconciliation === "gap");

  return (
    <>
      <PageHeader
        title="Imports"
        description="Drop statement exports here — CSV, OFX/QFX, and PDF. Every statement must reconcile: beginning + transactions = ending, to the cent, or it is flagged with its exact gap."
      />
      <div className="space-y-6">
        <SurfaceCard>
          <h2 className="mb-1 text-sm font-medium">Upload statements</h2>
          <p className="mb-4 text-xs text-ink-muted">
            Select any mix of files — accounts are detected (and created) automatically. Re-importing
            a file is always safe: duplicates are a guaranteed no-op.
          </p>
          <form action={uploadStatementsAction} className="flex flex-wrap items-center gap-3">
            <label className="grid gap-1 text-xs font-medium text-ink-muted">
              Statement files
              <input
                type="file"
                name="files"
                multiple
                required
                accept=".csv,.CSV,.ofx,.qfx,.QFX,.pdf"
                className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-accent-soft file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-accent"
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
                    <form action={acceptGapAction}>
                      <input type="hidden" name="statementPeriodId" value={p.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
                      >
                        Accept as-is
                      </button>
                    </form>
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
                      <td className="max-w-[16rem] truncate py-1.5 pr-2 text-[13px]" title={f.fileName}>
                        {f.fileName}
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
                        <form action={unimportFileAction} className="inline">
                          <input type="hidden" name="importFileId" value={f.id} />
                          <button
                            type="submit"
                            className="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-negative"
                          >
                            un-import
                          </button>
                        </form>
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
