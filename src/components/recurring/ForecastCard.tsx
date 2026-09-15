import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { forecastSplit } from "@/lib/forecast-split";
import { formatDayLong } from "@/lib/format-date";
import { unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import type { MonthForecast } from "@/services/forecast";
import { ForecastComposition } from "./ForecastComposition";
import { monthLabel, staleComponentEntries } from "./labels";
import { StaleFooter, StaleMark } from "./StalenessNote";

interface ForecastCardProps {
  forecast: MonthForecast;
}

/**
 * The passed paydays this card does not count, and why.
 *
 * 🔴 "Cash pay that never reaches a bank", in warning tone, was said of Sep 3
 * and Sep 10 while Chase Checking — the only account that pay lands in — had
 * been checked through Aug 12 (measured 2026-09-15). The warning and that
 * clause speak only of paydays on days the ledger has checked; the rest are
 * named as not looked for (`unbankedIncomeFrontierClause`), as /spending names
 * them.
 */
export function UnbankedIncomeNote({ unbanked: u }: { unbanked: MonthForecast["unbankedIncome"] }) {
  const unread = unbankedIncomeFrontierClause(u, formatDayLong);
  const names = u.names.length > 0 ? ` (${u.names.join(", ")})` : "";
  return (
    <p className={`mt-1 text-xs ${u.checkedOccurrenceCount > 0 ? "text-warning" : "text-ink-faint"}`}>
      {u.occurrenceCount === 1 ? "1 payday" : `${u.occurrenceCount} paydays`} worth <Money cents={u.totalCents} />{" "}
      already passed this month{unread === null ? " with no deposit imported" : ""}
      {names} — not counted above, and not in EOM cash. {unread === null ? "" : `${unread} `}
      {u.checkedOccurrenceCount > 0 ? "Cash pay that never reaches a bank" : "Pay the ledger has not looked for"}{" "}
      cannot be projected as arriving; the month strip below counts it, because that line is the schedule.
    </p>
  );
}

/** "A", "A and B", "A, B, and C" — the platform's own list rather than another hand-rolled join. */
const ACCOUNT_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** How `OutsideCashNote` names each reading — the headline tiles, and the row beneath them. */
const READING = { headline: "in the headline", pace: "at your recent pace" } as const;

/**
 * What both EOM cash figures leave out, and where it posts.
 *
 * ⚖️ Owner decision 2026-09-15 (3): Robinhood Cash and Robinhood Agentic are
 * what selling investments would add, and so is whatever posts to them
 * (`services/forecast` `accountsOutsideCash`). The nets on this card and its EOM
 * net worth keep those lines; its EOM cash does not. Without this sentence the
 * headline's EOM cash minus the pace row's stops equalling the headline's net
 * minus the pace row's, and nothing on the card says by how much or why.
 *
 * One amount when both readings leave out the same — no pace line posts there —
 * and both, each under the reading it belongs to, when they differ.
 *
 * 🔴 A half that is $0.00 says nothing. On the owner's ledger (2026-09-15) no
 * commitment posts to Robinhood Cash, so every month the calendar pages to
 * printed "$0.00 in the headline and +$19.43 at your recent pace". When only one
 * reading leaves anything out, the sentence prints that one amount and names
 * its reading instead; when neither does, there is no sentence.
 */
export function OutsideCashNote({ outside }: { outside: MonthForecast["outsideCash"] }) {
  const headline = outside.committedNetCents;
  const pace = outside.netCents;
  if (headline === 0 && pace === 0) return null;
  const posts = `projected to post to ${ACCOUNT_LIST.format(outside.accountNames)} by month end`;
  const why = "because that is money selling investments would add, not cash you can spend";
  if (headline !== 0 && pace !== 0 && headline !== pace) {
    return (
      <p className="mt-1 text-xs text-ink-faint">
        EOM cash leaves out what is {posts}, {why}: <Money cents={headline} flow /> {READING.headline} and{" "}
        <Money cents={pace} flow /> {READING.pace}. EOM net worth keeps it.
      </p>
    );
  }
  // one amount: both readings leave out the same, or only one leaves out anything
  const reading = headline === pace ? "" : ` ${headline === 0 ? READING.pace : READING.headline}`;
  return (
    <p className="mt-1 text-xs text-ink-faint">
      EOM cash{reading} leaves out the <Money cents={headline === 0 ? pace : headline} flow /> {posts}, {why}. EOM net
      worth keeps it.
    </p>
  );
}

/** One tile of the headline row. */
function Stat({ label, cents, flow = false }: { label: string; cents: number; flow?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">{label}</dt>
      <dd className="mt-1">
        <Money cents={cents} flow={flow} className="text-lg font-medium" />
      </dd>
    </div>
  );
}

/**
 * The trailing pace, on its own row and never folded into the headline.
 *
 * ⛔ This row is the honesty half of the owner's instruction. He asked for the
 * tiles to be his commitments, and they are — but groceries, petrol and
 * restaurants are money genuinely leaving a genuine account, and a card that
 * showed only the schedule would predict a September that ends $6,138.66 up
 * when his own last three months say otherwise. So the pace keeps its FULL
 * figures, its own end-of-month cash, and the same type size.
 *
 * ⚠️ Two end-of-month cash numbers on one card is a real hazard — the app has
 * been bitten before by one quantity with two definitions. What makes it safe
 * here is that neither is a total of the other's row: each is a complete,
 * internally consistent reading of the month, and each says in its own label
 * which assumption produced it. Where a line posts outside cash (a dividend
 * paid into Robinhood Cash), each EOM cash leaves out its own reading's share,
 * and `OutsideCashNote` prints each share that is not zero.
 */
function PaceRow({ forecast: f }: { forecast: MonthForecast }) {
  const paceIncome = f.projectedIncomeCents - f.committed.incomeCents;
  const paceSpend = f.projectedSpendCents - f.committed.spendCents;
  if (paceIncome === 0 && paceSpend === 0) return null;

  return (
    <div className="mt-5 rounded-md border border-line bg-surface px-4 py-3">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
        If you also spend at your recent pace
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-5">
        <PaceStat label="Income" cents={f.projectedIncomeCents} flow />
        <PaceStat label="Spending" cents={f.projectedSpendCents} flow />
        <PaceStat label="Net" cents={f.projectedNetCents} flow />
        <PaceStat label="EOM cash" cents={f.projectedEomCashCents} />
        <PaceStat label="EOM net worth" cents={f.projectedEomNetWorthCents} />
      </dl>
    </div>
  );
}

function PaceStat({ label, cents, flow = false }: { label: string; cents: number; flow?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5">
        <Money cents={cents} flow={flow} className="text-sm font-medium" />
      </dd>
    </div>
  );
}

/**
 * The end-of-month projection with its math fully inspectable: every
 * component that feeds the totals renders in the "Show the math" table,
 * and the components sum exactly to the displayed projections.
 *
 * ⛔ THE HEADLINE ROW IS THE SCHEDULE, NOT THE PREDICTION, and that is the
 * owner's explicit instruction after seeing it the other way round:
 *
 *   *"projected income is 1047*4 a month. projected spend is the actual
 *    monthlies i have you so around 3.5k"*
 *
 * So the five tiles read his commitments — September 2026: **+$4,188.00**,
 * **−$3,567.60**, **+$620.40** — and the trailing pace moved to its own row
 * beneath, in full, never hidden. I had built it the other way (total on top,
 * split disclosed below) and he was right that it buried the answer: the tiles
 * are what the eye lands on, so the tiles have to be the thing he asked for.
 *
 * ⭐ It also settles a contradiction that predates this card. The calendar strip
 * DIRECTLY BELOW has always printed "as scheduled +$620.40"; the tiles above it
 * said −$6,797.08. One screen, one month, two answers $7,417.48 apart. They now
 * agree, because they are finally the same reading.
 *
 * ⚠️ The pace is REAL money and is not deleted — groceries, petrol and
 * restaurants leave a real account. It renders on its own row with its own
 * end-of-month cash, and `MonthForecast.committed` carries the caveat in prose.
 *
 * A series whose evidence has gone stale is NOT dropped from the math — the
 * forecast keeps the number and marks how old the evidence behind it is
 * (services/forecast.ts::fixedComponents).
 */
export function ForecastCard({ forecast: f }: ForecastCardProps) {
  const stale = staleComponentEntries(f.components);
  /*
   * Derived from the SAME array the totals above were summed from, so the band
   * and the tiles cannot drift: `forecastSplit` partitions by sign first, which
   * is exactly how `services/forecast` derives `projectedIncomeCents` and
   * `projectedSpendCents`. See lib/forecast-split.ts for why that makes the
   * identity arithmetic rather than a coincidence worth re-checking here.
   */
  const split = forecastSplit(
    f.components.map((c) => ({
      kind: c.kind,
      cents: c.cents,
      isStale: c.staleness?.isStale,
      // never CHARGED, not never seen: `daysSinceLastMatch` is null exactly
      // when no charge has ever matched the series
      neverCharged: c.staleness?.daysSinceLastMatch === null,
    })),
  );

  return (
    <SurfaceCard>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Forecast · {monthLabel(f.monthStart)}</h2>
        <span className="text-xs text-ink-faint">
          {f.remainingDays} of {f.daysInMonth} days remaining
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-5">
        <Stat label="Projected income" cents={f.committed.incomeCents} flow />
        <Stat label="Projected spending" cents={f.committed.spendCents} flow />
        <Stat label="Projected net" cents={f.committed.netCents} flow />
        <Stat label="EOM cash" cents={f.committed.eomCashCents} />
        <Stat label="EOM net worth" cents={f.committed.eomNetWorthCents} />
      </dl>

      <p className="mt-2 text-xs text-ink-faint">
        {/* ⛔ `fixedSeriesCount`, not `fixedCount`. A commitment is a SERIES, and
            since the forecast grew an arrears leg a series can contribute two
            components to one month — what came due on the 1st and never posted,
            and what falls due again on the 8th. `ForecastComposition` below
            prints the component count as "(N lines)", the other true reading of
            the same set. */}
        Your bills and scheduled pay only — {split.spending.fixedSeriesCount}{" "}
        {split.spending.fixedSeriesCount === 1 ? "commitment" : "commitments"} and{" "}
        {split.income.fixedSeriesCount} {split.income.fixedSeriesCount === 1 ? "series" : "series"}.
      </p>

      {/* 🔴 THE ASYMMETRY, NAMED. A bill that came due and never posted IS a
          component here; a payday that came and went unbanked deliberately is
          not, because cash pay that never reaches a bank cannot be counted as
          arriving (`fixedComponents` argues it at length). So this card sums a
          different set of days from the month strip directly below it, and on
          2026-09-04 the two read "-$426.60" and "as scheduled +$620.40" —
          $1,047.00 apart, which is exactly what `committed`'s own docstring says
          this headline exists to prevent. */}
      {f.unbankedIncome.totalCents > 0 && <UnbankedIncomeNote unbanked={f.unbankedIncome} />}

      <OutsideCashNote outside={f.outsideCash} />

      <ForecastComposition split={split} />

      <PaceRow forecast={f} />

      <details className="group mt-6 rounded-md border border-line bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink">
          Show the math
          <span className="ml-2 text-ink-faint group-open:hidden">
            ({f.components.length} components)
          </span>
        </summary>
        {f.components.length === 0 ? (
          <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
            No components yet — detect recurring series or import spending history.
          </p>
        ) : (
          // four columns of prose ("How it was computed") have a min-content
          // floor of ~374px, so on a phone this table pushed the whole document
          // sideways — 270px at 320 and still 150px at 440, and it did it while
          // COLLAPSED, scrolling the page into empty space. Wide content scrolls
          // in its own container (the web rule, and what DataTable.tsx:176 does);
          // the wrapper is what keeps it off the document.
          <div className="overflow-x-auto">
            <table className="w-full border-t border-line text-xs">
              <caption className="sr-only">
                Every forecast component; the rows sum exactly to the projections above
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint">
                  <th scope="col" className="px-4 py-2">Component</th>
                  <th scope="col" className="px-3 py-2">Type</th>
                  <th scope="col" className="px-3 py-2">How it was computed</th>
                  <th scope="col" className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {f.components.map((c) => (
                  <tr key={`${c.kind}-${c.label}`} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-2 text-left font-medium">
                      {c.label}
                      <StaleMark staleness={c.staleness} className="ml-2" />
                    </th>
                    <td className="px-3 py-2 text-ink-muted">
                      {c.kind === "fixed" ? "Fixed (series)" : "Variable (trailing avg)"}
                    </td>
                    <td className="px-3 py-2 text-ink-faint">{c.detail}</td>
                    <td className="px-4 py-2 text-right">
                      <Money cents={c.cents} flow />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong">
                  <th scope="row" colSpan={3} className="px-4 py-2 text-left font-medium">
                    Projected net (components sum)
                  </th>
                  <td className="px-4 py-2 text-right">
                    <Money cents={f.projectedNetCents} flow className="font-medium" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </details>

      <StaleFooter window={`In ${monthLabel(f.monthStart)}`} entries={stale} className="mt-3" />
    </SurfaceCard>
  );
}
