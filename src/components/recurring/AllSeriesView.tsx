import Link from "next/link";
import { confirmSeriesAction, dismissSeriesAction } from "@/app/recurring/actions";
import { Money } from "@/components/ui/Money";
import { EmptyState } from "@/components/ui/EmptyState";
import { SERIES_EVIDENCE_LABEL, SERIES_EVIDENCE_NOTE, SUGGESTION_NOTE } from "@/lib/series-evidence";
import type { SeriesView } from "@/services/recurring";
import { CADENCE_LABEL, KIND_LABEL, overdueNote, shortDate } from "./labels";

/**
 * What each series already owes this month and nothing has covered — keyed by
 * series id, from the one `overdueForSeries` call the page makes. See
 * `overdueNote` for the day the Next column and the math table above it gave
 * two answers to the same question.
 */
export type OverdueBySeries = ReadonlyMap<string, { date: string; occurrenceCount: number }>;

/**
 * The "All" sub-view (ux-overhaul-plan §4.1): a suggestion queue up top —
 * freshly detected series awaiting a decision — then the confirmed series by
 * what their EVIDENCE says (`lib/series-evidence`): active, running late, never
 * billed, lapsed. Each row shows the effective amount (what the forecast
 * projects), the posted average beneath it when the two differ, the next
 * expected date and the annualized cost. Confirm / Not-recurring and Dismiss
 * reuse the existing value-preserving server actions.
 *
 * 🔴 This had two sections, Active and "Inactive", and on 2026-09-03 the second
 * held the owner's weekly pay and five never-billed commitments — each with a
 * Next date on its own row, each forecast one tab over. And the column headed
 * "Avg" printed the stored average, which for a hand-registered series is the
 * seed from registration: the lease read $559.89 beside "~$8,340.48/yr", two
 * numbers on one row that cannot both be true of one bill.
 */
export function AllSeriesView({
  series,
  overdueBySeries,
}: {
  series: SeriesView[];
  overdueBySeries: OverdueBySeries;
}) {
  const suggestions = series.filter((s) => s.status === "detected");
  const confirmed = series.filter((s) => s.status === "confirmed");
  const active = confirmed.filter((s) => s.evidence === "active");
  const late = confirmed.filter((s) => s.evidence === "running-late");
  const neverBilled = confirmed.filter((s) => s.evidence === "never-billed");
  const lapsed = confirmed.filter((s) => s.evidence === "lapsed");

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
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 id="rec-suggestions" className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Suggestions
              {/* Every other section on this tab says whether it is forecast;
                  this one looked least forecast and was the only one silent.
                  The words live in `lib/series-evidence` beside the rest of the
                  vocabulary. */}
              <span className="ml-1 font-normal normal-case tracking-normal text-ink-faint">
                — {SUGGESTION_NOTE}
              </span>
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

      <SeriesSection title="Active" note={SERIES_EVIDENCE_NOTE.active} series={active} overdueBySeries={overdueBySeries} />
      {late.length > 0 ? (
        <SeriesSection title="Running late" note={SERIES_EVIDENCE_NOTE["running-late"]} series={late} overdueBySeries={overdueBySeries} muted />
      ) : null}
      {neverBilled.length > 0 ? (
        <SeriesSection title="Never billed" note={SERIES_EVIDENCE_NOTE["never-billed"]} series={neverBilled} overdueBySeries={overdueBySeries} muted />
      ) : null}
      {lapsed.length > 0 ? (
        <SeriesSection title="Lapsed" note={SERIES_EVIDENCE_NOTE.lapsed} series={lapsed} overdueBySeries={overdueBySeries} muted />
      ) : null}
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
            {/* 🔴 A suggestion carries an evidence state like any other live
                series, and the count over the tab counts it. On 2026-09-04
                "4 series are running late" stood over a Running late section of
                two, because Amazon Prime and Rocket Money were late in here
                with nothing saying so. Printed only when it is not `active`,
                so the ordinary case stays quiet. */}
            {s.evidence !== "active" ? ` · ${SERIES_EVIDENCE_LABEL[s.evidence].toLowerCase()}` : ""}
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

function SeriesSection({
  title,
  note,
  series,
  overdueBySeries,
  muted,
}: {
  title: string;
  note: string;
  series: SeriesView[];
  overdueBySeries: OverdueBySeries;
  muted?: boolean;
}) {
  // an id may not contain a space, and "Running late" does
  const id = `rec-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          {title}
          <span className="ml-2 font-normal normal-case tracking-normal">— {note}</span>
        </h2>
        <span className="shrink-0 text-[11px] text-ink-faint">{series.length}</span>
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
                <th scope="col" className="px-3 py-2.5 text-right">Amount</th>
                <th scope="col" className="px-3 py-2.5">Next</th>
                <th scope="col" className="px-3 py-2.5 text-right">Annualized</th>
                <th scope="col" className="px-4 py-2.5 text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <SeriesRow key={s.id} series={s} overdue={overdueBySeries.get(s.id) ?? null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SeriesRow({
  series: s,
  overdue,
}: {
  series: SeriesView;
  overdue: { date: string; occurrenceCount: number } | null;
}) {
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
        {s.nextExpectedAmountCents !== null ? (
          <>
            {/* the effective amount — user override first — which is what the
                forecast projects and what ANNUALIZED beside it is built from */}
            <Money cents={s.nextExpectedAmountCents} flow />
            {/* 🔴 The measured average, from `postedAvgCents`. This read
                `amountCentsAvg` — the DETECTOR'S SEED, written at creation and
                never recomputed as rows are attached — under the words "posted
                avg", and on 2026-09-04 it was wrong about two of the three
                series that showed it: rent read "4 matched · posted avg
                -$2,285.70" of four charges averaging -$1,739.40, and the cash
                job "2 matched · posted avg +$1,046.00" of two deposits
                averaging +$723.50. The guard here already knew the seed was
                unreliable — "a never-billed series has no average, whatever its
                stored seed says" — and only covered the zero-matched case. */}
            {s.postedAvgCents !== null && s.postedAvgCents !== s.nextExpectedAmountCents ? (
              <span className="figures block text-[10px] text-ink-faint">
                posted avg <Money cents={s.postedAvgCents} flow />
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        {s.nextExpectedOn ? <span className="figures">{shortDate(s.nextExpectedOn)}</span> : <span className="text-ink-faint">—</span>}
        {/* 🔴 The column walks FORWARD from today, so a charge that came due on
            the 1st and never posted was invisible here — while the math table
            at the top of this same page named it: "came due 2026-09-01 and has
            not posted". Same call as the forecast, the runway, /budgets and the
            bill's own page. */}
        {overdue && (
          <span className="figures mt-0.5 block text-[10px] text-warning">
            {overdueNote(overdue.date, overdue.occurrenceCount)}
          </span>
        )}
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
