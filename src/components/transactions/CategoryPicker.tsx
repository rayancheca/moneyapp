"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Popover, usePopover } from "@/components/ui/Popover";
import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { Icon } from "@/components/shell/Icon";
import { PRIORITIES } from "@/lib/keyscope";

/** Flat, pre-ordered category option — parents then their children (indented). */
export interface CategoryPickerOption {
  id: string;
  /** display label, e.g. "Food > Groceries" */
  label: string;
  /** leaf name for the search + chip */
  name: string;
  hue: string | null;
  icon: string | null;
  depth: number;
}

interface CategoryPickerProps {
  options: readonly CategoryPickerOption[];
  currentId: string | null;
  /** low-confidence Claude guesses to float to the top (§3.2) */
  suggestedIds?: readonly string[];
  onPick: (categoryId: string) => void;
  /** the trigger content — defaults to the current category chip */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Searchable category picker on the Popover primitive (ux-overhaul-plan §3.2):
 * a tree with search, low-confidence Claude guesses surfaced first. Not a modal
 * — a single-field edit never blocks. Arrow keys move, Enter picks, Esc closes.
 */
export function CategoryPicker({
  options,
  currentId,
  suggestedIds = [],
  onPick,
  children,
  className,
}: CategoryPickerProps) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeId = useId();

  // While open, the picker owns Escape at a tier ABOVE the sheet and the ledger
  // list scope, and swallows it (modal) — so Esc closes THIS popover, never the
  // sheet it sits in or the bulk selection it acts on (native popover=auto also
  // light-dismisses; both resolve to the same close).
  useKeyScope(`category-picker-${scopeId}`, { escape: close }, open, {
    priority: PRIORITIES.toast,
    modal: true,
  });

  const current = options.find((o) => o.id === currentId) ?? null;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q === "" ? options : options.filter((o) => o.label.toLowerCase().includes(q));
    if (q !== "" || suggestedIds.length === 0) return matches;
    // no query: float the Claude suggestions to the top, in order
    const suggested = suggestedIds
      .map((id) => matches.find((o) => o.id === id))
      .filter((o): o is CategoryPickerOption => o !== undefined);
    const rest = matches.filter((o) => !suggestedIds.includes(o.id));
    return [...suggested, ...rest];
  }, [options, query, suggestedIds]);

  // clamp the cursor into range (filtering can shrink results below `active`)
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const activeOption = activeIndex === -1 ? undefined : results[activeIndex];
  const listboxId = `category-listbox-${scopeId}`;
  const optionDomId = (o: CategoryPickerOption): string => `category-opt-${scopeId}-${o.id}`;

  function pick(id: string): void {
    onPick(id);
    close();
    setQuery("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeOption) pick(activeOption.id);
    }
  }

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="listbox"
        aria-expanded={open}
        // When the caller supplies visible children (e.g. "Recategorize",
        // "Categorize all"), THAT text is the accessible name — overriding it
        // with aria-label would drop the visible label (WCAG 2.5.3 Label in
        // Name). Only the default chip trigger, whose visible label is the
        // category name, gets the descriptive "Category: X. Change" label.
        aria-label={children ? undefined : `Category: ${current?.name ?? "Uncategorized"}. Change`}
        className={`inline-flex max-w-full items-center rounded-full outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${className ?? ""}`}
      >
        {children ?? <CategoryChip label={current?.name ?? "Uncategorized"} hue={current?.hue ?? null} icon={current?.icon ?? null} />}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        offset={6}
        className="w-64 rounded-(--radius-overlay) border border-line bg-surface-overlay p-1.5 shadow-(--shadow-overlay)"
      >
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-line px-2 py-1">
          <Icon name="search" className="size-3.5 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionDomId(activeOption) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search categories…"
            aria-label="Search categories"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
        </div>
        <ul id={listboxId} role="listbox" aria-label="Categories" className="max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-ink-faint">No matching category</li>
          ) : (
            results.map((o, i) => {
              const isSuggested = query.trim() === "" && suggestedIds.includes(o.id);
              // the <li> IS the option (aria-selected tracks the arrow cursor, not
              // the committed category) — no nested button, matching CommandPalette
              return (
                <li
                  key={o.id}
                  id={optionDomId(o)}
                  role="option"
                  aria-selected={i === activeIndex}
                  onClick={() => pick(o.id)}
                  onMouseMove={() => setActive(i)}
                  style={{ paddingLeft: `${0.5 + o.depth * 0.75}rem` }}
                  className={`flex cursor-default items-center gap-1.5 rounded-md py-1 pr-2 text-sm transition-colors duration-(--duration-fast) ${
                    i === activeIndex ? "bg-accent-soft text-ink" : "text-ink-muted"
                  }`}
                >
                  <CategoryChip label={o.name} hue={o.hue} icon={o.icon} compact />
                  <span className="truncate">{o.name}</span>
                  {o.id === currentId ? <Icon name="check" className="ml-auto size-3.5 text-accent" /> : null}
                  {isSuggested ? (
                    <span className="ml-auto shrink-0 text-[10px] font-medium text-accent">Claude</span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </Popover>
    </>
  );
}
