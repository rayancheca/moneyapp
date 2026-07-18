"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LetterBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/Toast";
import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { PRIORITIES } from "@/lib/keyscope";
import { bulkApplyAction, bulkApplyByFilterAction } from "@/app/transactions/actions";
import type { TxnPatch } from "@/app/transactions/action-types";
import type { TransactionStatus } from "@/db/schema/transactions";
import { Icon } from "@/components/shell/Icon";
import { BulkActionBar } from "./BulkActionBar";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";
import { runCategoryCorrection } from "./correct-category";
import { LedgerRowExpander } from "./LedgerRowExpander";
import type { SearchParams } from "./query";
import { TransactionSheet } from "./TransactionSheet";
import { offerUndoToast } from "./undo-toast";

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
  /** importFileId IS NULL — a user-authored row whose facts are correctable */
  isManual: boolean;
  lowConfidence: boolean;
  suggestedCategoryIds: readonly string[];
  /** number of category-allocation parts; 0/undefined = unsplit. When >0 the row
   * shows a "Split · N" chip instead of a single category control (edit in sheet). */
  splitCount?: number;
}

interface DayGroup {
  day: string;
  label: string;
  netCents: number;
  rows: LedgerRow[];
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

// §2.5 row-control reveal: hover / focus-within / any-selection / coarse pointer
const REVEAL =
  "opacity-0 transition-opacity duration-(--duration-fast) group-hover/row:opacity-100 " +
  "group-focus-within/row:opacity-100 pointer-coarse:opacity-100";

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
 * Date-grouped triage ledger (ux-overhaul-plan §3.1/§3.5): a client component so
 * the keyboard grammar, the transaction Sheet, and selection mode own it. Row
 * tap opens the Sheet; ↑/↓ flips through rows with it open. `Select` (or the `X`
 * accelerator) enters selection mode: per-row checkboxes plus "Select all N
 * matching", acted on through the bottom BulkActionBar. Bulk mutations are the
 * same value-returning actions → a Toast with a lossless Undo; "select all"
 * routes through bulkApplyByFilter so the blast radius is the server's count,
 * not just the visible page.
 */
export function TransactionsLedger({
  rows,
  categories,
  selectionParams,
  totalMatching,
}: {
  rows: readonly LedgerRow[];
  categories: readonly CategoryPickerOption[];
  /** raw searchParams for select-all-matching (parseFilters is the boundary) */
  selectionParams: SearchParams;
  /** server count of the whole filtered set — the "Select all N" blast radius */
  totalMatching: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  const groups = useMemo(() => groupByDay(rows), [rows]);
  const openIndex = openId === null ? -1 : rows.findIndex((r) => r.id === openId);
  const openRow = openIndex >= 0 ? rows[openIndex]! : null;

  // A filter / view / page change is a soft <Link> nav that keeps THIS client
  // component mounted while its props update — so a confirmed selection would
  // silently re-bind to the NEW result set (bulkApplyByFilter over new params,
  // or stale ids now outside the view). Reset selection whenever the params
  // change, so a bulk action can only ever touch the set the user actually saw.
  const paramsKey = JSON.stringify(selectionParams);
  useEffect(() => {
    setSelectionMode(false);
    setSelected(new Set());
    setAllMatching(false);
  }, [paramsKey]);

  // After an inline recategorize that removes the row from a filtered view, the
  // focused chip trigger unmounts and focus falls to <body>. Hand focus to the
  // neighbor row's chip — but only if focus was actually lost, so the unfiltered
  // "all" view (where the row survives and keeps focus) is untouched.
  const focusNeighborRef = useRef<string | null>(null);
  useEffect(() => {
    const id = focusNeighborRef.current;
    if (id === null) return;
    focusNeighborRef.current = null;
    if (document.activeElement !== document.body) return;
    document
      .querySelector<HTMLElement>(`[data-row-chip="${CSS.escape(id)}"] button`)
      ?.focus();
  }, [rows]);

  function flip(delta: -1 | 1): void {
    if (openIndex < 0) return;
    const next = rows[openIndex + delta];
    if (next) setOpenId(next.id);
  }

  function exitSelection(): void {
    setSelectionMode(false);
    setSelected(new Set());
    setAllMatching(false);
  }

  function isSelected(id: string): boolean {
    return allMatching || selected.has(id);
  }

  function toggleRow(id: string): void {
    if (allMatching) return; // whole set selected — Clear to reset, then re-pick
    setSelectionMode(true);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function rowClick(row: LedgerRow): void {
    if (selectionMode) toggleRow(row.id);
    else setOpenId(row.id);
  }

  /** Inline recategorize from the row chip — no sheet needed (§3.2). */
  function recategorizeRow(row: LedgerRow, categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    // remember the neighbor to catch focus if this row leaves a filtered view
    const i = rows.findIndex((r) => r.id === row.id);
    focusNeighborRef.current = rows[i + 1]?.id ?? rows[i - 1]?.id ?? null;
    runCategoryCorrection({
      transactionId: row.id,
      categoryId,
      categoryName: option?.name ?? "category",
      onChanged: refresh,
    });
  }

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function applyPatch(patch: TxnPatch, verb: string): void {
    const run = allMatching
      ? bulkApplyByFilterAction({ params: selectionParams, patch })
      : bulkApplyAction({ ids: [...selected], patch });
    void run.then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      const affected = r.data.affected;
      exitSelection();
      refresh();
      if (affected === 0) {
        toast({ title: "No changes to apply" });
        return;
      }
      offerUndoToast(`${verb} · ${affected}`, r.data.undo, refresh);
    });
  }

  // `X` enters selection mode; Esc leaves it. The scope stands down while the
  // sheet is open so the sheet's modal Esc/keys win unambiguously.
  useKeyScope(
    "txn-ledger",
    selectionMode ? { escape: exitSelection } : { x: () => setSelectionMode(true) },
    rows.length > 0 && openId === null,
    { priority: PRIORITIES.list },
  );

  return (
    <div className="space-y-3">
      {!selectionMode ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" icon="check" onClick={() => setSelectionMode(true)}>
            Select
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
        {groups.map((group) => (
          <section key={group.day}>
            <div className="flex items-baseline justify-between border-b border-line bg-surface-sunken/60 px-4 py-1.5">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">{group.label}</h2>
              <Money cents={group.netCents} flow className="figures text-[11px]" />
            </div>
            {group.rows.map((r) => {
              const sel = isSelected(r.id);
              const expanded = expandedId === r.id;
              return (
                <div key={r.id} className="border-b border-line last:border-b-0">
                <div
                  className={`group/row flex items-center transition-colors duration-(--duration-fast) ${
                    sel ? "bg-accent-soft" : "hover:bg-surface-sunken"
                  }`}
                >
                  <label className={`flex cursor-pointer items-center self-stretch py-2.5 pr-1 pl-4 ${selectionMode || sel ? "" : REVEAL}`}>
                    <input
                      type="checkbox"
                      checked={sel}
                      disabled={allMatching}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Select ${r.normalizedDescription}`}
                      className="size-3.5 accent-accent"
                    />
                  </label>
                  {/* inline chip picker — recategorize without opening the sheet
                      (§3.2). A plain chip in selection mode, where the row's job
                      is selecting, not editing. */}
                  <div data-row-chip={r.id} className="shrink-0 py-2.5">
                    {(r.splitCount ?? 0) > 0 ? (
                      // a split row has many categories — the single-category
                      // control would be misleading; edit its parts in the sheet
                      <button
                        type="button"
                        onClick={() => rowClick(r)}
                        className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong"
                      >
                        <Icon name="tag" className="size-3" /> Split · {r.splitCount}
                      </button>
                    ) : selectionMode ? (
                      <CategoryChip label={r.categoryName ?? "Uncategorized"} hue={r.hue} icon={r.icon} />
                    ) : (
                      <CategoryPicker
                        options={categories}
                        currentId={r.categoryId}
                        suggestedIds={r.suggestedCategoryIds}
                        onPick={(cid) => recategorizeRow(r, cid)}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => rowClick(r)}
                    aria-haspopup={selectionMode ? undefined : "dialog"}
                    className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 pl-3 text-left"
                  >
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
                  {/* inline expander (S4) — fields edit in place, no sheet */}
                  {!selectionMode ? (
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} details for ${r.normalizedDescription}`}
                      className={`self-stretch pr-3 pl-1 text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink ${expanded ? "" : REVEAL}`}
                    >
                      <Icon
                        name="chevron-down"
                        className={`size-3.5 transition-transform duration-(--duration-fast) ${expanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  ) : null}
                </div>
                {expanded && !selectionMode ? <LedgerRowExpander row={r} onChanged={refresh} /> : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {selectionMode ? (
        <BulkActionBar
          count={selected.size}
          allMatching={allMatching}
          totalMatching={totalMatching}
          categories={categories}
          onSelectAllMatching={() => setAllMatching(true)}
          onClear={exitSelection}
          onCategory={(categoryId) => applyPatch({ categoryId }, "Recategorized")}
          onReviewed={() => applyPatch({ markReviewed: true }, "Marked reviewed")}
          onExclude={() => applyPatch({ exclude: true }, "Excluded")}
          onTransfer={() => applyPatch({ markTransfer: true }, "Marked as transfer")}
        />
      ) : null}

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
