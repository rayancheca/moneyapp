"use client";

import { useState } from "react";
import Link from "next/link";
import { Sheet } from "@/components/ui/Sheet";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Money } from "@/components/ui/Money";
import { formatDayLong } from "@/lib/format-date";

/**
 * Largest spending (ux-overhaul-plan §5.4): the period's top outflows, each
 * opening a detail Sheet with a link into the ledger for full context.
 */

export interface LargestPurchaseRow {
  id: string;
  postedOn: string;
  description: string;
  amountCents: number;
  accountName: string;
  categoryName: string | null;
  hue: string | null;
  icon: string | null;
  ledgerHref: string;
}

export function LargestPurchases({ rows }: { rows: LargestPurchaseRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;

  // the same noun as the heading — see /spending/page.tsx
  if (rows.length === 0) return <p className="text-sm text-ink-muted">Nothing was spent in this period.</p>;

  return (
    <>
      <ul className="space-y-0.5">
        {rows.map((row, i) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => setOpenId(row.id)}
              className="flex w-full items-center gap-3 rounded-md px-1.5 py-2 text-left transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
            >
              <span aria-hidden className="w-4 shrink-0 text-center text-xs font-medium text-ink-faint tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.description}</span>
                <span className="block text-xs text-ink-faint">{formatDayLong(row.postedOn)}</span>
              </span>
              <Money cents={row.amountCents} flow className="shrink-0 text-sm font-medium" />
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={open !== null} onClose={() => setOpenId(null)} title="Purchase detail">
        {open && (
          <div className="space-y-4">
            <div>
              <Money cents={open.amountCents} flow className="block text-2xl font-semibold" />
              <p className="mt-1 text-sm text-ink-muted">{formatDayLong(open.postedOn)}</p>
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Description</dt>
                <dd className="max-w-[60%] truncate text-right">{open.description}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Category</dt>
                <dd>
                  {open.categoryName ? (
                    <CategoryChip label={open.categoryName} hue={open.hue} icon={open.icon} />
                  ) : (
                    <span className="text-ink-faint italic">Uncategorized</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Account</dt>
                <dd>{open.accountName}</dd>
              </div>
            </dl>
            <Link
              href={open.ledgerHref}
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              View that day in the ledger →
            </Link>
          </div>
        )}
      </Sheet>
    </>
  );
}
