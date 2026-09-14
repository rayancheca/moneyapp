import Link from "next/link";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import type { MerchantProfile } from "@/lib/merchant-profile";
import type { MerchantIntelligence } from "@/services/merchants";

/**
 * The three things a merchant page exists to say, and one it often must not.
 *
 * 🔴 **"You spend $X a month here" is withheld for two thirds of merchants.**
 * Measured on the real ledger: 454 of 702 merchants have exactly one visit. The
 * engine decides — `lib/merchant-profile` returns a null rate with the sentence
 * explaining why, and this file renders whichever it was given rather than
 * choosing again.
 *
 * 🔴 **The typical visit is the MEDIAN.** Target's mean is $34.40 against a
 * $16.75 median, so leading with the mean would describe a trip he mostly does
 * not make. The mean appears only when it materially disagrees, and then it is
 * labelled as what it is.
 */

function YearBar({ year, maxCents }: { year: MerchantProfile["years"][number]; maxCents: number }) {
  // width from the largest year, so the bars compare to each other and not to
  // an axis nobody drew
  const pct = maxCents > 0 ? (year.cents / maxCents) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="figures w-10 shrink-0 text-ink-muted">{year.year}</span>
      <span className="relative h-4 min-w-0 flex-1 rounded-sm bg-surface-sunken">
        <span
          className="absolute inset-y-0 left-0 rounded-sm bg-accent/70"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="shrink-0 text-right">
        <Money cents={year.cents} />
        {/* the window the figure covers, decided by the engine: "so far" for the
            running year, "from Aug 25" for the year the ledger opens in */}
        {year.mark && <span className="ml-1 text-[11px] text-ink-faint">{year.mark}</span>}
      </span>
    </div>
  );
}

export function MerchantProfileCards({ intelligence }: { intelligence: MerchantIntelligence }) {
  const { profile: p, cadence } = intelligence;
  if (p.visitCount === 0) return null;

  const maxYearCents = Math.max(...p.years.map((y) => y.cents), 0);

  return (
    <>
      <SurfaceCard>
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          What this merchant costs
        </h2>

        {p.monthlyCents === null ? (
          <p className="mt-1 text-2xl font-semibold tracking-tight text-ink-muted">
            No monthly rate
          </p>
        ) : (
          <p className="figures mt-1 text-3xl font-semibold tracking-tight text-ink">
            {formatCents(p.monthlyCents)}
            <span className="ml-1.5 text-base font-normal text-ink-muted">a month</span>
          </p>
        )}
        {/* the sentence and the figure leave the engine together, so a rate can
            never sit beside an explanation of a different rate */}
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{p.monthlyBasis}</p>
        {/* 🔴 The gap between the heading's row count and this card's purchase
            count was invisible. On `Zelle` it is 138 of 140, and the basis line
            above it read "2 visits. Too few to describe a monthly habit." of a
            merchant the ledger holds 140 rows for. */}
        {p.countedNote && (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-faint">{p.countedNote}</p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Typical visit</dt>
            <dd className="mt-0.5">
              <Money cents={p.medianTicketCents} />
            </dd>
            {p.ticketIsSkewed && (
              <dd className="mt-0.5 text-[11px] leading-snug text-ink-faint">
                mean {formatCents(p.meanTicketCents)} — a few large visits pull it up
              </dd>
            )}
          </div>
          <div>
            {/* "Purchases", not "visits" or "transactions": the heading above
                counts every active row at this merchant, and this counts only
                the expense-kind ones that cost money. Target reads 79 and 77 —
                the two refunds are transactions and are not purchases, and
                calling both the same thing leaves the reader unable to
                reconcile them. */}
            <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Purchases</dt>
            <dd className="figures mt-0.5">{p.visitCount}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Total</dt>
            <dd className="mt-0.5">
              <Money cents={p.totalCents} />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Seen</dt>
            <dd className="figures mt-0.5 text-xs leading-snug">
              {p.firstSeen}
              <br />
              {p.lastSeen}
            </dd>
          </div>
        </dl>

        {cadence && (
          <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
            Billed {cadence.cadence} as{" "}
            <Link
              href={`/recurring/${cadence.seriesId}`}
              className="text-ink underline decoration-line underline-offset-2 transition-colors duration-(--duration-fast) hover:decoration-ink"
            >
              {cadence.name}
            </Link>
            {cadence.status === "detected" ? " — detected, not yet confirmed." : "."}
          </p>
        )}
      </SurfaceCard>

      {p.years.length > 1 && (
        <SurfaceCard>
          <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            Year on year
          </h2>
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            {p.years.map((y) => (
              <YearBar key={y.year} year={y} maxCents={maxYearCents} />
            ))}
          </div>
          {/* 🔴 It said "The current year is still running, so it is marked and
              is not a like-for-like comparison with the closed years above it" —
              of a newest-first list, under a 2022 the ledger holds Aug 25 on of.
              The engine names each marked year's reason now. */}
          {p.yearsNote && <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{p.yearsNote}</p>}
        </SurfaceCard>
      )}

      {p.categoryMix.length > 1 && (
        <SurfaceCard>
          <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            Where it lands
          </h2>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            {p.categoryMix.map((c) => (
              <div key={c.name} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 truncate text-ink-muted">{c.name}</dt>
                <dd className="shrink-0">
                  <Money cents={c.cents} />
                  <span className="ml-1.5 text-[11px] text-ink-faint">{c.share}</span>
                </dd>
              </div>
            ))}
          </dl>
        </SurfaceCard>
      )}
    </>
  );
}
