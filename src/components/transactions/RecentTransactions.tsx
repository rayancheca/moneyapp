"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { LetterBadge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";
import type { CategoryPickerOption } from "./CategoryPicker";
import type { LedgerRow } from "./TransactionsLedger";
import { TransactionSheet } from "./TransactionSheet";

/**
 * A compact, read-first list of recent transactions (ux-overhaul-plan §7.1/§7.3):
 * the dashboard teaser and an account's recent rows share it, so both open the
 * SAME transaction Sheet in place — a category chip, badges, the amount, and a
 * tap that reveals the full editor without leaving the page. No selection mode,
 * no bulk bar; this is the calm surface, the full ledger is one click away.
 */
export function RecentTransactions({
  rows,
  categories,
  onRowChanged,
}: {
  rows: readonly LedgerRow[];
  categories: readonly CategoryPickerOption[];
  /** override the after-change refresh (default: router.refresh) — the dashboard
   *  period panel passes one that also re-fetches its windowed rows */
  onRowChanged?: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const handleRowChanged = onRowChanged ?? (() => startTransition(() => router.refresh()));

  const openIndex = openId === null ? -1 : rows.findIndex((r) => r.id === openId);
  const openRow = openIndex >= 0 ? rows[openIndex]! : null;

  // If the open row leaves the refreshed list (e.g. excluded from the teaser),
  // forget it — otherwise an Undo that re-adds the row would silently reopen the
  // sheet the user had already dismissed.
  useEffect(() => {
    if (openId !== null && openRow === null) setOpenId(null);
  }, [openId, openRow]);

  function flip(delta: -1 | 1): void {
    if (openIndex < 0) return;
    const next = rows[openIndex + delta];
    if (next) setOpenId(next.id);
  }

  return (
    <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setOpenId(r.id)}
          aria-haspopup="dialog"
          className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-surface-sunken"
        >
          <CategoryChip
            label={r.categoryName ?? "Uncategorized"}
            hue={r.hue}
            icon={r.icon}
            compact
            className="shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-sm">{r.normalizedDescription}</span>
          <span className="hidden items-center gap-1 sm:flex">
            {r.isTransfer ? <LetterBadge letter="T" /> : null}
            {r.isRecurring ? <LetterBadge letter="R" /> : null}
          </span>
          <span className="figures hidden whitespace-nowrap text-xs text-ink-faint md:inline">{r.postedOn}</span>
          {r.needsReview ? (
            <span aria-label="Needs review" className="inline-block size-1.5 shrink-0 rounded-full bg-info" />
          ) : null}
          <Money cents={r.amountCents} flow className="whitespace-nowrap text-sm" />
        </button>
      ))}

      {openRow ? (
        <TransactionSheet
          key={openRow.id}
          txn={openRow}
          categories={categories}
          onClose={() => setOpenId(null)}
          onFlip={rows.length > 1 ? flip : undefined}
          onRowChanged={handleRowChanged}
        />
      ) : null}
    </div>
  );
}
