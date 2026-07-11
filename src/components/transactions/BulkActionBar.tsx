"use client";

import { useEffect, useRef } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/shell/Icon";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";

/**
 * The bulk-edit action bar (ux-overhaul-plan §3.5): a bottom-pinned bar shown
 * in selection mode. It states the server-computed blast radius ("All N
 * selected") and offers category / reviewed / exclude / transfer — the set the
 * bulk-edit service implements today (bulk merchant reassignment is deferred).
 * Presentational only: the ledger owns selection state and the apply→toast→undo
 * flow, mirroring the value-returning-action pattern everywhere else in Stage 1.
 */

interface BulkActionBarProps {
  /** effective count: explicit picks, or the whole matching set when allMatching */
  count: number;
  allMatching: boolean;
  totalMatching: number;
  categories: readonly CategoryPickerOption[];
  onSelectAllMatching: () => void;
  onClear: () => void;
  onCategory: (categoryId: string) => void;
  onReviewed: () => void;
  onExclude: () => void;
  onTransfer: () => void;
}

export function BulkActionBar({
  count,
  allMatching,
  totalMatching,
  categories,
  onSelectAllMatching,
  onClear,
  onCategory,
  onReviewed,
  onExclude,
  onTransfer,
}: BulkActionBarProps) {
  // offer "select all" only when the current picks don't already span the set
  const canSelectAll = !allMatching && count < totalMatching;
  // the mutation actions need something to act on
  const hasSelection = allMatching || count > 0;

  // Entering selection mode unmounts the "Select" button that had focus, so
  // land focus on the bar — keyboard users stay oriented and a screen reader
  // announces the region and its controls.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      role="region"
      aria-label="Bulk actions"
      className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius-overlay) border border-line bg-surface-overlay px-3 py-2 shadow-(--shadow-overlay) outline-none"
    >
      <span className="text-sm font-medium whitespace-nowrap">
        <span className="figures tabular-nums">{allMatching ? totalMatching : count}</span> selected
      </span>

      {canSelectAll ? (
        <button
          type="button"
          onClick={onSelectAllMatching}
          className="text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          Select all {totalMatching}
        </button>
      ) : null}

      {hasSelection ? (
        <>
          <span aria-hidden className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryPicker options={categories} currentId={null} onPick={onCategory}>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong">
                <Icon name="tag" className="size-3.5" /> Category
              </span>
            </CategoryPicker>
            <Button variant="secondary" size="sm" icon="check" onClick={onReviewed}>
              Reviewed
            </Button>
            <Button variant="secondary" size="sm" onClick={onExclude}>
              Exclude
            </Button>
            <Button variant="secondary" size="sm" onClick={onTransfer}>
              Transfer
            </Button>
          </div>
        </>
      ) : null}

      <IconButton icon="close" size="sm" aria-label="Cancel selection" onClick={onClear} />
    </div>
  );
}
