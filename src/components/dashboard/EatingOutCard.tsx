import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import type { EatingOutCard as EatingOutCardData } from "@/services/eating-out";

/**
 * What eating out costs — the biggest real line in the ledger, and the one the
 * `Food` total hides.
 *
 * The headline is a MONTHLY rate rather than the window total, because that is
 * the figure that compares to the runway card's "what you spend a month" three
 * inches away. The window total is still printed, in the subtotal row, so the
 * reader can see what the rate was divided from.
 *
 * The comparison to groceries is the whole point of the card. On its own
 * "$1,963 a month" is a number; against "$194 a month on groceries" it is a
 * fact about how he lives, and it is the one thing here that could change a
 * decision.
 */
export function EatingOutCard({ data }: { data: EatingOutCardData }) {
  const {
    monthlyCents,
    groceriesMonthlyCents,
    multipleOfGroceries,
    eatingOut,
    groceries,
    totalSpentCents,
    totalCount,
    averageTicketCents,
    purchasesPerDay,
    months,
    fromMonth,
    toMonth,
  } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Eating out</h3>
        <Link
          href="/spending"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Spending →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {formatCents(monthlyCents)}
        <span className="ml-1.5 text-base font-normal text-ink-muted">a month</span>
      </p>

      {/* the comparison, not the number, is the point — so it gets the sentence */}
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        {multipleOfGroceries === null ? (
          <>No groceries in this window, so everything you ate was bought ready to eat.</>
        ) : (
          <>
            <span className="font-medium text-ink">{multipleOfGroceries.toFixed(1)}×</span> what you spend on
            groceries, which comes to <Money cents={groceriesMonthlyCents} className="text-ink" /> a month.
          </>
        )}
      </p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {eatingOut.map((l) => (
          <div key={l.name} className="flex items-baseline justify-between gap-3">
            <dt className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-ink-muted">{l.name}</span>
              <span className="shrink-0 text-[11px] text-ink-faint">
                {l.count} {l.unit}
              </span>
            </dt>
            <dd className="shrink-0">
              <Money cents={l.spentCents} />
            </dd>
          </div>
        ))}

        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="flex min-w-0 items-baseline gap-1.5">
            <span className="font-medium">Eating out</span>
            <span className="shrink-0 text-[11px] text-ink-faint">{totalCount} purchases</span>
          </dt>
          <dd className="shrink-0">
            <Money cents={totalSpentCents} className="font-semibold" />
          </dd>
        </div>

        {/* Groceries sit BELOW the subtotal rule, deliberately: they are the
            thing being compared against, not another eating-out row. Inside the
            subtotal they would inflate the total the card exists to isolate.
            ⚠️ But below it without a word they read as part of it anyway — a
            row under a bold total looks like a component of it. "for
            comparison" is what stops the column being added up wrongly. */}
        <div className="flex items-baseline justify-between gap-3 pt-1">
          <dt className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-ink-faint">{groceries.name}</span>
            <span className="shrink-0 text-[11px] text-ink-faint">
              {groceries.count} {groceries.unit} · for comparison
            </span>
          </dt>
          <dd className="shrink-0 text-ink-faint">
            <Money cents={groceries.spentCents} />
          </dd>
        </div>
      </dl>

      {averageTicketCents !== null && (
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3 text-sm">
          <span className="flex items-center gap-1.5 text-ink-muted">
            Average ticket
            <InfoTip term="average ticket">
              What one eating-out purchase costs on average — the total above divided by the number of purchases,
              refunds already netted off both.
            </InfoTip>
          </span>
          <Money cents={averageTicketCents} />
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        That is {purchasesPerDay.toFixed(1)} purchases a day. Averaged over {months} complete months, {fromMonth} to{" "}
        {toMonth}. This month is still running and is not counted.
      </p>
    </SurfaceCard>
  );
}
