"use client";

import { useState } from "react";
import Link from "next/link";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import { SpendDelta } from "@/components/spending/SpendDelta";

/**
 * The Spending tab's categories table (ux-overhaul-plan §5.4): a CategoryChip,
 * a share-of-period bar, a MoM delta, and expandable parents whose subcategories
 * and whose row both link to the category page — the entity that closes the
 * chain (recurring series, budget, trend). Uncategorized/Excluded live in their
 * own honesty section, so they never appear here.
 */

export interface CategoryTableChild {
  categoryId: string;
  name: string;
  spentCents: number;
}

export interface CategoryTableRow {
  categoryId: string;
  name: string;
  hue: string | null;
  icon: string | null;
  spentCents: number;
  /** 0..100 share of the period's spending */
  sharePct: number;
  /** current period − previous period (positive = spending rose) */
  momDeltaCents: number;
  children: CategoryTableChild[];
}

export function SpendingCategoriesTable({
  rows,
  showDelta = true,
}: {
  rows: CategoryTableRow[];
  /** the MoM column is only meaningful month-over-month; hidden for quarter/year */
  showDelta?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (rows.length === 0) return <p className="text-sm text-ink-muted">No spending in this period.</p>;

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => {
        const isOpen = expanded.has(row.categoryId);
        const hasChildren = row.children.length > 0;
        return (
          <li key={row.categoryId}>
            <div className="flex items-center gap-2 py-2.5">
              <button
                type="button"
                onClick={() => hasChildren && toggle(row.categoryId)}
                aria-expanded={hasChildren ? isOpen : undefined}
                aria-label={hasChildren ? `${isOpen ? "Collapse" : "Expand"} ${row.name} subcategories` : undefined}
                disabled={!hasChildren}
                className={`grid size-5 shrink-0 place-items-center rounded transition-colors duration-(--duration-fast) ${
                  hasChildren ? "text-ink-faint hover:bg-surface-sunken hover:text-ink" : "invisible"
                }`}
              >
                <Icon name="chevron-right" className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </button>

              <Link
                href={`/categories/${row.categoryId}`}
                className="flex min-w-0 flex-1 items-center gap-2.5 hover:underline"
              >
                <CategoryChip label={row.name} hue={row.hue} icon={row.icon} compact />
                <span className="truncate text-sm">{row.name}</span>
              </Link>

              <div aria-hidden className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-sunken sm:block">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.min(100, row.sharePct)}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right text-xs text-ink-faint tabular-nums">
                {Math.round(row.sharePct)}%
              </span>
              {showDelta && (
                <span className="hidden w-20 shrink-0 text-right text-xs md:block">
                  <SpendDelta cents={row.momDeltaCents} />
                </span>
              )}
              <Money cents={row.spentCents} className="w-24 shrink-0 text-right text-sm font-medium" />
            </div>

            {isOpen && hasChildren && (
              <ul className="mb-1 ml-7 space-y-0.5 border-l border-line pl-3">
                {row.children.map((child) => (
                  <li key={child.categoryId}>
                    <Link
                      href={`/categories/${child.categoryId}`}
                      className="flex items-center justify-between gap-2 rounded py-1.5 pr-1 text-sm text-ink-muted hover:text-ink"
                    >
                      <span className="truncate">{child.name}</span>
                      <Money cents={child.spentCents} className="shrink-0 text-xs" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
