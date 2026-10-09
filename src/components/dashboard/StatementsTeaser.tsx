import Link from "next/link";
import { StatementAccountName } from "@/components/imports/StatementAccountName";
import { Icon } from "@/components/shell/Icon";
import { pullDemand } from "@/lib/statement-cadence";
import type { AccountStatementPull } from "@/services/statement-pulls";

/**
 * "Go and download these" on the dashboard — the nag half of the Statement
 * schedule panel on /imports, which keeps the full per-account reasoning.
 *
 * Present and calm when there is nothing to do, the same contract ToReviewCard
 * holds: a teaser that disappears when it is satisfied cannot tell you it is
 * satisfied, and on a home screen the absence of a warning has to mean
 * something. It only ever lists accounts with a close already BEHIND them —
 * every other account is quiet on purpose, which is this ledger's normal state
 * between monthly uploads.
 *
 * Every string comes from lib/statement-cadence.ts, shared with the /imports
 * panel, so the two surfaces cannot word the same fact differently — and each name opens the bank's statements site
 * through the panel's own `StatementAccountName` (lib/statement-sites.ts), so they cannot link it differently either.
 */
export function StatementsTeaser({ pulls }: { pulls: readonly AccountStatementPull[] }) {
  if (pulls.length === 0) return null; // no account issues statements at all

  const due = pulls.filter((p) => p.status === "due" || p.status === "behind");
  const outstanding = due.reduce((n, p) => n + p.closesDue, 0);

  return (
    <section aria-labelledby="statements-teaser-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="statements-teaser-heading" className="flex items-baseline gap-2 text-sm font-medium">
          Statements
          {outstanding > 0 && (
            <span className="figures rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              {outstanding}
            </span>
          )}
        </h2>
        <Link
          href="/imports"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          {outstanding > 0 ? "Import →" : "Schedule →"}
        </Link>
      </div>

      {due.length === 0 ? (
        <div className="flex items-center gap-2 rounded-(--radius-card) border border-line bg-surface-raised px-4 py-5 text-sm text-ink-muted">
          <Icon name="check" className="size-4 text-positive" />
          Every account is inside its own cycle — nothing to download.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-(--radius-card) border border-line bg-surface-raised">
          {due.map((p) => (
            <li key={p.accountId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3">
              <StatementAccountName name={p.accountName} site={p.site} />
              <span className="text-xs text-warning">{pullDemand(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
