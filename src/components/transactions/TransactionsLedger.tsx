"use client";

import { useMemo, useState } from "react";
import { LetterBadge } from "@/components/ui/Badge";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Money } from "@/components/ui/Money";
import type { TransactionStatus } from "@/db/schema/transactions";
import type { CategoryPickerOption } from "./CategoryPicker";
import { TransactionSheet } from "./TransactionSheet";

/** One serialized ledger row — the client grammar needs all of this in hand. */
export interface LedgerRow {
  id: string;
  postedOn: string;
  rawDescription: string;
  normalizedDescription: string;
  accountName: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  hue: string | null;
  icon: string | null;
  merchantId: string | null;
  isTransfer: boolean;
  isRecurring: boolean;
  needsReview: boolean;
  status: TransactionStatus;
  notes: string | null;
  lowConfidence: boolean;
  suggestedCategoryIds: readonly string[];
}

interface DayGroup {
  day: string;
  label: string;
  netCents: number;
  rows: LedgerRow[];
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

function groupByDay(rows: readonly LedgerRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.day === row.postedOn) {
      last.rows.push(row);
      last.netCents += row.amountCents;
    } else {
      groups.push({
        day: row.postedOn,
        label: DAY_FORMAT.format(new Date(`${row.postedOn}T12:00:00`)),
        netCents: row.amountCents,
        rows: [row],
      });
    }
  }
  return groups;
}

/**
 * Date-grouped triage ledger (ux-overhaul-plan §3.1): a client component so the
 * keyboard grammar and the transaction Sheet own it. Row tap opens the Sheet;
 * ↑/↓ flips through rows with it open. Corrections, rules, and undo all live in
 * the Sheet's value-returning-action flow.
 */
export function TransactionsLedger({
  rows,
  categories,
}: {
  rows: readonly LedgerRow[];
  categories: readonly CategoryPickerOption[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = useMemo(() => groupByDay(rows), [rows]);
  const openIndex = openId === null ? -1 : rows.findIndex((r) => r.id === openId);
  const openRow = openIndex >= 0 ? rows[openIndex]! : null;

  function flip(delta: -1 | 1): void {
    if (openIndex < 0) return;
    const next = rows[openIndex + delta];
    if (next) setOpenId(next.id);
  }

  return (
    <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
      {groups.map((group) => (
        <section key={group.day}>
          <div className="flex items-baseline justify-between border-b border-line bg-surface-sunken/60 px-4 py-1.5">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">{group.label}</h2>
            <Money cents={group.netCents} flow className="figures text-[11px]" />
          </div>
          {group.rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpenId(r.id)}
              aria-haspopup="dialog"
              className="group flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-surface-sunken"
            >
              <CategoryChip label={r.categoryName ?? "Uncategorized"} hue={r.hue} icon={r.icon} />
              <span className="min-w-0 flex-1 truncate text-sm">{r.normalizedDescription}</span>
              <span className="hidden items-center gap-1 sm:flex">
                {r.isTransfer ? <LetterBadge letter="T" /> : null}
                {r.isRecurring ? <LetterBadge letter="R" /> : null}
              </span>
              <span className="hidden whitespace-nowrap text-xs text-ink-muted md:inline">{r.accountName}</span>
              {r.needsReview ? (
                <span aria-label="Needs review" className="inline-block size-1.5 shrink-0 rounded-full bg-info" />
              ) : null}
              <Money cents={r.amountCents} flow className="whitespace-nowrap text-sm" />
            </button>
          ))}
        </section>
      ))}

      {openRow ? (
        <TransactionSheet
          key={openRow.id}
          txn={openRow}
          categories={categories}
          onClose={() => setOpenId(null)}
          onFlip={rows.length > 1 ? flip : undefined}
          onRowChanged={() => undefined}
        />
      ) : null}
    </div>
  );
}
