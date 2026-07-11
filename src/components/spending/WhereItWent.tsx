"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { toast } from "@/components/ui/Toast";
import { Icon } from "@/components/shell/Icon";
import type { CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { loadSpendingCategoryTxns, type SpendingCategoryTxns } from "@/app/spending/actions";
import { InlineCategorizeList } from "./InlineCategorizeList";

/**
 * "Where it went", made editable (ux-overhaul-plan §5.4): the category breakdown
 * table where every row — including the explicit Uncategorized bucket — expands
 * into its exact transactions with inline category pickers. Categorizing here is
 * the same value-returning flow as the ledger (smart snackbar + Undo), so the
 * numbers above update on `router.refresh()`. Drill-through links to the full
 * filtered ledger are preserved on every category name.
 */

interface BreakdownChild {
  categoryId: string;
  name: string;
  spentCents: number;
  txnCount: number;
}

interface BreakdownRow {
  categoryId: string | null;
  name: string;
  spentCents: number;
  txnCount: number;
  children: BreakdownChild[];
}

const TH = "pb-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint";
const TH_NUM = `${TH} text-right`;

/** Client-side twin of analytics.transactionsHref — kept here so this client
 *  component never imports the server analytics module. */
function txnsHref(categoryId: string | null, from: string, to: string): string {
  const params = new URLSearchParams({ category: categoryId ?? "uncategorized", from, to });
  return `/transactions?${params.toString()}`;
}

export function WhereItWent({
  breakdown,
  categories,
  rangeFrom,
  rangeTo,
  monthCount,
}: {
  breakdown: readonly BreakdownRow[];
  categories: readonly CategoryPickerOption[];
  rangeFrom: string;
  rangeTo: string;
  monthCount: number;
}) {
  // Any inline recategorize can move a row BETWEEN buckets, so every currently
  // expanded bucket may be stale afterward — not just the one edited. A shared
  // version, bumped on every change, invalidates all open buckets at once so a
  // sibling's drilled-down list never contradicts its (refreshed) header count.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <SurfaceCard>
      <h2 className="mb-1 text-sm font-medium">Where it went</h2>
      <p className="mb-3 text-xs text-ink-muted">
        Full {monthCount}-month range · expand any row to fix its categories inline, or follow a name
        to its exact transactions.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={TH}>Category</th>
            <th scope="col" className={TH_NUM}>Transactions</th>
            <th scope="col" className={TH_NUM}>Spent</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((row) => (
            <BreakdownEntry
              key={row.categoryId ?? "uncategorized"}
              entry={row}
              categories={categories}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              depth={0}
              version={version}
              onChanged={bump}
            />
          ))}
        </tbody>
      </table>
    </SurfaceCard>
  );
}

function BreakdownEntry({
  entry,
  categories,
  rangeFrom,
  rangeTo,
  depth,
  version,
  onChanged,
}: {
  entry: BreakdownRow | (BreakdownChild & { children?: undefined });
  categories: readonly CategoryPickerOption[];
  rangeFrom: string;
  rangeTo: string;
  depth: number;
  /** bumps on any inline change anywhere — invalidates this bucket if open */
  version: number;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SpendingCategoryTxns | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch is effect-driven, keyed on (open, category, range, version): opening
  // fetches, the period changing refetches, and a `version` bump (any inline
  // recategorize) refetches every OPEN bucket — so a sibling list can never
  // outlive the edit that moved a row into or out of it. The live-guard drops a
  // superseded response so a slow earlier fetch can't overwrite a newer one.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    void loadSpendingCategoryTxns({ categoryId: entry.categoryId, from: rangeFrom, to: rangeTo }).then(
      (r) => {
        if (!live) return;
        setLoading(false);
        if (r.ok) setData(r.data);
        else toast({ title: r.error, tone: "negative" });
      },
    );
    return () => {
      live = false;
    };
  }, [open, entry.categoryId, rangeFrom, rangeTo, version]);

  function toggle(): void {
    setOpen((o) => !o);
  }

  function afterChange(): void {
    onChanged(); // invalidate every open bucket (this one + siblings)
    startTransition(() => router.refresh()); // refresh the header counts
  }

  const children = "children" in entry ? entry.children : undefined;
  const isChild = depth > 0;

  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className={isChild ? "py-1.5" : "py-2"} style={{ paddingLeft: `${depth * 1.25}rem` }}>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
              className="grid size-4 shrink-0 place-items-center rounded text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Icon
                name="chevron-right"
                className={`size-3.5 transition-transform duration-(--duration-fast) ${open ? "rotate-90" : ""}`}
              />
            </button>
            <Link
              href={txnsHref(entry.categoryId, rangeFrom, rangeTo)}
              className={`${isChild ? "text-ink-muted" : "font-medium"} hover:text-accent hover:underline`}
            >
              {entry.name}
            </Link>
          </span>
        </td>
        <td className={`text-right ${isChild ? "py-1.5 text-ink-faint" : "py-2 text-ink-muted"}`}>
          {entry.txnCount}
        </td>
        <td className={`text-right ${isChild ? "py-1.5" : "py-2"}`}>
          <Money cents={entry.spentCents} className={isChild ? "text-ink-muted" : undefined} />
        </td>
      </tr>

      {open ? (
        <tr>
          <td colSpan={3} className="bg-surface-sunken/40 px-2">
            {data ? (
              <InlineCategorizeList data={data} categories={categories} onChanged={afterChange} />
            ) : (
              <p className="px-1 py-3 text-xs text-ink-faint">
                {loading ? "Loading transactions…" : "No transactions."}
              </p>
            )}
          </td>
        </tr>
      ) : null}

      {children?.map((child) => (
        <BreakdownEntry
          key={child.categoryId}
          entry={child}
          categories={categories}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          depth={1}
          version={version}
          onChanged={onChanged}
        />
      ))}
    </>
  );
}
