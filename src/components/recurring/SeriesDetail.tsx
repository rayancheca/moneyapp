"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { renameSeriesAction, setSeriesStatusAction } from "@/app/recurring/actions";
import { Badge } from "@/components/ui/Badge";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { CategoryChip } from "@/components/ui/CategoryChip";
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
import { CADENCE_LABEL, KIND_LABEL, longDate, STATUS_LABEL } from "./labels";

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
export function SeriesDetail({ data }: { data: SeriesDetailData }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

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
            {(data.status === "detected" || data.status === "confirmed") && !data.isActive ? (
              <Badge tone="warning">Inactive</Badge>
            ) : null}
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
                ? [{ label: "End series", icon: "circle-alert" as IconName, onSelect: () => setStatus("ended", "Series ended"), destructive: true }]
                : []),
            ]}
          />
        </div>
      </div>

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
            onChanged={onChanged}
          />
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
            <Stat label="Annualized">
              {data.annualizedCents !== null ? <>~<Money cents={data.annualizedCents} />/yr</> : "—"}
            </Stat>
            <Stat label="Per charge">
              {data.nextExpectedAmountCents !== null ? (
                <>
                  <Money cents={data.nextExpectedAmountCents} flow />
                  {data.amountCentsStddev !== null && data.amountCentsStddev > 0 ? (
                    <span className="ml-1 text-[11px] font-normal text-ink-faint">±{(data.amountCentsStddev / 100).toFixed(2)}</span>
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
            <h2 className="mb-3 text-sm font-medium">Amount history</h2>
            <AmountHistoryChart points={data.amountHistory} expectedCents={data.nextExpectedAmountCents} />
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
          <LinkedTransactions seriesId={data.id} txns={data.linkedTxns} onChanged={onChanged} />
        </SurfaceCard>

        <Link href="/recurring" className="inline-block text-sm text-ink-muted hover:text-ink">
          ← All recurring
        </Link>
      </div>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">{label}</dt>
      <dd className="figures mt-0.5 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
