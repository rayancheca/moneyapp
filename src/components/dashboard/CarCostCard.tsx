import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { RUNWAY_JARGON } from "@/lib/jargon";
import { formatCents } from "@/lib/money";
import type { CarCard as CarCardData } from "@/services/committed";

/**
 * What the car costs, all in.
 *
 * 🔴 Every figure is a COMMITMENT, not a measurement of running costs, and the
 * card says so. Measured 2026-08-24 the Car category held three rows — a down
 * payment, a dealer charge and a first premium — all of them the act of buying
 * the car, none of them the act of running it, and the first lease payment had
 * not happened yet. There is no post-car spending history to average, so the
 * card forecasts from the registered lease and policy and publishes the date
 * that evidence runs out.
 */
export function CarCostCard({ data }: { data: CarCardData }) {
  const { cost, book } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">The car</h3>
        <Link
          href="/recurring"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Commitments →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {formatCents(cost.allInMonthlyCents)}
        <span className="ml-1.5 inline-flex items-center gap-1.5 text-base font-normal text-ink-muted">
          a month, all in
          <InfoTip term="all in">{RUNWAY_JARGON.allIn}</InfoTip>
        </span>
      </p>
      {/* ⛔ "WOULD SPEND", NOT "SPEND". The denominator is
          `allInProjectedMonthlySpendCents` — the measured baseline with car
          spending taken OUT and the car's full monthly cost put back in — so it
          is a projection, not a measurement. Called "everything you spend" it
          contradicted the runway card two tiles away, which prints the measured
          average: $9,019.90 here against "What you spend a month $8,770.56"
          there, on one dashboard, with nothing saying they were different
          questions. Measured on the owner's ledger 2026-09-02. */}
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        That is {cost.allInSharePct.toFixed(1)}% of the{" "}
        <Money cents={cost.allInProjectedMonthlySpendCents} className="text-ink" /> a month you would spend
        with the car fully paid every month — not what the last six months measured.
      </p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          {/* 🔴 "every month" is the one thing this figure is NOT. Two rows below,
              this same card lists "Car insurance $1,807.45 × 5" against "Car
              lease $8,340.48 × 12", and since 2026-09-02 the runway card two
              tiles away says out loud that insurance "is billed 5 times rather
              than throughout". The card already discloses the end date at the
              bottom — and a disclosure underneath does not undo a wrong label on
              top. `monthlyCents` is the heaviest calendar month the book bills
              (`heaviestMonthOutflowCents`), which is exactly "a month while both
              are billed" — not one occurrence of each series, which priced a
              one-payment balance as a second premium on 2026-09-15. */}
          {/* ⚠️ The qualifier goes on its OWN line, the shape the row beneath
              already uses. As one truncating line it rendered "Lease and
              insurance, a month while …" in the grid lens at 1024 — clipped at
              exactly the words that carry the meaning, which is worse than the
              wrong label it replaced. */}
          <dt className="min-w-0 text-ink-muted">
            <span className="block truncate">Lease and insurance</span>
            <span className="block text-[11px] text-ink-faint">a month, while both are billed</span>
          </dt>
          <dd className="shrink-0">
            <Money cents={cost.monthlyCents} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="min-w-0 text-ink-muted">
            Paid up front, spread over the lease
            <span className="block text-[11px] text-ink-faint">
              {formatCents(cost.upfrontCents)} across {cost.upfrontAmortisedOverMonths} months
            </span>
          </dt>
          <dd className="shrink-0">
            <Money cents={cost.upfrontMonthlyCents} />
          </dd>
        </div>
      </dl>

      <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
        {book.lines.map((l) => (
          <div key={l.seriesId} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-ink-muted">{l.name}</span>
              {l.neverPosted && (
                <span className="shrink-0 text-[11px] text-ink-faint">not charged yet</span>
              )}
            </span>
            <span className="shrink-0 text-ink-muted">
              <Money cents={l.totalCents} />
              <span className="ml-1 text-[11px] text-ink-faint">× {l.occurrences}</span>
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <span className="font-medium">Committed over the next {cost.months} months</span>
          <Money cents={cost.committedCents} className="font-semibold" />
        </div>
      </div>

      {/* ONE tip for the chip above, however many rows wear it. A tooltip body
          is live DOM text even while closed, so repeating it per row both
          duplicates the sentence and breaks exact-count locators elsewhere —
          the rule BUDGET_JARGON states and the reason the pace verdict has no
          tip at all. */}
      {book.lines.some((l) => l.neverPosted) && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
          Some of these have not charged yet.
          <InfoTip term="not charged yet">{RUNWAY_JARGON.unevidenced}</InfoTip>
        </p>
      )}

      {/* ⛔ Names the commitment it dates — `carEvidenceCaption`, the runway
          card's own choice. It read "Insurance is evidenced through Nov 11,
          2026" on 2026-09-15: the earliest end of any car series, under a
          hard-coded word, beside a runway card saying Jan 11, 2027. */}
      {data.evidenceCaption && (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{data.evidenceCaption}</p>
      )}
    </SurfaceCard>
  );
}
