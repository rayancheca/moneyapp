"use client";

import { useState, useTransition } from "react";
import { SERIES_EVIDENCE_LABEL, noScheduleReason } from "@/lib/series-evidence";
import { seriesEndLines } from "./end-radius";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { renameSeriesAction, setSeriesStatusAction } from "@/app/recurring/actions";
import { isTableLens, LENS_DIMENSION, LENS_LABELS } from "@/components/charts/chart-lens";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { formatCents } from "@/lib/money";
import type { Provenance } from "@/services/provenance";
import type { ViewState } from "@/lib/view-state";
import { RECURRING_SERIES_SURFACE, RECURRING_SERIES_VIEW_SPEC } from "./recurring-view-spec";
import { Badge } from "@/components/ui/Badge";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Confirm } from "@/components/ui/Confirm";
import { InlineEditableText } from "@/components/ui/InlineEditableText";
import { Menu } from "@/components/ui/Menu";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { toast } from "@/components/ui/Toast";
import { Icon, type IconName } from "@/components/shell/Icon";
import type { SeriesKind, SeriesStatus } from "@/db/schema/recurring";
import type { SeriesDetail as SeriesDetailData } from "@/services/recurring-detail";
import { AmountHistoryChart } from "./AmountHistoryChart";
import { CadenceSentence } from "./CadenceSentence";
import { AttachPanel, LinkedTransactions, MergeControl } from "./SeriesMembership";
import { annualizedCaveat, CADENCE_LABEL, KIND_LABEL, longDate, postedSpreadReading, STATUS_LABEL } from "./labels";

const KIND_ICON: Record<SeriesKind, IconName> = {
  income: "banknote",
  bill: "receipt",
  subscription: "repeat",
  transfer: "arrow-left-right",
  other: "tag",
};

const STATUS_TONE: Record<SeriesStatus, "info" | "positive" | "neutral"> = {
  detected: "info",
  confirmed: "positive",
  dismissed: "neutral",
  ended: "neutral",
};

/**
 * Series detail (ux-overhaul-plan §4.2): the header closes the merchant⇄category
 * chain, the cadence sentence exposes detection as editable overrides, and the
 * membership cluster (attach / detach / merge) reshapes the series — every write
 * a value-returning action that refreshes this server-rendered page.
 */
/** stable identity so useViewState's setView doesn't churn every render */
const EMPTY_PARAMS: Record<string, string> = {};

export function SeriesDetail({
  data,
  today,
  provenance,
  insights,
  viewState,
  basePath,
}: {
  data: SeriesDetailData;
  /** the server's day, so the caveat cannot disagree with the figures beside it */
  today: string;
  /** what the expected amount is standing on — computed server-side */
  provenance?: Provenance | null;
  /**
   * PHASE III-B's strip, rendered on the server and passed in as a slot.
   *
   * A node rather than the data: `InsightList` is a server component and this
   * one is `"use client"`, so importing it here would pull it — and
   * `ProvenancePopover` behind it — into the client bundle for a card that
   * never changes after render.
   */
  insights?: React.ReactNode;
  /** the RSC-resolved active view (URL > persisted > default) */
  viewState: ViewState;
  /** this series' own route (the lens switcher navigates within it) */
  basePath: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { state, setView } = useViewState({
    surface: RECURRING_SERIES_SURFACE,
    spec: RECURRING_SERIES_VIEW_SPEC,
    state: viewState,
    basePath,
    baseParams: EMPTY_PARAMS,
  });
  const amountsAsTable = isTableLens(state);
  // the year the ANNUALIZED figure is a year OF — qualified only when the
  // series stops inside it; see `annualizedCaveat`
  const annualizedNote = annualizedCaveat(data.endsOn, today);
  // the ± hangs off the figure it is the spread of — see `postedSpreadReading`
  const postedSpread = postedSpreadReading(
    data.nextExpectedAmountCents,
    data.postedAvgCents,
    data.postedStddevCents,
  );
  // ending a series takes money off the forecast and the calendar — the one
  // status change on this page that changes what the app predicts
  const [endingSeries, setEndingSeries] = useState(false);

  function onChanged(): void {
    startTransition(() => router.refresh());
  }

  // A merged-away series is dead — it owns no rows and must never be resurrected
  // or reshaped (§4.3). A dismissed/user-ended series can be re-confirmed but not
  // edited until it is live again.
  const isMergedAway = data.mergedInto !== null;
  const isLive = data.status === "detected" || data.status === "confirmed";

  function setStatus(status: "confirmed" | "dismissed" | "ended", label: string): void {
    void setSeriesStatusAction({ seriesId: data.id, status }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      onChanged();
      toast({ title: label });
    });
  }

  return (
    <>
      <Breadcrumbs className="mb-3" items={[{ label: "Recurring", href: "/recurring" }, { label: data.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-ink-muted">
              <Icon name={KIND_ICON[data.kind]} className="size-5" />
            </span>
            <h1 className="min-w-0 text-2xl font-semibold tracking-tight">
              <InlineEditableText
                value={data.name}
                label="Series name"
                maxLength={120}
                className="text-2xl font-semibold tracking-tight"
                onSave={async (next) => {
                  const result = await renameSeriesAction({ seriesId: data.id, name: next });
                  if (result.ok) onChanged();
                  return { ok: result.ok, error: result.ok ? undefined : result.error };
                }}
              />
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[data.status]}>{STATUS_LABEL[data.status]}</Badge>
            <span className="text-xs text-ink-faint">{KIND_LABEL[data.kind]}</span>
            {/* 🔴 "Inactive" sat beside "Next expected Sep 11" on a series the
                forecast projects. The badge is the word the evidence chooses. */}
            {(data.status === "detected" || data.status === "confirmed") && data.evidence !== "active" ? (
              <Badge tone="warning">{SERIES_EVIDENCE_LABEL[data.evidence]}</Badge>
            ) : null}
            {/* 🔴 The one place a reader would go to check when a series stops,
                and the only surface that did not say. The runway card and the
                car card both name this date; this page headlined
                "~$4,337.88/yr" over three upcoming charges and never mentioned
                that the series is evidenced only to 2027-01-11. */}
            {/* the same date the caveat below may name, spelled the same way —
                a raw ISO string here would have the page printing one day two
                ways, two inches apart */}
            {data.endsOn !== null ? <Badge tone="warning">Ends {longDate(data.endsOn)}</Badge> : null}
            {data.merchant ? (
              <Link
                href={`/merchants/${data.merchant.id}`}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
              >
                <Icon name="tag" className="size-3" /> {data.merchant.name}
              </Link>
            ) : null}
            {data.category ? (
              <Link href={`/categories/${data.category.id}`} aria-label={`Category ${data.category.name}`}>
                <CategoryChip label={data.category.name} hue={data.category.hue} icon={data.category.icon} compact />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {data.status === "detected" ? (
            <button
              type="button"
              onClick={() => setStatus("confirmed", "Series confirmed")}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
            >
              Confirm
            </button>
          ) : null}
          <Menu
            label="Series actions"
            items={[
              // a merged-away series must never be re-confirmed (§4.3)
              ...(data.status !== "confirmed" && !isMergedAway
                ? [{ label: "Confirm", icon: "check" as IconName, onSelect: () => setStatus("confirmed", "Series confirmed") }]
                : []),
              ...(data.status !== "dismissed"
                ? [{ label: "Not recurring", icon: "close" as IconName, onSelect: () => setStatus("dismissed", "Dismissed") }]
                : []),
              ...(data.status !== "ended"
                ? [{ label: "End series", icon: "circle-alert" as IconName, onSelect: () => setEndingSeries(true), destructive: true }]
                : []),
            ]}
          />
        </div>
      </div>

      {endingSeries ? (
        <Confirm
          open
          onClose={() => setEndingSeries(false)}
          onConfirm={() => {
            setEndingSeries(false);
            setStatus("ended", "Series ended");
          }}
          title="End this series"
          confirmLabel="End this series"
          radius={{
            headline: `${data.name} stops being expected: it leaves the forecast, the recurring calendar, and every budget's expected tail.`,
            // the arrears, the span and the kept rows — see `seriesEndLines`
            lines: seriesEndLines(
              {
                annualizedCents: data.annualizedCents,
                overdueCents: Math.abs(data.overdue?.amountCents ?? 0),
                overdueOn: data.overdue?.date ?? null,
                overdueCount: data.overdue?.occurrenceCount ?? 0,
                nextChargeOn: data.nextExpected[0]?.date ?? null,
                endsOn: data.endsOn,
                linkedCount: data.linkedTxns.length,
              },
              formatCents,
            ),
            reassurance:
              "Nothing is deleted — the charges stay in your ledger, and Confirm brings the series back if it starts again.",
          }}
        />
      ) : null}

      {isMergedAway && data.mergedInto ? (
        <p className="mt-4 rounded-(--radius-card) border border-line bg-surface-sunken/50 px-4 py-2.5 text-sm text-ink-muted">
          This series was merged into{" "}
          <Link href={`/recurring/${data.mergedInto.id}`} className="font-medium text-accent hover:underline">
            {data.mergedInto.name}
          </Link>
          . Its charges live there now.
        </p>
      ) : null}

      <div className="mt-6 space-y-6">
        {/* PHASE III-B. Where this commitment sits among the others and how much
            of a year's committed money it is — neither is a figure this page
            prints, and the annualized cost in the stats below is deliberately
            not restated. */}
        {insights}
        <SurfaceCard>
          <CadenceSentence
            seriesId={data.id}
            kind={data.kind}
            cadence={data.cadence}
            nextExpectedOn={data.nextExpectedOn}
            amountCents={data.nextExpectedAmountCents}
            userCadence={data.userCadence}
            userNextExpectedOn={data.userNextExpectedOn}
            userAmountCents={data.userAmountCents}
            detectedCadence={data.detectedCadence}
            accountName={data.accountName}
            status={data.status}
            onChanged={onChanged}
          />
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
            <Stat label="Annualized">
              {data.annualizedCents !== null ? <>~<Money cents={data.annualizedCents} />/yr</> : "—"}
              {/* ⛔ the figure this qualifies, not the header — and only when it
                  needs qualifying. "a full year — this one is scheduled only to
                  2028-08-15" ran on the EXISTENCE of an end date, so it said
                  "only" over a lease that bills all twelve of the next twelve
                  months. `annualizedCaveat` is silent for every series that
                  outlives the year. */}
              {annualizedNote !== null && data.annualizedCents !== null ? (
                <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                  {annualizedNote}
                </span>
              ) : null}
            </Stat>
            {/* the badge goes on PER CHARGE, the figure the forecast actually
                publishes. "Annualized" is that number multiplied out, so a
                second badge would answer one question twice. */}
            <Stat label="Per charge" provenance={provenance}>
              {data.nextExpectedAmountCents !== null ? (
                <>
                  <Money cents={data.nextExpectedAmountCents} flow />
                  {/* 🔴 measured from the linked rows, and only once there are
                      two of them. This read the detector's stored seed, so it
                      printed "±5.48" beside a badge saying "no basis yet" and a
                      linked count of 0.

                      ⛔ …AND THE ± BELONGS TO THE AVERAGE IT MEASURES. The
                      headline is the FORECAST amount, which is often entered by
                      hand and need not be the postings' mean: rent read
                      "-$2,109.00 ± 610.65" over four charges averaging
                      -$1,739.40, a band centred on a number nothing in it was
                      drawn from. When the two differ the average is named and
                      carries the spread — the wording `/recurring?tab=all`
                      already uses for the same pair. When they agree there is
                      one number and the ± stays on it. */}
                  {postedSpread.attachedToHeadline ? (
                    <span className="ml-1 text-[11px] font-normal text-ink-faint">
                      ±{postedSpread.text}
                    </span>
                  ) : null}
                  {postedSpread.avgLine !== null ? (
                    <span className="figures block text-[11px] font-normal text-ink-faint">
                      posted avg <Money cents={postedSpread.avgLine} flow />
                      {postedSpread.text !== null ? ` ± ${postedSpread.text}` : ""}
                    </span>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </Stat>
            <Stat label="Cadence">{CADENCE_LABEL[data.cadence]}</Stat>
            <Stat label="Confidence">{data.confidence !== null ? `${Math.round(data.confidence * 100)}%` : "—"}</Stat>
          </dl>
        </SurfaceCard>

        {data.amountHistory.length >= 2 ? (
          <SurfaceCard>
            {/* the lens switcher shares the heading line — this card has no
                ChartFocus button, so it needs no pr-9 clearance */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Amount history</h2>
              <ViewSwitcher
                dimension={LENS_DIMENSION}
                value={amountsAsTable ? "table" : "chart"}
                onSelect={(v) => setView(LENS_DIMENSION.key, v)}
                labels={LENS_LABELS}
                ariaLabel="Amount history lens"
              />
            </div>
            <AmountHistoryChart
              points={data.amountHistory}
              expectedCents={data.nextExpectedAmountCents}
              asTable={amountsAsTable}
            />
          </SurfaceCard>
        ) : null}

        {/* 🔴 THE BACKWARD HALF. This card jumped straight to "Next expected —
            Oct 1, 2026" for a rent charge that came due on 2026-09-01 and never
            posted — while the forecast counted it as a component, /budgets said
            "2 bills totalling $2,291.21 due by today and no import has covered
            them yet", the runway said "came due earlier this month and never
            posted", and the calendar marked Sep 1 with a "?". Every surface but
            the bill's own page. */}
        {data.overdue ? (
          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium text-warning">Already due, and not posted</h2>
            <p className="mb-3 text-xs text-ink-muted">
              Inside this calendar month, with no posting within {data.toleranceDays}{" "}
              {data.toleranceDays === 1 ? "day" : "days"}{" "}
              of it. The forecast counts it, and so does this month&apos;s budget.
            </p>
            <ul className="divide-y divide-line">
              <li className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="figures text-ink-muted">
                  {longDate(data.overdue.date)}
                  {data.overdue.occurrenceCount > 1
                    ? ` and ${data.overdue.occurrenceCount - 1} more`
                    : ""}
                </span>
                <Money cents={data.overdue.amountCents} flow />
              </li>
            </ul>
          </SurfaceCard>
        ) : null}

        {/* 🔴 An ENDED or DISMISSED series projected three dated future
            charges here — see `noScheduleReason`. Dropping the card silently
            would leave the reader wondering where the schedule went, so the
            reason goes where it was. */}
        {noScheduleReason(data.status) ? (
          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">Nothing expected</h2>
            <p className="text-xs text-ink-muted">{noScheduleReason(data.status)}</p>
          </SurfaceCard>
        ) : null}

        {data.nextExpected.length > 0 ? (
          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">Next expected</h2>
            <ul className="divide-y divide-line">
              {data.nextExpected.map((o) => (
                <li key={o.date} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className="figures text-ink-muted">{longDate(o.date)}</span>
                  <Money cents={o.amountCents} flow />
                </li>
              ))}
            </ul>
          </SurfaceCard>
        ) : null}

        <SurfaceCard>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Linked transactions · {data.linkedTxns.length}</h2>
            {/* only a live series can be reshaped — merging into or attaching to a
                dead one would move money off the forecast/calendar (§4.3) */}
            {isLive ? (
              <div className="flex flex-wrap items-center gap-2">
                <MergeControl seriesId={data.id} candidates={data.mergeCandidates} onChanged={onChanged} />
                <AttachPanel seriesId={data.id} onChanged={onChanged} />
              </div>
            ) : null}
          </div>
          <LinkedTransactions txns={data.linkedTxns} onChanged={onChanged} />
        </SurfaceCard>

        <Link href="/recurring" className="inline-block text-sm text-ink-muted hover:text-ink">
          ← All recurring
        </Link>
      </div>
    </>
  );
}

function Stat({
  label,
  provenance,
  children,
}: {
  label: string;
  /** beside the LABEL, never around the figure — see ProvenancePopover */
  provenance?: Provenance | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
        {label}
        {provenance && <ProvenancePopover label={label.toLowerCase()} provenance={provenance} />}
      </dt>
      <dd className="figures mt-0.5 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
