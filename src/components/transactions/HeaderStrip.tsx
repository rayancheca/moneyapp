import { classifyMerchantsAction, runCategorizationAction } from "@/app/transactions/actions";
import type { CoverageStats } from "@/services/categorize";

interface HeaderStripProps {
  coverage: CoverageStats;
  pendingMerchants: number;
  /** current filter query string — actions return the user here */
  returnQuery: string;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className={`figures mt-0.5 text-lg font-medium ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

/** Coverage + queue stats with the two engine triggers. Thin UI over the services. */
export function HeaderStrip({ coverage, pendingMerchants, returnQuery }: HeaderStripProps) {
  return (
    <section
      aria-label="Categorization status"
      className="mb-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-(--radius-card) border border-line bg-surface-raised p-4 shadow-[0_1px_2px_oklch(0%_0_0/0.04)]"
    >
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Stat label="Coverage" value={`${coverage.coveragePct}%`} />
        <Stat
          label="Needs review"
          value={String(coverage.needsReview)}
          tone={coverage.needsReview > 0 ? "text-warning" : "text-positive"}
        />
        <Stat label="Queued for Claude" value={String(pendingMerchants)} />
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <form action={runCategorizationAction}>
          <input type="hidden" name="returnTo" value={returnQuery} />
          <button
            type="submit"
            className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
          >
            Run categorization
          </button>
        </form>
        <form action={classifyMerchantsAction}>
          <input type="hidden" name="returnTo" value={returnQuery} />
          <button
            type="submit"
            disabled={pendingMerchants === 0}
            className="rounded-md border border-line bg-surface-raised px-3.5 py-2 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line"
          >
            Classify {pendingMerchants} merchant{pendingMerchants === 1 ? "" : "s"} with Claude
          </button>
        </form>
      </div>
    </section>
  );
}
