import {
  classifyMerchantsAction,
  runCategorizationAction,
  stopClassifyAction,
} from "@/app/transactions/actions";
import type { CoverageStats } from "@/services/categorize";
import { EST_USD_PER_MERCHANT, type ClaudeRunState } from "@/services/claude-categorize";

interface HeaderStripProps {
  coverage: CoverageStats;
  pendingMerchants: number;
  /** month-to-date AI spend vs the hard cap (Settings) */
  spend: { monthUsd: number; capUsd: number; overCap: boolean };
  runState: ClaudeRunState;
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

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Coverage + queue stats with the two engine triggers. Thin UI over the services. */
export function HeaderStrip({ coverage, pendingMerchants, spend, runState, returnQuery }: HeaderStripProps) {
  const estUsd = pendingMerchants * EST_USD_PER_MERCHANT;
  const { isRunning, lastRun } = runState;

  return (
    <section
      aria-label="Categorization status"
      className="mb-6 rounded-(--radius-card) border border-line bg-surface-raised p-4 shadow-[0_1px_2px_oklch(0%_0_0/0.04)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <dl className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Stat label="Coverage" value={`${coverage.coveragePct}%`} />
          <Stat
            label="Needs review"
            value={String(coverage.needsReview)}
            tone={coverage.needsReview > 0 ? "text-warning" : "text-positive"}
          />
          <Stat label="Queued for Claude" value={String(pendingMerchants)} />
          <Stat
            label="AI spend (month)"
            value={`${usd(spend.monthUsd)} / ${usd(spend.capUsd)}`}
            tone={spend.overCap ? "text-negative" : undefined}
          />
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <form action={runCategorizationAction}>
            <input type="hidden" name="returnTo" value={returnQuery} />
            <button
              type="submit"
              title="Deterministic rules + merchant map + bank categories — free, no API calls"
              className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
            >
              Run categorization
            </button>
          </form>
          {isRunning ? (
            <form action={stopClassifyAction}>
              <input type="hidden" name="returnTo" value={returnQuery} />
              <button
                type="submit"
                className="rounded-md border border-negative/40 px-3.5 py-2 text-sm font-medium text-negative transition-colors duration-(--duration-fast) hover:border-negative"
              >
                Stop Claude run
              </button>
            </form>
          ) : (
            <div className="text-right">
              <form action={classifyMerchantsAction}>
                <input type="hidden" name="returnTo" value={returnQuery} />
                <button
                  type="submit"
                  disabled={pendingMerchants === 0 || spend.overCap}
                  className="rounded-md border border-line bg-surface-raised px-3.5 py-2 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line"
                >
                  Classify {pendingMerchants} merchant{pendingMerchants === 1 ? "" : "s"} with Claude
                </button>
              </form>
              {pendingMerchants > 0 && !spend.overCap && (
                <div className="mt-1 text-[11px] text-ink-faint">
                  ≈ {estUsd < 0.01 ? "<$0.01" : usd(estUsd)} est. · stops at the monthly cap
                </div>
              )}
              {spend.overCap && (
                <div className="mt-1 text-[11px] text-negative">monthly cap reached — raise it in Settings</div>
              )}
            </div>
          )}
        </div>
      </div>

      {isRunning && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted" role="status">
          Claude classification is running — it spends against the cap batch by batch. Stop takes
          effect after the current batch; refresh to see progress.
        </p>
      )}
      {!isRunning && lastRun && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">
          Last Claude run: <span className="figures">{lastRun.classified}</span> transactions
          classified
          {lastRun.needsReview > 0 && (
            <>
              , <span className="figures">{lastRun.needsReview}</span> flagged for review
            </>
          )}{" "}
          · <span className="figures">{usd(lastRun.estCostUsd)}</span>
          {lastRun.stopped && <span className="text-warning"> · stopped early</span>}
          {lastRun.capReached && <span className="text-negative"> · monthly cap reached</span>}
          <span className="text-ink-faint"> · {lastRun.at.slice(0, 16).replace("T", " ")}</span>
        </p>
      )}
    </section>
  );
}
