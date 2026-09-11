import {
  classifyMerchantsAction,
  runCategorizationAction,
  stopClassifyAction,
} from "@/app/transactions/actions";
import { formatIsoInstantLong } from "@/lib/format-instant";
import { formatCents } from "@/lib/money";
import type { CoverageStats } from "@/services/categorize";
import {
  EST_USD_PER_MERCHANT,
  type ClaudeRunResult,
  type ClaudeRunState,
} from "@/services/claude-categorize";

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

/**
 * ⛔ THROUGH `formatCents`, like every other figure in the app. These are
 * DOLLARS, not cents, which is why this had its own formatter — and its own
 * formatter meant no thousands separator, so an AI cap set to 1500 would have
 * printed "$1500.00" beside a page of "$1,500.00"s. The unit conversion belongs
 * here; the notation does not.
 */
function usd(n: number): string {
  return formatCents(Math.round(n * 100));
}

/** a provider error body runs to thousands of characters; the strip has to stay
 *  readable at 440px, so the cause is clamped and the rest dropped */
const MAX_CAUSE_CHARS = 160;

/**
 * The failed-run line. A batch that throws is recorded with `failed`, its cause,
 * and whatever counters had already committed — so the "Last Claude run" line
 * reads exactly like a successful no-op unless the failure is said out loud.
 * The redirect's one-shot ?error= is long gone by the time the user comes back
 * to the page, and this is the only surviving record. Null when nothing failed.
 */
export function failedRunMessage(
  run: Pick<ClaudeRunResult, "failed" | "error" | "classified">,
): string | null {
  if (!run.failed) return null;
  // a stored run from before the failure fields existed, or a throw with a blank
  // message, still has to say something
  const detail = (run.error ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  const cause =
    detail === ""
      ? "Unexpected error"
      : detail.length > MAX_CAUSE_CHARS
        ? `${detail.slice(0, MAX_CAUSE_CHARS).trimEnd()}…`
        : detail;
  // committed batches stay committed: the counters above the line are partial
  // progress, not a result
  const partial = run.classified > 0 ? " · the counts above are partial progress, not a result" : "";
  return `Claude run failed: ${cause}${partial}`;
}

/** Coverage + queue stats with the two engine triggers. Thin UI over the services. */
export function HeaderStrip({ coverage, pendingMerchants, spend, runState, returnQuery }: HeaderStripProps) {
  const estUsd = pendingMerchants * EST_USD_PER_MERCHANT;
  const { isRunning, lastRun } = runState;
  // a live run supersedes the last one, so a stale failure never shouts over it
  const failure = !isRunning && lastRun ? failedRunMessage(lastRun) : null;

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
          {lastRun.failed && <span className="text-negative"> · failed</span>}
          {/* ⛔ `at` is a UTC instant. Slicing it printed 16:06 for a run that
              happened at 12:06 here, with nothing on the page saying which zone
              it meant. `lib/format-instant` renders it on the reader's clock. */}
          <span className="text-ink-faint"> · {formatIsoInstantLong(lastRun.at)}</span>
        </p>
      )}
      {/* the cause gets its own line: a raw provider message wraps, and role="alert"
          announces it on the client navigation back from the failed action */}
      {failure && (
        <p role="alert" className="mt-1 text-xs text-negative">
          {failure}
        </p>
      )}
    </section>
  );
}
