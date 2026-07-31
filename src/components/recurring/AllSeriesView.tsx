import Link from "next/link";
import { confirmSeriesAction, dismissSeriesAction } from "@/app/recurring/actions";
import { Money } from "@/components/ui/Money";
import { EmptyState } from "@/components/ui/EmptyState";
import type { SeriesView } from "@/services/recurring";
import { CADENCE_LABEL, KIND_LABEL, shortDate } from "./labels";

/**
 * The "All" sub-view (ux-overhaul-plan §4.1): a suggestion queue up top —
 * freshly detected series awaiting a decision — then the Active and Inactive
 * sections of confirmed series, each row showing the stored statistics
 * (cadence, avg ±σ, next expected, annualized cost). Confirm / Not-recurring and
 * Dismiss reuse the existing value-preserving server actions.
 */
export function AllSeriesView({ series }: { series: SeriesView[] }) {
  const suggestions = series.filter((s) => s.status === "detected");
  const active = series.filter((s) => s.status === "confirmed" && s.isActive);
  const inactive = series.filter((s) => s.status === "confirmed" && !s.isActive);

  if (series.filter((s) => s.status !== "dismissed" && s.status !== "ended").length === 0) {
    return (
      <EmptyState
        title="No active series"
        description="Confirmed and newly detected series appear here. Run “Detect now” after importing or categorizing to surface subscriptions, bills, and paychecks."
      />
    );
  }

  return (
    <div className="space-y-8">
      {suggestions.length > 0 ? (
        <section aria-labelledby="rec-suggestions">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="rec-suggestions" className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Suggestions
            </h2>
            <span className="text-[11px] text-ink-faint">{suggestions.length} to review</span>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => (
              <SuggestionCard key={s.id} series={s} />
            ))}
          </ul>
        </section>
      ) : null}

      <SeriesSection title="Active" series={active} />
      {inactive.length > 0 ? <SeriesSection title="Inactive" series={inactive} muted /> : null}
    </div>
  );
}

function SuggestionCard({ series: s }: { series: SeriesView }) {
  return (
    <li className="rounded-(--radius-card) border border-accent/30 bg-accent-soft/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/recurring/${s.id}`} className="truncate font-medium hover:text-accent hover:underline">
            {s.name}
          </Link>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            Detected: {KIND_LABEL[s.kind]} · {CADENCE_LABEL[s.cadence]}
            {s.nextExpectedAmountCents !== null ? (
              <>
                {" · about "}
                <Money cents={s.nextExpectedAmountCents} />
              </>
            ) : null}
          </p>
        </div>
        {s.confidence !== null ? (
          <span className="figures shrink-0 text-[11px] text-ink-faint">{Math.round(s.confidence * 100)}%</span>
        ) : null}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <form action={confirmSeriesAction}>
          <input type="hidden" name="seriesId" value={s.id} />
          <button
            type="submit"
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
          >
            Confirm
          </button>
        </form>
        <form action={dismissSeriesAction}>
          <input type="hidden" name="seriesId" value={s.id} />
          <button
            type="submit"
            className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
          >
            Not recurring
          </button>
        </form>
      </div>
    </li>
  );
}

function SeriesSection({ title, series, muted }: { title: string; series: SeriesView[]; muted?: boolean }) {
  return (
    <section aria-labelledby={`rec-${title}`}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id={`rec-${title}`} className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          {title}
        </h2>
        <span className="text-[11px] text-ink-faint">{series.length}</span>
      </div>
      {series.length === 0 ? (
        <p className="rounded-(--radius-card) border border-dashed border-line px-4 py-3 text-xs text-ink-faint">
          {title === "Active" ? "No active series yet — confirm a suggestion above." : "None."}
        </p>
      ) : (
        // `contain-paint` on top of `overflow-x-auto`: six columns give this
        // table a 589px min-content, and although the wrapper's own box fits
        // (408px) and scrolls internally, it still propagated that width to the
        // document — /recurring?tab=all really scrolled sideways, 270px at 320
        // and 150px at 440. Measured: containing BOTH wrappers takes the
        // document from 590 back to 440; containing either alone does not.
        // Nothing here is meant to paint outside the card, so this only tells
        // the browser what the rounded border already implies.
        <div className={`overflow-x-auto contain-paint rounded-(--radius-card) border border-line bg-surface-raised ${muted ? "opacity-70" : ""}`}>
          <table className="w-full text-sm">
            <caption className="sr-only">{title} recurring series</caption>
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
                <th scope="col" className="px-4 py-2.5">Series</th>
                <th scope="col" className="px-3 py-2.5">Cadence</th>
                <th scope="col" className="px-3 py-2.5 text-right">Avg</th>
                <th scope="col" className="px-3 py-2.5">Next</th>
                <th scope="col" className="px-3 py-2.5 text-right">Annualized</th>
                <th scope="col" className="px-4 py-2.5 text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <SeriesRow key={s.id} series={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SeriesRow({ series: s }: { series: SeriesView }) {
  return (
    <tr className="border-b border-line last:border-b-0">
      <th scope="row" className="px-4 py-3 text-left font-medium">
        <Link href={`/recurring/${s.id}`} className="hover:text-accent hover:underline">
          {s.name}
        </Link>
        <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
          {KIND_LABEL[s.kind]} · {s.matchedCount} matched
        </span>
      </th>
      <td className="px-3 py-3 text-ink-muted">{CADENCE_LABEL[s.cadence]}</td>
      <td className="px-3 py-3 text-right">
        {s.amountCentsAvg !== null ? (
          <>
            <Money cents={s.amountCentsAvg} flow />
            {s.amountCentsStddev !== null && s.amountCentsStddev > 0 ? (
              <span className="figures block text-[10px] text-ink-faint">
                ±{(s.amountCentsStddev / 100).toFixed(2)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        {s.nextExpectedOn ? <span className="figures">{shortDate(s.nextExpectedOn)}</span> : <span className="text-ink-faint">—</span>}
      </td>
      <td className="px-3 py-3 text-right text-ink-muted">
        {s.annualizedCents !== null ? (
          <span className="figures">~<Money cents={s.annualizedCents} />/yr</span>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <form action={dismissSeriesAction}>
          <input type="hidden" name="seriesId" value={s.id} />
          <button
            type="submit"
            className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
          >
            Dismiss
          </button>
        </form>
      </td>
    </tr>
  );
}
