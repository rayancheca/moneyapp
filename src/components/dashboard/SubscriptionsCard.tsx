import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { formatCents } from "@/lib/money";
import { baselineSpan } from "@/lib/committed";
import type { SubscriptionLine, SubscriptionsCard as SubscriptionsCardData } from "@/services/subscriptions-card";

/**
 * The recurring bills, and the ones that stopped.
 *
 * 🔴 The headline is labelled "still forecast", NOT "what you pay". Measured
 * 2026-08-26 the two are different numbers and the gap is the point: the app
 * forecasts $991.59 a month while $4,158.01 more sits registered and silent,
 * and the largest silent line is the rent — one day past its own tolerance
 * because August's statement has not been imported yet. A headline reading
 * "$991.59 a month on recurring things" would be false in both directions at
 * once: it omits a rent he is certainly still paying, and 92.9% of what it does
 * contain has never been billed by anyone. So the label describes what the app
 * is DOING, which is the only claim the ledger can actually support.
 *
 * Every figure and every branch below comes from one `subscriptionsCard()`
 * call. Nothing here divides, sums or compares — the words and the numbers were
 * chosen together in the service so they cannot drift apart.
 *
 * ⛔ "not charged yet" is deliberately NOT the phrase for a never-billed row —
 * that string is reserved by the car card and read by an exact-count locator,
 * and both cards render on this dashboard. "Never billed" says the same thing
 * without breaking somebody else's assertion.
 */

/** "1 day" / "792 days" — the tolerance rows read as prose, not as `1d`. */
function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** What `Evidence` reads — a one-off has no tolerance to be past, so that one is optional. */
type EvidenceFacts = Pick<SubscriptionLine, "neverBilled" | "lastMatchedLabel" | "billedWithLabel"> & {
  daysPastTolerance?: number | null;
};

/**
 * A row's evidence, in its own voice: when it last charged, or that it never has. `lead` goes first when the row
 * has more to say about itself — a one-off's "once · Nov 11".
 */
function Evidence({ line, lead }: { line: EvidenceFacts; lead?: string }) {
  const prefix = lead === undefined ? "" : `${lead} · `;
  const pastTolerance = line.daysPastTolerance ?? null;
  const late = pastTolerance === null ? "" : ` · ${days(pastTolerance)} past tolerance`;
  /* ⚖️ Paid inside another series' payment (§6A 59): "billed with the rent, last seen Sep 2". 🔴 His `Rent utilities
     & fees` read "never billed" here, paid inside every rent payment. */
  if (line.billedWithLabel !== null)
    return (
      <span className="block text-[11px] text-ink-faint">
        {prefix}
        {line.billedWithLabel}
        {late}
      </span>
    );
  if (line.neverBilled) return <span className="block text-[11px] text-ink-faint">{prefix}never billed</span>;
  return (
    <span className="block text-[11px] text-ink-faint">
      {prefix}last seen {line.lastMatchedLabel}
      {late}
    </span>
  );
}

export function SubscriptionsCard({ data }: { data: SubscriptionsCardData }) {
  const {
    liveMonthlyCents,
    lapsedMonthlyCents,
    live,
    lapsed,
    oneOffs,
    lapsedSharePct,
    neverBilledMonthlyCents,
    neverBilledSharePct,
    largestLapsed,
    postedCents,
    postedCount,
    unforecastableCount,
    endedCount,
    months,
    fromMonth,
    toMonth,
  } = data;
  // null when the ledger holds no complete month — see `baselineSpan`
  const span = baselineSpan({ months, fromMonth, toMonth });

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Subscriptions</h3>
        <Link
          href="/recurring"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Recurring →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {formatCents(liveMonthlyCents)}
        <span className="ml-1.5 inline-flex items-center gap-1.5 text-base font-normal text-ink-muted">
          a month, still forecast
          <InfoTip term="still forecast">
            Recurring payments the app is counting on, levelled to a month so a weekly one and a yearly one can
            sit in the same column. A payment that stopped arriving drops out of this and is listed separately.
          </InfoTip>
        </span>
      </p>

      {/* the gap between what is registered and what is forecast IS the card —
          so it gets the sentence, and it names the loudest line that fell out */}
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
        {largestLapsed === null ? (
          /*
           * 🔴 This used to read "Every recurring payment on the books has
           * charged recently enough to still be counted", and the card
           * refuted itself twice on the owner's own dashboard: five rows below
           * it wore a "never billed" badge, and the footnote at the bottom
           * said $1,461.69 of the headline "has never been billed by a bank".
           *
           * The branch condition is that nothing has LAPSED — and a series
           * that never charged cannot lapse, which is exactly why it survives
           * into `live`. So the sentence may speak about going quiet; it may
           * not claim anything has charged. What has never been billed is the
           * footnote's job, and it already does it.
           */
          <>Nothing on the books has gone quiet long enough to stop being counted.</>
        ) : (
          <>
            Another <Money cents={lapsedMonthlyCents} className="text-ink" /> a month is registered and no longer
            forecast — {lapsedSharePct.toFixed(1)}% of everything on the books. The largest is{" "}
            <span className="text-ink">{largestLapsed.name}</span>, last seen {largestLapsed.lastMatchedLabel}
            {largestLapsed.daysPastTolerance === null
              ? ""
              : `, ${days(largestLapsed.daysPastTolerance)} past its own tolerance`}
            .
          </>
        )}
      </p>

      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {live.map((l) => (
          <div key={l.seriesId} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-ink-muted">
              <span className="block truncate">{l.name}</span>
              <Evidence line={l} />
            </dt>
            <dd className="shrink-0 text-right">
              <Money cents={l.monthlyCents} />
              {/* a monthly series' charge IS its monthly figure, so saying so
                  twice is noise; every other cadence has been converted, and a
                  reader who sees only the converted number cannot check it */}
              {l.cadence !== "monthly" && (
                <span className="block text-[11px] text-ink-faint">
                  {formatCents(l.perOccurrenceCents)} {l.cadence}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {/* ⚖️ Owner decision 2026-10-08 (§6A 56): a charge due ONCE is not a monthly cost. It is listed here, under
          the live lines, with its day and its whole amount — and is in neither monthly figure nor either share.
          🔴 The Nov 11 car-insurance balance sat in the live list as "$72.74" a month, inside the headline and
          inside the never-billed sentence below. */}
      {oneOffs.length > 0 && (
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              One-off
              <InfoTip term="one-off">
                A payment due one time, on the day shown, rather than every month — so it is left out of the monthly
                figure above. The forecast still counts it in the month it falls in.
              </InfoTip>
            </dt>
            <dd className="shrink-0 text-xs text-ink-faint">{oneOffs.length}</dd>
          </div>
          {oneOffs.map((o) => (
            <div key={o.seriesId} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 text-ink-muted">
                <span className="block truncate">{o.name}</span>
                <Evidence line={o} lead={o.cadenceLabel} />
              </dt>
              {/* the whole charge, not a month's share of it — a one-off has no month to level over */}
              <dd className="shrink-0 text-right">
                <Money cents={o.cents} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {lapsed.length > 0 && (
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Stopped being forecast
              {/* ONE tip for the whole group, however many rows wear the phrase.
                  A tooltip body is live DOM text even while closed, so repeating
                  it per row both duplicates the sentence and breaks exact-count
                  locators elsewhere — the rule the car card states. */}
              <InfoTip term="tolerance">
                How late a payment can run before the app stops expecting it, worked out from how often that
                payment usually arrives rather than from a fixed number of days. A payment a day or two over
                has probably just not been imported yet; one that is years over has stopped.
              </InfoTip>
            </dt>
            <dd className="shrink-0 text-xs text-ink-faint">{lapsed.length}</dd>
          </div>
          {lapsed.map((l) => (
            <div key={l.seriesId} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 text-ink-muted">
                <span className="block truncate">{l.name}</span>
                <Evidence line={l} />
              </dt>
              {/* muted, not negative: this money is not leaving, and colouring
                  it like a loss would assert something nobody measured */}
              <dd className="shrink-0 text-ink-muted">
                <Money cents={l.monthlyCents} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {neverBilledSharePct !== null && neverBilledMonthlyCents > 0 && (
        <p className="mt-3 flex items-start gap-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
          <span>
            {formatCents(neverBilledMonthlyCents)} of the figure above — {neverBilledSharePct.toFixed(1)}% of it —
            has never been billed by a bank.
          </span>
          <InfoTip term="never billed">
            Entered by hand as a commitment the owner has agreed to, and not yet seen on any statement. It is a
            promise the ledger is holding, not a charge it has watched happen.
          </InfoTip>
        </p>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        {/* ⛔ `monthWindowLabel` — see EatingOutCard: three cards on this screen
            printed the raw month key beside two that did not. */}
        {/* ⛔ `baselineSpan`, the runway caption's phrase. Spelled here it read
            "over 0 complete months, Sep 2022" and "1 complete months" on a
            young ledger (replayed at today 2022-09-10 and 2022-10-15). */}
        {/* 🔴 "across 1 charges": the e2e fixture posts ONE subscription charge
            in its window, and the dashboard-grid baseline printed it. The
            numeral stays, as the counts below keep theirs. */}
        {span === null
          ? "No complete month has been imported yet, so nothing here has been totalled from the charges themselves."
          : `Together these took ${formatCents(postedCents)} out across ${postedCount} ${postedCount === 1 ? "charge" : "charges"} over ${span}, refunds netted off. That is a total, not a rate — a bill that started or ended inside the window did not charge for all of it.`}
        {unforecastableCount > 0 &&
          ` ${unforecastableCount} more ${unforecastableCount === 1 ? "has" : "have"} no expected amount or no expected date, so nothing could be levelled from ${unforecastableCount === 1 ? "it" : "them"}.`}
        {/* ⛔ A separate sentence: an ended commitment has both an amount and a
            rhythm — what it lacks is a future. Saying it "has no expected
            amount" would be false about the two largest bills in the book. */}
        {endedCount > 0 &&
          ` ${endedCount} ${endedCount === 1 ? "has" : "have"} already ended, so ${endedCount === 1 ? "it costs" : "they cost"} nothing going forward.`}
      </p>
    </SurfaceCard>
  );
}
