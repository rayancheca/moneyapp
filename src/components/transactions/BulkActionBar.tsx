"use client";

import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { countPhrase, type BlastRadius } from "@/components/ui/blast-radius";
import { Confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/shell/Icon";
import { formatCents } from "@/lib/money";
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
  /**
   * Net cents the selection carries, when the ledger can sum it. The confirm
   * states the money the mutation would touch whenever this is supplied; the
   * count-only sentence is the honest fallback while it is not.
   */
  selectionCents?: number | null;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onCategory: (categoryId: string) => void;
  onReviewed: () => void;
  onExclude: () => void;
  onTransfer: () => void;
}

/** The two bulk verbs that change what a row MEANS to every analytic. */
type GatedAction = "exclude" | "transfer";

export function BulkActionBar({
  count,
  allMatching,
  totalMatching,
  categories,
  selectionCents = null,
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
  const effectiveCount = allMatching ? totalMatching : count;

  const [gated, setGated] = useState<GatedAction | null>(null);

  // Entering selection mode unmounts the "Select" button that had focus, so
  // land focus on the bar — keyboard users stay oriented and a screen reader
  // announces the region and its controls.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  /**
   * The gate for one verb, built only when it is actually asked for — the bar
   * itself must never depend on the blast-radius copy to render.
   *
   * The measured lines: the count is always known; the money only when the
   * ledger handed it down, and a line stating nothing is worse than no line.
   */
  function gateFor(action: GatedAction): {
    title: string;
    confirmLabel: string;
    radius: BlastRadius;
    run: () => void;
  } {
    const lines = [
      {
        label: "Transactions touched",
        value: countPhrase(effectiveCount, "transaction"),
        irreversible: true,
      },
      ...(selectionCents !== null
        ? [{ label: "Money they carry", value: formatCents(selectionCents) }]
        : []),
      ...(allMatching
        ? [{ label: "Scope", value: "every transaction matching the current filters" }]
        : []),
    ];

    if (action === "exclude") {
      return {
        title: "Exclude these transactions",
        confirmLabel: "Exclude them",
        run: onExclude,
        radius: {
          headline:
            "Excluded transactions drop out of spending, income, budgets, and every chart — they stay in the ledger, greyed out.",
          lines,
          reassurance: "Undo restores them, and so does Restore on any excluded row.",
        },
      };
    }
    return {
      title: "Mark these as transfers",
      confirmLabel: "Mark them as transfers",
      run: onTransfer,
      radius: {
        headline:
          "Marking these as transfers says the money moved between your own accounts, so it stops counting as spending or income.",
        lines,
        reassurance:
          "The rows keep their amounts and stay in the ledger — undo, or clearing the transfer mark, puts them back in the analytics.",
      },
    };
  }

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
            <Button variant="secondary" size="sm" onClick={() => setGated("exclude")}>
              Exclude
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setGated("transfer")}>
              Transfer
            </Button>
          </div>
        </>
      ) : null}

      <IconButton icon="close" size="sm" aria-label="Cancel selection" onClick={onClear} />

      {/* the two verbs that change what a row MEANS state their blast radius
          first; the bar keeps every capability it had, one dialog earlier */}
      {gated !== null ? <BulkGate gate={gateFor(gated)} onClose={() => setGated(null)} /> : null}
    </div>
  );
}

function BulkGate({
  gate,
  onClose,
}: {
  gate: { title: string; confirmLabel: string; radius: BlastRadius; run: () => void };
  onClose: () => void;
}) {
  return (
    <Confirm
      open
      onClose={onClose}
      onConfirm={() => {
        onClose();
        gate.run();
      }}
      title={gate.title}
      confirmLabel={gate.confirmLabel}
      radius={gate.radius}
    />
  );
}
