"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarGrid } from "@/components/ui/CalendarGrid";
import { Sheet } from "@/components/ui/Sheet";
import { UNREACHED_PHRASE, unreachedKind, type UnreachedKind } from "@/lib/empty-period";
import { compactDayAmount } from "@/lib/calendar-day-weight";
import { formatCents } from "@/lib/money";
import { formatDayLong, formatDayShort, formatMonthYear } from "@/lib/format-date";
import { loadSpendHeatmap } from "@/app/spending/actions";
import { dayLedgerHref, type HeatDay, type SpendHeatmap as SpendHeatmapData } from "@/services/spending";

/**
 * Day-level spending heatmap (ux-overhaul-plan §5.3, enriched in pass 23).
 *
 * Each cell states the day's OUTFLOW as a number plus a magnitude bar, with an
 * income dot when money also came in — the tint used to be the only signal, and
 * a wash of red says "a lot" without ever saying how much. The bar is drawn
 * UNDER the figure rather than behind it: a saturated full-cell tint cannot
 * clear WCAG AA behind small text in both themes (the same finding that keeps
 * numbers out of the P/L calendar's cells), so the colour and the text never
 * overlap here.
 *
 * Tapping a day opens a detail sheet — total, count, where the money went and
 * who it went to — instead of navigating straight off the page; the full ledger
 * is one click further, from inside the sheet. Month ‹ › paging loads a new
 * month through a server action without leaving the page.
 */

/** one day of the heatmap, and both ends of the ledger it is read against */
interface HeatDayFrontier {
  iso: string;
  day: HeatDay | null;
  today: string;
  /**
   * `ledgerOpens(db)` — the oldest day the ledger holds a row for. REQUIRED, not
   * defaulted: a missing opening day is exactly how every day before the
   * records begin came to read "nothing spent or earned".
   */
  ledgerOpens: string | null;
  /** `ledgerReaches(db)` — the day the ledger is imported through: its newest row or non-investment statement end */
  ledgerReaches: string | null;
}

/**
 * Which world an unmeasured day sits in, or null when the day is a measurement.
 *
 * ⛔ A day holding a row this chart counts is a measurement, whatever the
 * frontier says. A posted row dated after today is drawn in its cell and listed
 * in its sheet, and the label called that day "has not happened yet" — the same
 * "data wins" rule the cash-flow buckets on this page follow.
 */
function heatDayUnreached({ iso, day, today, ledgerOpens, ledgerReaches }: HeatDayFrontier): UnreachedKind | null {
  const holdsRows = day !== null && (day.spentCents > 0 || day.incomeCents > 0 || day.refundedCents > 0);
  return holdsRows ? null : unreachedKind({ from: iso, to: iso, today, ledgerOpens, ledgerReaches });
}

/**
 * The sheet's sentence for a day with nothing spent or earned, or null when the
 * day has money and the sheet shows it instead.
 *
 * ⛔ Decided here, beside `heatCellLabel`, and from the same classification. The
 * sheet carried its own inline copy of the checks, and with it the same
 * one-ended frontier: a day before the records begin would have opened a sheet
 * saying "Nothing was spent or earned on this day."
 */
export function heatDaySheetSentence(input: HeatDayFrontier): string | null {
  const { day } = input;
  if (day !== null && (day.spentCents > 0 || day.incomeCents > 0)) return null;
  switch (heatDayUnreached(input)) {
    case "future":
      return "This day has not happened yet.";
    case "before-records":
      return "This day is before your records begin — nothing has been imported for it, which is not the same as nothing happening.";
    case "after-records":
    case "no-ledger":
      return "Nothing has been imported for this day yet — nobody has looked at it, which is not the same as nothing happening.";
    case null:
      break;
  }
  const refunded = day?.refundedCents ?? 0;
  return refunded > 0
    ? `Nothing was spent or earned on this day — ${formatCents(refunded)} came back as a refund.`
    : // the same population the cell's own label names — not the ledger's
      "Nothing was spent or earned on this day.";
}

/**
 * What ONE calendar cell says — the whole decision, in one place, because the
 * cell's accessible name and the sheet that opens from it must never describe
 * two different worlds.
 */
export function heatCellLabel({
  iso,
  monthKey,
  monthName,
  day: d,
  today,
  ledgerOpens,
  ledgerReaches,
}: HeatDayFrontier & {
  /** the month the payload is FOR — a cell outside it was never queried */
  monthKey: string;
  monthName: string;
}): string {
  const day = formatDayShort(iso);
  /*
   * 🔴 A PADDING DAY IS NOT A MEASUREMENT. `CalendarGrid` fills the grid with
   * real days from the neighbouring months, and this month's payload holds
   * none of them — the comment on `onDayActivate` in the component already says
   * so and guards the SHEET for exactly this reason. The aria-label did not, so on
   * `/spending?period=2026-08` the five leading cells read
   *
   *     "Jul 27: no activity" … "Jul 31: no activity"
   *
   * of days holding 18, 13, 21, 11 and 12 transactions, and the trailing
   * cells said the same of a September nobody has imported and of two days
   * that have not happened. One sentence for three different worlds.
   */
  if (iso.slice(0, 7) !== monthKey) return `${day}: not part of ${monthName} — open its ledger`;
  /*
   * 🔴 …AND THE OTHER TWO WORLDS THE COMMENT ABOVE NAMED. The padding half was
   * fixed on 2026-09-04 and "no activity" was left standing over both of the
   * others. Measured 2026-09-10, `/spending` opens its heatmap on September:
   * all 30 cells read "no activity" — ten of days nobody has imported, twenty
   * of days that have not happened. The page's own empty state one card above
   * says "That is a window nobody has looked at, not one in which nothing
   * happened", and this is the surface that said the opposite thirty times.
   *
   * ⛔ Future first. A day after today is both unimported and unhappened, and
   * "has not happened yet" is the one that answers the reader.
   *
   * 🔴 …AND THE FRONTIER HAD ONE END. Measured on the owner's ledger 2026-09-14,
   * first active row 2022-08-25: `/spending?period=2022-08` read "Aug 1: nothing
   * spent or earned" … "Aug 24: nothing spent or earned" — twenty-four days
   * before the records begin, called measured zeros — and the ‹ button pages
   * back with no limit (owner decision E3a), so every month before it said the
   * same. This component was handed `ledgerReaches` and never `ledgerOpens`.
   * `unreachedKind` asks both ends, future first, and the sheet asks it too.
   */
  const unreached = heatDayUnreached({ iso, day: d, today, ledgerOpens, ledgerReaches });
  if (unreached !== null) return `${day}: ${UNREACHED_PHRASE[unreached]}`;
  /*
   * 🔴 A DAY WHOSE ONLY ROW IS A RETURN IS NOT AN EMPTY DAY. The service skips
   * a credit in an expense category from both buckets on purpose — "a refund is
   * not a day's spending" — so such a day arrived with two zeroes and read "no
   * activity" over a posted row. Two days on the owner's ledger: 2025-05-10
   * ($18.00 back) and 2025-11-22 ($5.58).
   */
  if (d && d.spentCents === 0 && d.incomeCents === 0 && d.refundedCents > 0) {
    return `${day}: ${formatCents(d.refundedCents)} refunded`;
  }
  /*
   * ⛔ "no activity" IS AN ASSERTION ABOUT THE WHOLE LEDGER, and this chart
   * counts three things: expense-kind outflows, income-kind positives, and
   * expense-kind credits. A day holding only a transfer, a card payment or an
   * investment flow falls through all three. Measured 2026-09-11: **79 days
   * across the ledger, covering 298 real transactions**, were labelled as
   * having had none. The branch directly above already says "spent or earned";
   * this one now names the same population.
   */
  if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return `${day}: nothing spent or earned`;
  const parts: string[] = [];
  if (d.spentCents > 0) {
    parts.push(`${formatCents(d.spentCents)} spent across ${d.txnCount} ${d.txnCount === 1 ? "transaction" : "transactions"}`);
    // the biggest destination, so the label is as actionable as the cell
    if (d.topCategories[0]) parts.push(`mostly ${d.topCategories[0].name}`);
  }
  if (d.incomeCents > 0) parts.push(`${formatCents(d.incomeCents)} earned`);
  return `${day}: ${parts.join(", ")}`;
}

const MIN_BAR = 0.08;

interface SpendHeatmapProps {
  initial: SpendHeatmapData;
  today: string;
  /**
   * `ledgerOpens(db)` — the oldest day the import holds a row for. A cell before
   * it has no zero to report either; required, for the reason on `HeatDayFrontier`.
   */
  ledgerOpens: string | null;
  /**
   * `ledgerReaches(db)` — the day the ledger is imported through. A cell after
   * it has no zero to report; see `cellLabel`. Both ends are passed as props
   * rather than carried in the payload because month paging reloads the payload
   * and neither moves.
   */
  ledgerReaches: string | null;
}

export function SpendHeatmap({ initial, today, ledgerOpens, ledgerReaches }: SpendHeatmapProps) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDay = new Map(data.days.map((d) => [d.iso, d]));
  const monthName = formatMonthYear(`${data.monthKey}-01`);
  const scale = Math.max(data.maxOutflowCents, data.maxInflowCents);
  const detail = openDay === null ? null : (byDay.get(openDay) ?? null);

  async function changeMonth(monthKey: string) {
    setPending(true);
    const res = await loadSpendHeatmap(monthKey);
    if (res.ok) setData(res.data);
    setPending(false);
    // a day from the old month has no meaning in the new one
    setOpenDay(null);
  }

  function cellLabel(iso: string): string {
    return heatCellLabel({
      iso,
      monthKey: data.monthKey,
      monthName,
      day: byDay.get(iso) ?? null,
      today,
      ledgerOpens,
      ledgerReaches,
    });
  }


  return (
    <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={pending}>
      <CalendarGrid
        monthKey={data.monthKey}
        today={today}
        onMonthChange={changeMonth}
        getCellLabel={cellLabel}
        // CalendarGrid pads the grid with real, clickable days from the
        // NEIGHBOURING month, and this month's payload contains none of them —
        // opening a sheet there would state "nothing posted" about a date we
        // never queried. Those cells keep the direct ledger drill, which is
        // always ground truth.
        onDayActivate={(iso) =>
          iso.slice(0, 7) === data.monthKey ? setOpenDay(iso) : router.push(dayLedgerHref(iso))
        }
        renderCell={(day) => {
          const d = byDay.get(day.iso);
          if (!d || (d.spentCents === 0 && d.incomeCents === 0)) return null;
          // BOTH sides share one scale (the month's biggest day either way), so a
          // longer bar always means more money — normalising each kind to its own
          // max would let a small payday out-draw the rent
          const bar = (cents: number) =>
            cents > 0 && scale > 0 ? MIN_BAR + (1 - MIN_BAR) * (cents / scale) : 0;
          return (
            // grouped directly UNDER this day's number (not floated to the
            // cell's bottom edge, where it reads as belonging to the next row)
            // both sides of the day, each as a signed figure over its own bar.
            // The SIGN carries direction (not colour alone), so the numbers stay
            // neutral ink and can never fail contrast the way 10px tinted text would
            <span className="flex h-full w-full min-w-0 flex-col items-start gap-1 overflow-hidden">
              {d.spentCents > 0 && (
                <CellAmount cents={d.spentCents} sign="−" share={bar(d.spentCents)} tone="bg-negative" />
              )}
              {d.incomeCents > 0 && (
                <CellAmount cents={d.incomeCents} sign="+" share={bar(d.incomeCents)} tone="bg-positive" />
              )}
            </span>
          );
        }}
        footer={
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-1 w-5 rounded-full bg-negative" />
              spent
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-1 w-5 rounded-full bg-positive" />
              earned
            </span>
            <span>bars share one scale — the month&rsquo;s biggest day</span>
            <span>Tap a day for its detail</span>
          </p>
        }
      />

      <Sheet
        open={openDay !== null}
        onClose={() => setOpenDay(null)}
        title={openDay ? formatDayLong(openDay) : ""}
      >
        {openDay && (
          <DaySheetBody
            iso={openDay}
            day={detail}
            today={today}
            ledgerOpens={ledgerOpens}
            ledgerReaches={ledgerReaches}
          />
        )}
      </Sheet>
    </div>
  );
}

/** One side of a day: the signed figure, and its bar on the shared scale. */
function CellAmount({
  cents,
  sign,
  share,
  tone,
}: {
  cents: number;
  sign: "−" | "+";
  share: number;
  tone: string;
}) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className="figures truncate text-[10px] leading-none text-ink-muted">
        {sign}
        {compactDayAmount(cents)}
      </span>
      {/* no track behind it — an empty rail on every active day reads as a
          divider rule across the grid, not as a magnitude */}
      {share > 0 && (
        <span
          aria-hidden
          className={`hidden h-1 rounded-full sm:block ${tone}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      )}
    </span>
  );
}

/**
 * Amounts are neutral ink with a decorative colored dot rather than tone-colored
 * text: the sheet's --surface-overlay background is lighter than a card, where
 * --positive/--negative fall just under WCAG AA (the same rule the P/L day sheet
 * follows).
 */
function DaySheetBody(props: HeatDayFrontier) {
  const { iso, day } = props;
  const spent = day?.spentCents ?? 0;
  const income = day?.incomeCents ?? 0;

  /* the same worlds the cell label separates, from the same classification */
  const nothing = heatDaySheetSentence(props);
  if (nothing !== null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{nothing}</p>
        <LedgerLink iso={iso} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Spent</span>
          <div className="figures mt-1 flex items-center gap-1.5 text-xl font-semibold text-ink">
            <span aria-hidden className="size-2 rounded-full bg-negative" />
            {formatCents(spent)}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {day!.txnCount} {day!.txnCount === 1 ? "transaction" : "transactions"}
          </p>
        </div>
        {income > 0 && (
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Earned</span>
            <div className="figures mt-1 flex items-center gap-1.5 text-xl font-semibold text-ink">
              <span aria-hidden className="size-2 rounded-full bg-positive" />
              {formatCents(income)}
            </div>
          </div>
        )}
      </div>

      {income > 0 && (
        <div>
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink">Net</span>
          <div className="figures mt-1 text-lg font-semibold text-ink">
            {income - spent >= 0 ? "+" : "−"}
            {formatCents(Math.abs(income - spent))}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {income - spent >= 0 ? "earned more than you spent" : "spent more than you earned"}
          </p>
        </div>
      )}

      <EntryList title="Where it went" entries={day!.topCategories} total={spent} />
      <EntryList title="Who it went to" entries={day!.topMerchants} total={spent} />
      <LedgerLink iso={iso} />
    </div>
  );
}

/**
 * The list is capped at the top few, so it is shown WITH its residual: a
 * truncated breakdown sitting under an exact total otherwise reads as the whole
 * story. Same rule as the spending chart's "Other" bucket — the visible rows
 * plus the remainder always reconcile to the day's spend.
 */
function EntryList({
  title,
  entries,
  total,
}: {
  title: string;
  entries: { name: string; cents: number }[];
  total: number;
}) {
  if (entries.length === 0) return null;
  const shown = entries.reduce((sum, e) => sum + e.cents, 0);
  const rest = total - shown;
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-ink">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {entries.map((e) => (
          <li key={e.name} className="flex items-baseline justify-between gap-4 text-sm">
            <span className="truncate text-ink">{e.name}</span>
            <span className="figures shrink-0 text-ink-muted">{formatCents(e.cents)}</span>
          </li>
        ))}
        {rest > 0 && (
          <li className="flex items-baseline justify-between gap-4 text-sm text-ink-faint">
            <span className="truncate">Everything else</span>
            <span className="figures shrink-0">{formatCents(rest)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function LedgerLink({ iso }: { iso: string }) {
  return (
    <Link
      href={dayLedgerHref(iso)}
      className="inline-flex text-sm font-medium text-accent transition-colors duration-(--duration-fast) hover:underline"
    >
      All transactions for this day →
    </Link>
  );
}
