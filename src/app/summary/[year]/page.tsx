import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { InsightList } from "@/components/insights/InsightList";
import { yearInsights } from "@/services/year-insights";
import { summaryYears, yearSummaryView } from "@/services/year-summary";
import "./print.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string }>;
}): Promise<Metadata> {
  const { year } = await params;
  return { title: `${year} summary` };
}

/**
 * `/summary/[year]` — the year, grouped the way the owner separates his money.
 *
 * ⚠️ **A summary of records, not a tax document and not advice.** The page says
 * so in its own words, at the top, before any figure. Every line states the
 * rule it is standing on and how many rows and source documents are behind it,
 * because the point of this page is that the reader can check it rather than
 * trust it.
 *
 * This one gets printed, so it carries its own print stylesheet.
 */
export default async function YearSummaryPage({
  params,
}: {
  params: Promise<{ year: string }>;
}) {
  const { year: raw } = await params;
  const year = Number(raw);
  // a route segment is user input: reject anything that is not a plain year
  // before it reaches an engine that would throw inside a render
  if (!/^\d{4}$/.test(raw) || !Number.isInteger(year)) notFound();

  const db = getDb();
  const view = yearSummaryView(db, year, todayIso());
  const { summary, gambling, moneyWeightedReturn: mwr } = view;
  const years = summaryYears(db);
  const spending = yearInsights(db, year);

  return (
    <div className="summary-sheet mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        eyebrow="Year summary"
        title={String(year)}
        description={view.disclaimer}
        actions={
          <nav aria-label="Other years" className="no-print flex flex-wrap gap-1.5">
            {years.map((y) => (
              <Link
                key={y}
                href={`/summary/${y}`}
                aria-current={y === year ? "page" : undefined}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors duration-(--duration-fast) ${
                  y === year
                    ? "bg-ink text-surface"
                    : "border border-line text-ink-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {y}
              </Link>
            ))}
          </nav>
        }
      />

      {summary.isEmpty ? (
        <EmptyState
          title={`Nothing imported for ${year}`}
          description={
            years.length > 0
              ? `This ledger holds activity for ${years.join(", ")}.`
              : "No statements have been imported yet."
          }
        />
      ) : (
        <div className="space-y-6">
          {/* The three figures a reader most often conflates, set side by side
              so the difference between them is the point rather than something
              to be reconstructed. Deliberately NOT a big single number: the
              first draft printed the earned figure here and again as the first
              section's total, and two identical figures on one page make a
              reader check whether they differ. */}
          <SurfaceCard>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  Earned
                </dt>
                <dd className="figures mt-1 text-3xl font-semibold tracking-tight text-ink">
                  {formatCents(summary.earnedCents)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  All money in
                </dt>
                <dd className="figures mt-1 text-3xl font-semibold tracking-tight text-ink-muted">
                  {formatCents(summary.totalReceivedCents)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  Passed through
                </dt>
                <dd className="figures mt-1 text-3xl font-semibold tracking-tight text-ink-faint">
                  {formatCents(summary.excludedCents)}
                </dd>
              </div>
            </dl>
            {/* ⛔ THE SENTENCE DEFINES A THREE-TERM TOTAL AND MUST NAME THREE.
                `totalReceivedCents` is `earned + investment + notEarned`
                (lib/year-summary.ts, pinned by its own identity test), and this
                named only two: on the owner's ledger the investment term is
                7.5% of the 2025 headline ($2,866.35 of $38,409.23) and 4.7% of
                2026's, sitting under a section heading of its own while the
                definition of the figure above it did not mention it. */}
            <p className="mt-4 max-w-prose border-t border-line pt-3 text-sm leading-relaxed text-ink-muted">
              <span className="text-ink">Earned</span> is wages, tutoring and savings interest.{" "}
              <span className="text-ink">All money in</span> adds what your investments returned and
              what you received without earning it — a financial-aid refund is not a wage.{" "}
              <span className="text-ink">Passed through</span> is in neither: money that arrived and
              left again.
            </p>
          </SurfaceCard>

          {/*
              The one thread of money OUT on a page that is otherwise entirely
              money in. Mounted UNDER the three conflated figures rather than
              above them: a reader who has just been shown the difference
              between earned, received and passed-through is ready for a fourth
              subject, and a spending sentence printed before any of them would
              read as the page's headline.

              It withholds itself for 2022 and 2023 — see `yearInsights`, whose
              third gate refuses a comparison against a year the ledger only
              partly covers.
          */}
          {spending && <InsightList data={spending} heading="What you spent" />}

          {summary.sections
            .filter((s) => s.lines.length > 0)
            .map((section) => (
              <SurfaceCard key={section.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                    {section.title}
                  </h2>
                  <Money cents={section.totalCents} className="font-semibold" />
                </div>
                <dl className="mt-3 space-y-3 border-t border-line pt-3">
                  {section.lines.map((line) => (
                    <div key={line.id}>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="min-w-0 font-medium">{line.label}</dt>
                        <dd className="shrink-0">
                          <Money cents={line.amountCents} />
                        </dd>
                      </div>
                      <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                        {line.basis}
                      </p>
                      {line.counterCents !== undefined && (
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {formatCents(line.counterCents)} {line.counterLabel} — not subtracted from
                          the figure above, and not added to any total.
                        </p>
                      )}
                      {line.caveat && (
                        <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-negative">
                          {line.caveat}
                        </p>
                      )}
                      {/* a COUNT, not the filenames. Fordham's 26 rows span 12
                          monthly statements, and printing all twelve beside the
                          figure buried it — the full list is set once at the
                          foot of the page, where it is a reference rather than
                          noise repeated per line. */}
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {line.rowCount} {line.rowCount === 1 ? "row" : "rows"}
                        {line.sources.length > 0
                          ? ` · ${line.sources.length} source ${
                              line.sources.length === 1 ? "document" : "documents"
                            }`
                          : " · derived, no source document of its own"}
                      </p>
                    </div>
                  ))}
                </dl>
              </SurfaceCard>
            ))}

          {/* Gambling. Its own block, never a row in a total — pass 45 settled
              that winnings are not income, and it is net-negative anyway. */}
          {gambling.rowCount > 0 && (
            <SurfaceCard>
              <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                Gambling, kept separate
              </h2>
              <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-muted">Won</dt>
                  <dd>
                    <Money cents={gambling.wonCents} />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-muted">Lost</dt>
                  <dd className="figures text-negative">−{formatCents(gambling.lostCents)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
                  <dt className="font-medium">Net over {gambling.rowCount} rows</dt>
                  <dd>
                    <Money cents={gambling.netCents} flow />
                  </dd>
                </div>
              </dl>
              <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-muted">
                {/* 🔴 This said "losses are not treated as spending" on a page whose
                    "What you spent" figure includes them — Gambling is an expense
                    category in your own taxonomy, and every spending surface counts it.
                    What is true is narrower: winnings are not income HERE. */}
                Counted in none of the money-in totals above: winnings are not treated as income
                here. Losses are spending — your categories file Gambling as an expense — and they
                sit inside the figure under What you spent.
              </p>
            </SurfaceCard>
          )}

          <SurfaceCard>
            <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Investment return
            </h2>
            {mwr.computed ? (
              <>
                <p className="figures mt-1 text-2xl font-semibold tracking-tight text-ink">
                  {(mwr.rate * 100).toFixed(2)}%
                  <span className="ml-1.5 text-sm font-normal text-ink-muted">a year</span>
                </p>
                <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                  Money-weighted, from {formatCents(mwr.openCents)} on {mwr.fromDay} to{" "}
                  {formatCents(mwr.closeCents)} on {mwr.throughDay}, across {mwr.flowCount} cash
                  flows.
                  {mwr.partial
                    ? ` ${year} has not finished — this is an annual rate calculated from a part-year window, not the return so far.`
                    : ""}
                </p>
              </>
            ) : (
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
                Not calculated — {mwr.reason}.
              </p>
            )}
          </SurfaceCard>

          <SurfaceCard tone="leaf">
            <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Where these figures come from
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
              {summary.provenance.sourcedRowCount} of {summary.provenance.rowCount} rows behind this
              page trace to one of {summary.provenance.documents.length} imported{" "}
              {summary.provenance.documents.length === 1 ? "document" : "documents"}.
            </p>
            {summary.provenance.unsourcedLines.length > 0 && (
              <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
                {summary.provenance.unsourcedRowCount} do not:{" "}
                {summary.provenance.unsourcedLines.join(", ")}
                {summary.provenance.unsourcedLines.length === 1 ? " is" : " are"} derived from
                holdings rather than read off a statement.
              </p>
            )}
            {summary.provenance.documents.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {summary.provenance.documents.map((d) => (
                  <li
                    key={d}
                    className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-muted"
                  >
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </SurfaceCard>
        </div>
      )}
    </div>
  );
}
