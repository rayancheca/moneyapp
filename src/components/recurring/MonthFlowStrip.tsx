"use client";

import { useId, useRef, useState } from "react";
import { Money } from "@/components/ui/Money";
import { flowArea, flowPolyline, type MonthFlow } from "@/lib/month-flow";
import { formatCents } from "@/lib/money";
import { ratioToIndex, stepScrubIndex } from "@/lib/scrub";
import { shortDate } from "./labels";

const W = 1000;
const H = 96;

interface MonthFlowStripProps {
  flow: MonthFlow;
  /** "August 2026", for the accessible summary */
  monthLabel: string;
}

/**
 * The month as a running total — the piece the grid structurally cannot show.
 *
 * A calendar's second axis is weeks, so it has nowhere to accumulate. It can say
 * "rent leaves on the 9th" and it cannot say "you are $2,300 down by the 10th
 * and back to level by the 27th", which is the question a person actually opens
 * a bills calendar with. The owner's complaint — *"i can barely understand it"*
 * — was partly this: seven columns of isolated events and nowhere the month adds
 * up.
 *
 * ## Two lines, and the GAP between them is the reading
 *
 * The dashed line is what the schedule says: every occurrence the month holds,
 * posted or not, accumulated from the 1st. The solid line is what has actually
 * POSTED, and it stops dead at today.
 *
 * They are separate because the first version drew one line split at TODAY, and
 * on the real ledger that was a lie — August 2026 showed a confident climb to
 * +$3,141 directly above a footer reading "SETTLED $0.00", because all three of
 * those paydays are cash the owner has been handed and not banked. A line that
 * says money arrived because the date has passed is the same error as a calendar
 * that says a bill was missed because a charge is absent, and this pass exists
 * to stop making it.
 *
 * Apart, they show the thing worth knowing: the distance between the two IS the
 * cash-timing gap the ledger has been carrying for eleven paydays.
 *
 * The fill is closed to the ZERO rule rather than to the floor, so its area
 * means "distance from where the month started" — the quantity the line is
 * about. The trough is marked only when the month actually dips below where it
 * started; on one that only climbs there is no trough worth naming.
 *
 * ⚠️ A month where nothing moves draws NOTHING. A flat rule across the middle is
 * indistinguishable from a broken renderer, and pass 30 shipped a header reading
 * "$0.00" over a live session for exactly want of that distinction. It says in
 * words which month it is: one with no mark, or one whose marks add nothing.
 */
export function MonthFlowStrip({ flow, monthLabel }: MonthFlowStripProps) {
  const gradientId = useId();
  const clipId = useId();
  const strokeId = useId();
  /*
   * Scrub, on the house kit (`lib/scrub`) rather than a bespoke pointer handler,
   * because that kit is where the KEYBOARD contract lives: arrows step a day,
   * up/down jump a week, Home/End reach the ends. A chart that only answers a
   * mouse is a chart the owner cannot read on a keyboard, and this one carries
   * the month's only running figure.
   */
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  if (!flow.hasMovement) {
    /* Two sentences, because a month that moves nothing is one of two months (`MonthFlow.hasEntries`). One whose
       marks all add nothing — a transfer moves money between his own accounts (`flowEntryOf`) — is not a month in
       which nothing lands: the grid directly under this line draws every one of them. */
    return (
      <p className="mb-3 text-[11px] text-ink-faint">
        {flow.hasEntries
          ? `What lands in ${monthLabel} adds nothing to the month's total.`
          : `Nothing recurring lands in ${monthLabel}.`}
      </p>
    );
  }

  const trough = flow.points[flow.troughIndex]!;
  const settledLine = flow.points.slice(0, flow.lastSettledIndex + 1);
  // Only when today falls INSIDE this month — paging to March 2024 must not
  // draw a "today" rule at its right-hand edge.
  const todayPoint =
    flow.lastSettledIndex >= 0 && flow.lastSettledIndex < flow.points.length - 1
      ? flow.points[flow.lastSettledIndex]!
      : null;
  const down = flow.endCents < 0;
  const scheduledTone = down ? "var(--negative)" : "var(--positive)";

  const scrubbed = scrubIndex === null ? null : flow.points[scrubIndex] ?? null;

  function scrubTo(clientX: number): void {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setScrubIndex(ratioToIndex((clientX - box.left) / box.width, flow.points.length));
  }

  return (
    <figure className="mb-4">
      <figcaption className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Through the month
        </span>
        {/* The readout REPLACES the month totals rather than sitting beside
            them. Two pairs of running figures, one following the pointer and one
            not, is the drift `budgetVerdict` was written to make impossible —
            and on a strip this small the reader cannot tell which pair answers
            the day under their cursor. */}
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-ink-faint">
          {scrubbed ? (
            <>
              <span className="figures text-ink-muted">{shortDate(scrubbed.iso)}</span>
              <span className="inline-flex items-baseline gap-1">
                posted
                <Money cents={scrubbed.settledCents} flow className="text-xs font-semibold" />
              </span>
              <span className="inline-flex items-baseline gap-1">
                as scheduled
                <Money cents={scrubbed.scheduledCents} flow className="text-xs font-semibold" />
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-baseline gap-1">
                posted
                <Money cents={flow.settledCents} flow className="text-xs font-semibold" />
              </span>
              <span className="inline-flex items-baseline gap-1">
                as scheduled
                <Money cents={flow.endCents} flow className="text-xs font-semibold" />
              </span>
            </>
          )}
        </span>
      </figcaption>

      <div
        ref={plotRef}
        role="slider"
        tabIndex={0}
        aria-label={`Scrub the running total through ${monthLabel}`}
        aria-valuemin={1}
        aria-valuemax={flow.points.length}
        aria-valuenow={(scrubIndex ?? flow.points.length - 1) + 1}
        aria-valuetext={
          scrubbed
            ? `${shortDate(scrubbed.iso)}: posted ${formatCents(
                scrubbed.settledCents,
              )}, as scheduled ${formatCents(scrubbed.scheduledCents)}`
            : `${monthLabel}: posted ${formatCents(flow.settledCents)}, as scheduled ${formatCents(
                flow.endCents,
              )}`
        }
        className="relative cursor-crosshair rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onPointerMove={(e) => scrubTo(e.clientX)}
        onPointerLeave={() => setScrubIndex(null)}
        onBlur={() => setScrubIndex(null)}
        onKeyDown={(e) => {
          const next = stepScrubIndex(
            scrubIndex ?? flow.points.length - 1,
            e.key,
            flow.points.length,
          );
          if (next === null) return;
          e.preventDefault();
          setScrubIndex(next);
        }}
      >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full sm:h-20"
        role="img"
        aria-label={
          `Running total through ${monthLabel}. As scheduled, the month ends ` +
          `${formatCents(flow.endCents)}` +
          (flow.dips
            ? `, at its lowest ${formatCents(trough.scheduledCents)} on ${shortDate(trough.iso)}`
            : "") +
          `. Posted so far: ${formatCents(flow.settledCents)}.`
        }
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={scheduledTone} stopOpacity="0.24" />
            <stop offset="100%" stopColor={scheduledTone} stopOpacity="0.02" />
          </linearGradient>
          {/* The stroke gains weight left to right, so the line reads as
              travelling through the month rather than sitting across it. The
              1st is where the least is known and the 31st is where the month
              has committed to something. */}
          <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={scheduledTone} stopOpacity="0.45" />
            <stop offset="100%" stopColor={scheduledTone} stopOpacity="1" />
          </linearGradient>
          {/* The fill is clipped to what has POSTED. Shading a projection as
              solidly as a fact is the same overstatement the dashed stroke
              exists to avoid, and on a month with nothing posted the fill
              correctly disappears entirely. */}
          <clipPath id={clipId}>
            <rect
              x="0"
              y="0"
              width={settledLine.length > 1 ? settledLine[settledLine.length - 1]!.x * W : 0}
              height={H}
            />
          </clipPath>
        </defs>

        {/* the zero rule — where the month started */}
        <line
          x1="0"
          y1={flow.zeroY * H}
          x2={W}
          y2={flow.zeroY * H}
          stroke="var(--line-strong)"
          strokeWidth="1"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />

        {/* WHAT THE SCHEDULE SAYS — the whole month, dashed, because all of it
            is a claim about what should happen rather than a record of what did. */}
        <polyline
          points={flowPolyline(flow.points, W, H, "scheduled")}
          fill="none"
          stroke={scheduledTone}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeDasharray="5 5"
          strokeOpacity="0.75"
          vectorEffect="non-scaling-stroke"
          className="[animation:var(--animate-flow-fill)] [animation-delay:520ms]"
        />

        {/* WHAT ACTUALLY POSTED — solid, heavier, and stopping dead at today.
            The gap between the two lines IS the reading: on August 2026 the
            dashed line climbs to +$3,141 of scheduled pay while the solid one
            never leaves the axis, which is exactly the eleven-silent-paydays
            cash gap the ledger has been carrying. */}
        <path
          d={flowArea(settledLine, flow.zeroY, W, H, "settled")}
          fill={`url(#${gradientId})`}
          clipPath={`url(#${clipId})`}
          className="[animation:var(--animate-flow-fill)] [animation-delay:400ms]"
        />
        {settledLine.length > 1 ? (
          <polyline
            points={flowPolyline(settledLine, W, H, "settled")}
            fill="none"
            stroke={`url(#${strokeId})`}
            strokeWidth="2.25"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            pathLength={1000}
            style={{ ["--flow-length" as string]: "1000" }}
            className="[stroke-dasharray:1000] [animation:var(--animate-flow-draw)]"
          />
        ) : null}

        {/* TODAY. The seam between the two lines is only legible if the reader
            can see where it falls — without it, a solid line simply stopping
            reads as missing data rather than as the present moment. */}
        {todayPoint ? (
          <g className="[animation:var(--animate-flow-fill)] [animation-delay:700ms]">
            <line
              x1={todayPoint.x * W}
              y1="0"
              x2={todayPoint.x * W}
              y2={H}
              stroke="var(--ink-faint)"
              strokeWidth="1"
              strokeOpacity="0.5"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={todayPoint.x * W}
              cy={todayPoint.ySettled * H}
              r="3"
              fill={scheduledTone}
            />
          </g>
        ) : null}

        {/* The month's lowest ebb — the figure that decides whether a bill
            clears. Drawn only when the month actually DIPS: on one that only
            climbs, the lowest point is day 1 at zero, and the first version
            dutifully printed "Lowest on Aug 1 at $0.00". */}
        {flow.dips ? (
          <circle
            cx={trough.x * W}
            cy={trough.yScheduled * H}
            r="3.5"
            fill="var(--surface-raised)"
            stroke={scheduledTone}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            className="[animation:var(--animate-flow-fill)] [animation-delay:820ms]"
          />
        ) : null}
      </svg>

        {/* The scrub mark, a SIBLING of the svg rather than a child of it: an
            HTML element inside <svg> is not laid out at all, and this has to be
            positioned in PERCENT because the plot is
            `preserveAspectRatio="none"` — a rule placed in that stretched
            coordinate system would be squashed along with it. */}
        {scrubbed ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-ink opacity-40"
            style={{ left: `${scrubbed.x * 100}%` }}
          />
        ) : null}
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: scheduledTone }}
          />
          posted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0 w-4 border-t border-dashed"
            style={{ borderColor: scheduledTone }}
          />
          as scheduled
        </span>
        {flow.dips ? (
          <span>
            lowest {shortDate(trough.iso)} at {formatCents(trough.scheduledCents)}
          </span>
        ) : null}
      </p>
    </figure>
  );
}
