"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "@/components/shell/Icon";
import { PLATE, ROW_HOVER, RULE_STRONG_BOTTOM } from "./letterpress";

export interface Column<Row> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  sortable?: boolean;
  widthClass?: string;
  render: (row: Row) => ReactNode;
}

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

interface DataTableBaseProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** rendered sr-only — every table states what it lists */
  caption: string;
  /** controlled sorting: the page owns sort state (usually in the URL) */
  sort?: SortState;
  onSortChange?: (next: SortState) => void;
  selectedIds?: ReadonlySet<string>;
  onSelectedIdsChange?: (next: ReadonlySet<string>) => void;
  /** row activation — ignored when rowHref is provided */
  onRowClick?: (row: Row) => void;
  /**
   * row navigation — the first column's content becomes a stretched link
   * covering the whole row. Non-first cell content is layered above that
   * overlay (relative z-10), so interactive elements inside cells (chips,
   * menus, links) stay clickable; clicks on cell padding activate the row.
   */
  rowHref?: (row: Row) => string | undefined;
  emptyState?: ReactNode;
}

/**
 * Selection requires a per-row accessible name — fifty checkboxes all named
 * "Select row" are indistinguishable to a screen reader, so `rowLabel` is
 * mandatory whenever `selectable` is set.
 */
type DataTableProps<Row> =
  | (DataTableBaseProps<Row> & {
      selectable: true;
      /** names each row's checkbox: "Select {rowLabel(row)}" */
      rowLabel: (row: Row) => string;
    })
  | (DataTableBaseProps<Row> & { selectable?: false; rowLabel?: (row: Row) => string });

const HEADER_CELL =
  "px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint";
const BODY_CELL = "px-4 py-2.5 align-top";
// Row-control visibility contract (§2.5): visible on row hover, on
// focus-within, while any selection exists, or always on coarse pointers.
const CONTROL_REVEAL =
  "opacity-0 transition-opacity duration-(--duration-fast) group-hover/row:opacity-100 " +
  "group-focus-within/row:opacity-100 group-data-[selecting]/table:opacity-100 " +
  "pointer-coarse:opacity-100";

function ariaSort(active: boolean, dir: "asc" | "desc"): "ascending" | "descending" | undefined {
  if (!active) return undefined;
  return dir === "asc" ? "ascending" : "descending";
}

interface SelectAllCheckboxProps {
  allSelected: boolean;
  someSelected: boolean;
  onToggle: () => void;
}

function SelectAllCheckbox({ allSelected, someSelected, onToggle }: SelectAllCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all rows"
      checked={allSelected}
      onChange={onToggle}
      className="size-3.5 accent-accent"
    />
  );
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSortChange,
  selectable = false,
  rowLabel,
  selectedIds,
  onSelectedIdsChange,
  onRowClick,
  rowHref,
  emptyState,
}: DataTableProps<Row>) {
  const selected = selectedIds ?? EMPTY_SELECTION;
  const visibleIds = rows.map(rowKey);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id));

  function cycleSort(key: string) {
    if (!onSortChange) return;
    const dir = sort?.key === key && sort.dir === "asc" ? "desc" : "asc";
    onSortChange({ key, dir });
  }

  function toggleRow(id: string) {
    if (!onSelectedIdsChange) return;
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectedIdsChange(next);
  }

  function toggleAllVisible() {
    if (!onSelectedIdsChange) return;
    const next = new Set(selected);
    for (const id of visibleIds) {
      if (allSelected) {
        next.delete(id);
      } else {
        next.add(id);
      }
    }
    onSelectedIdsChange(next);
  }

  function primaryCellContent(row: Row, content: ReactNode): ReactNode {
    const href = rowHref?.(row);
    if (href !== undefined) {
      return (
        <Link href={href} className="after:absolute after:inset-0">
          {content}
        </Link>
      );
    }
    if (onRowClick) {
      return (
        <button
          type="button"
          onClick={() => onRowClick(row)}
          className="text-left after:absolute after:inset-0"
        >
          {content}
        </button>
      );
    }
    return content;
  }

  const columnCount = columns.length + (selectable ? 1 : 0);

  return (
    <div
      data-selecting={selected.size > 0 ? "" : undefined}
      className={`group/table overflow-x-auto ${PLATE}`}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        {/* not sticky: this overflow-x wrapper never scrolls vertically — vertical
            stickiness returns with a real scroll container in Stage 1 */}
        <thead className="bg-surface-raised">
          {/* the ledger's head rule: 2px of --ink-display, the same weight a
              printed table uses to separate its column heads from its body.
              This one line does more to make a table read as a ledger than any
              amount of cell styling. */}
          <tr className={RULE_STRONG_BOTTOM}>
            {selectable ? (
              <th scope="col" className="w-10 py-2.5 pr-1 pl-4">
                <SelectAllCheckbox
                  allSelected={allSelected}
                  someSelected={someSelected}
                  onToggle={toggleAllVisible}
                />
              </th>
            ) : null}
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const alignClass = col.align === "right" ? "text-right" : "";
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort(active, sort?.dir ?? "asc")}
                  className={`${HEADER_CELL} ${alignClass} ${col.widthClass ?? ""}`.trim()}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => cycleSort(col.key)}
                      className="inline-flex items-center gap-1 uppercase tracking-[0.08em] transition-colors duration-(--duration-fast) hover:text-ink"
                    >
                      {col.header}
                      {active ? (
                        <Icon
                          name="chevron-down"
                          className={`size-3 ${sort?.dir === "asc" ? "rotate-180" : ""}`.trim()}
                        />
                      ) : null}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyState !== undefined ? (
            <tr>
              <td colSpan={columnCount} className="px-4 py-6 text-center text-sm text-ink-muted">
                {emptyState}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = rowKey(row);
              // matches primaryCellContent: a stretched overlay exists when this
              // row navigates (href) or activates (onRowClick)
              const hasRowOverlay = rowHref?.(row) !== undefined || onRowClick !== undefined;
              return (
                <tr
                  key={id}
                  className={`group/row relative border-b border-line last:border-b-0 ${ROW_HOVER}`}
                >
                  {selectable ? (
                    <td className="w-10 py-2.5 pr-1 pl-4 align-top">
                      {/* relative+z keeps the checkbox clickable above stretched row links */}
                      <span className={`relative z-10 inline-flex ${CONTROL_REVEAL}`}>
                        {/* the props union makes rowLabel mandatory when selectable —
                            the rowKey fallback only guards untyped callers */}
                        <input
                          type="checkbox"
                          aria-label={`Select ${rowLabel === undefined ? id : rowLabel(row)}`}
                          checked={selected.has(id)}
                          onChange={() => toggleRow(id)}
                          className="size-3.5 accent-accent"
                        />
                      </span>
                    </td>
                  ) : null}
                  {columns.map((col, index) => {
                    const alignClass = col.align === "right" ? "text-right whitespace-nowrap" : "";
                    const content = col.render(row);
                    return (
                      <td key={col.key} className={`${BODY_CELL} ${alignClass}`.trim()}>
                        {index === 0 ? (
                          primaryCellContent(row, content)
                        ) : hasRowOverlay ? (
                          // above the stretched-link overlay (after:inset-0, z-auto)
                          // so interactive cell content stays clickable; clicks on
                          // the cell's own padding still activate the row
                          <div className="relative z-10">{content}</div>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
