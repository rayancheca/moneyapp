"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/Toast";
import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { Icon } from "@/components/shell/Icon";
import { PRIORITIES } from "@/lib/keyscope";
import {
  bulkApplyByFilterAction,
  confirmClusterAction,
  markAllReviewedBeforeAction,
  recategorizeClusterAction,
} from "@/app/transactions/actions";
import type { ReviewCluster, ReviewInboxSummary } from "@/services/review-inbox";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";
import { offerUndoToast } from "./undo-toast";

/**
 * The review inbox (ux-overhaul-plan §3.3): the needsReview backlog as a
 * merchant-clustered, clearable queue. Confirm a cluster (accept its
 * categorizations) or fix it (recategorize all) in one gesture; a first-run
 * amnesty drains the historical backlog before this month. Every action is a
 * value-returning server action → a Toast with a lossless Undo. Pressing `R`
 * confirms the cluster your focus is inside — the fast-triage accelerator.
 */

interface ReviewInboxProps {
  data: ReviewInboxSummary;
  categories: readonly CategoryPickerOption[];
}

const REVIEW_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const AMNESTY_MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

function formatDay(iso: string): string {
  return REVIEW_DAY.format(new Date(`${iso}T12:00:00`));
}

export function ReviewInbox({ data, categories }: ReviewInboxProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function afterMutation(): void {
    startTransition(() => router.refresh());
  }

  function confirm(cluster: ReviewCluster): void {
    void confirmClusterAction(cluster.ref).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      if (r.data.affected === 0) return; // already cleared by a prior click
      afterMutation();
      offerUndoToast(`Confirmed ${r.data.affected} · ${cluster.label}`, r.data.undo, afterMutation);
    });
  }

  function recategorize(cluster: ReviewCluster, categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    void recategorizeClusterAction({ ref: cluster.ref, categoryId }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      if (r.data.affected === 0) return; // already cleared by a prior click
      afterMutation();
      offerUndoToast(`${r.data.affected} → ${option?.name ?? "category"}`, r.data.undo, afterMutation);
    });
  }

  function drainBacklog(): void {
    void markAllReviewedBeforeAction(data.amnestyCutoff).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      if (r.data.affected === 0) return;
      afterMutation();
      offerUndoToast(`Marked ${r.data.affected} reviewed`, r.data.undo, afterMutation);
    });
  }

  function markAll(): void {
    void bulkApplyByFilterAction({ params: { view: "review" }, patch: { markReviewed: true } }).then(
      (r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        if (r.data.affected === 0) return;
        afterMutation();
        offerUndoToast(`Marked ${r.data.affected} reviewed`, r.data.undo, afterMutation);
      },
    );
  }

  // `R` confirms the cluster containing the CURRENTLY focused element, resolved
  // at keypress from the live document.activeElement — never a stale tracked key
  // — so the accelerator can only ever act on the card a reader is actually in
  // (a bare `r` with focus outside every card is a no-op).
  useKeyScope(
    "review-inbox",
    {
      r: () => {
        const el = document.activeElement;
        const card = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-cluster-key]") : null;
        const cluster = card ? data.clusters.find((c) => c.key === card.dataset.clusterKey) : undefined;
        if (cluster) confirm(cluster);
      },
    },
    data.clusters.length > 0,
    { priority: PRIORITIES.list },
  );

  if (data.totalCount === 0) {
    return (
      <EmptyState
        title="Review queue is clear"
        description="Nothing needs review. Low-confidence categorizations, big uncategorized deposits, and ambiguous transfer pairs land here as they arrive."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) border border-line bg-surface-raised px-4 py-3">
        {/* section heading: keeps the outline h1 (Transactions) → h2 → h3 (clusters) */}
        <h2 className="flex items-baseline gap-2">
          <span className="figures text-2xl font-semibold tabular-nums">{data.totalCount}</span>
          <span className="text-sm font-normal text-ink-muted">
            to review · {data.clusterCount} {data.clusterCount === 1 ? "group" : "groups"}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {data.amnestyBeforeCount > 0 ? (
            <Button variant="secondary" size="sm" icon="check" onClick={drainBacklog}>
              Mark {data.amnestyBeforeCount} before {AMNESTY_MONTH.format(new Date(`${data.amnestyCutoff}T12:00:00`))} reviewed
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={markAll}>
            Mark all reviewed
          </Button>
        </div>
      </div>

      <ul className="space-y-3">
        {data.clusters.map((cluster) => (
          <ClusterCard
            key={cluster.key}
            cluster={cluster}
            categories={categories}
            onConfirm={() => confirm(cluster)}
            onRecategorize={(categoryId) => recategorize(cluster, categoryId)}
          />
        ))}
      </ul>
    </div>
  );
}

interface ClusterCardProps {
  cluster: ReviewCluster;
  categories: readonly CategoryPickerOption[];
  onConfirm: () => void;
  onRecategorize: (categoryId: string) => void;
}

function ClusterCard({ cluster, categories, onConfirm, onRecategorize }: ClusterCardProps) {
  const categorized = cluster.dominantCategoryId !== null;
  const categoryOption = categorized
    ? categories.find((c) => c.id === cluster.dominantCategoryId)
    : undefined;

  return (
    <li
      data-cluster-key={cluster.key}
      className="rounded-(--radius-card) border border-line bg-surface-raised p-4 transition-shadow duration-(--duration-fast) focus-within:border-line-strong focus-within:shadow-(--shadow-overlay)"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink">{cluster.label}</h3>
            <Badge tone="info">×{cluster.count}</Badge>
            {cluster.kind === "similar" ? (
              <span className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">similar</span>
            ) : null}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
            {categorized ? (
              <>
                <CategoryChip
                  label={categoryOption?.name ?? cluster.dominantCategoryLabel ?? "category"}
                  hue={categoryOption?.hue ?? null}
                  icon={categoryOption?.icon ?? null}
                  compact
                />
                <span>{cluster.uniformCategory ? "all" : "mostly"} {cluster.dominantCategoryLabel}</span>
              </>
            ) : (
              <span className="text-warning">Uncategorized — needs a category</span>
            )}
          </p>
        </div>
        <Money cents={cluster.netCents} flow className="figures shrink-0 text-sm" />
      </div>

      <ul className="mt-3 space-y-1 border-t border-line pt-3">
        {cluster.sample.map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="figures shrink-0">{formatDay(row.postedOn)}</span>
            <span className="min-w-0 flex-1 truncate">{row.description}</span>
            <span className="hidden shrink-0 sm:inline">{row.accountName}</span>
            <Money cents={row.amountCents} flow className="figures shrink-0" />
          </li>
        ))}
        {cluster.count > cluster.sample.length ? (
          <li className="text-[11px] text-ink-faint">+{cluster.count - cluster.sample.length} more</li>
        ) : null}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {categorized ? (
          <>
            <Button variant="primary" size="sm" icon="check" onClick={onConfirm}>
              Confirm all {cluster.count}
            </Button>
            <CategoryPicker
              options={categories}
              currentId={cluster.dominantCategoryId}
              onPick={onRecategorize}
            >
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong">
                <Icon name="edit" className="size-3.5" /> Recategorize
              </span>
            </CategoryPicker>
          </>
        ) : (
          <>
            <CategoryPicker
              options={categories}
              currentId={cluster.dominantCategoryId}
              onPick={onRecategorize}
            >
              <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90">
                <Icon name="tag" className="size-3.5" /> Categorize all {cluster.count}
              </span>
            </CategoryPicker>
            <Button variant="secondary" size="sm" onClick={onConfirm}>
              Mark reviewed
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
