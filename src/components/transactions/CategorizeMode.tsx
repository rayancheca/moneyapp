"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import type { CategoryPickerOption } from "./CategoryPicker";
import type { LedgerRow } from "./TransactionsLedger";
import { TransactionSheet } from "./TransactionSheet";

interface CategorizeModeProps {
  /** the flagged (needs-review) rows to walk, newest-first */
  rows: readonly LedgerRow[];
  categories: readonly CategoryPickerOption[];
}

/**
 * A guided one-by-one pass through the review queue (ux-overhaul-plan §3.2 — the
 * learning loop): opens the transaction card on the first flagged row and walks
 * them with a progress counter, auto-advancing when a category is set so a
 * backlog drains in a rhythm. The queue is SNAPSHOTTED when the walk starts, so
 * the router.refresh() a categorize fires can't reshuffle the list mid-walk —
 * this client component keeps its position (and its index) across that refresh.
 */
export function CategorizeMode({ rows, categories }: CategorizeModeProps) {
  const router = useRouter();
  const [queue, setQueue] = useState<readonly LedgerRow[] | null>(null);
  const [index, setIndex] = useState(0);

  // Hide the launcher when there is nothing to walk — but NOT while a walk is
  // active: a "Recategorize all N" mid-walk can clear the whole live backlog
  // (rows → []); the snapshotted queue must keep the open card alive until the
  // user finishes or closes, rather than vanishing under them.
  if (rows.length === 0 && !queue) return null;

  function start(): void {
    setQueue(rows);
    setIndex(0);
  }

  function stop(): void {
    setQueue(null);
    setIndex(0);
    // reflect everything reviewed during the walk (the queue shrinks)
    router.refresh();
  }

  function move(delta: -1 | 1): void {
    setIndex((i) => Math.min(Math.max(0, i + delta), (queue?.length ?? 1) - 1));
  }

  /** after a category is set, step to the next row; end of queue → close. */
  function advance(): void {
    const total = queue?.length ?? 0;
    if (index + 1 < total) setIndex(index + 1);
    else stop();
  }

  const current = queue ? queue[index] : null;

  return (
    <>
      {!queue ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) border border-line bg-surface-raised p-4">
          <div>
            <h2 className="text-sm font-medium">Categorize one by one</h2>
            <p className="text-xs text-ink-muted">
              Walk each flagged transaction — accept a suggestion or set a rule, and the engine learns as you go.
            </p>
          </div>
          <Button icon="tag" onClick={start}>
            Start · {rows.length}
          </Button>
        </div>
      ) : null}

      {current ? (
        <TransactionSheet
          key={current.id}
          txn={current}
          categories={categories}
          progress={{ index, total: queue!.length }}
          onClose={stop}
          onFlip={queue!.length > 1 ? move : undefined}
          onCategorized={advance}
          onRowChanged={() => undefined}
        />
      ) : null}
    </>
  );
}
