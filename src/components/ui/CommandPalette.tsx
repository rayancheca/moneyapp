"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shell/Icon";
import { paletteSearch } from "@/lib/palette-search";
import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { PRIORITIES } from "@/lib/keyscope";

export interface CommandPaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  href?: string;
  perform?: () => void;
  keywords?: string[];
}

export interface CommandPaletteGroup {
  label: string;
  items: CommandPaletteItem[];
}

interface CommandPaletteProps {
  groups: CommandPaletteGroup[];
}

type SearchableItem = CommandPaletteItem & { group: string };

const LISTBOX_ID = "command-palette-listbox";

function optionId(item: SearchableItem): string {
  return `palette-option-${item.id}`;
}

/** Stable id for a group's header, referenced by each option's aria-describedby
 * so activedescendant navigation conveys "Pages" / "Accounts" group context —
 * essential once Stage 1 adds same-named options across groups. */
function groupHeaderId(group: string): string {
  return `palette-group-${group.replace(/\s+/g, "-").toLowerCase()}`;
}

/**
 * ⌘K palette on native <dialog> (plan §1.7/§2.5). While closed it registers
 * only the "palette-trigger" scope — non-modal but at the palette tier, so
 * mod+k opens from ANY context, including over a modal sheet. While open it
 * swaps in the modal "palette" scope (escape/mod+k close). Arrows/Enter are
 * local to the search input — only cross-surface precedence lives in the
 * global stack. The dialog stays MOUNTED while closed and closes through
 * dialog.close() so the browser's dialog close steps restore focus to the
 * element that was focused before ⌘K; children render only while open.
 */
export function CommandPalette({ groups }: CommandPaletteProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // see Sheet.tsx: a text-select drag released over the backdrop clicks the
  // dialog; closing requires the pointerdown to have hit the backdrop too
  const pointerDownOnBackdropRef = useRef(false);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const searchable = useMemo<SearchableItem[]>(
    () => groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label }))),
    [groups],
  );
  const results = useMemo(() => paletteSearch(searchable, query), [searchable, query]);

  const clampedIndex = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);
  const activeItem = clampedIndex === -1 ? undefined : results[clampedIndex];

  function open(): void {
    setQuery("");
    setActiveIndex(0);
    setIsOpen(true);
  }

  function close(): void {
    setIsOpen(false);
  }

  useKeyScope("palette-trigger", { "mod+k": open }, !isOpen, {
    priority: PRIORITIES.palette,
  });
  useKeyScope("palette", { "mod+k": close, escape: close }, isOpen, {
    priority: PRIORITIES.palette,
    modal: true,
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeItem === undefined) return;
    document.getElementById(optionId(activeItem))?.scrollIntoView({ block: "nearest" });
  }, [isOpen, activeItem]);

  function activate(item: SearchableItem): void {
    item.perform?.();
    if (item.href !== undefined) router.push(item.href);
    close();
  }

  function moveActive(delta: number): void {
    if (results.length === 0) return;
    setActiveIndex((clampedIndex + delta + results.length) % results.length);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeItem !== undefined) activate(activeItem);
    }
  }

  const rows: ReactElement[] = [];
  if (isOpen) {
    let lastGroup: string | null = null;
    results.forEach((item, index) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        rows.push(
          <li
            key={`header-${item.group}-${index}`}
            id={groupHeaderId(item.group)}
            role="presentation"
            className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-[0.08em] uppercase text-ink-faint"
          >
            {item.group}
          </li>,
        );
      }
      const isActive = index === clampedIndex;
      rows.push(
        <li
          key={item.id}
          id={optionId(item)}
          role="option"
          aria-selected={isActive}
          aria-describedby={groupHeaderId(item.group)}
          className={`flex cursor-default items-center gap-3 px-4 py-2 text-sm ${
            isActive ? "bg-accent-soft text-ink" : "text-ink-muted"
          }`}
          onMouseMove={() => setActiveIndex(index)}
          onClick={() => activate(item)}
        >
          {item.icon !== undefined && (
            <Icon
              name={item.icon}
              className={`size-4 ${isActive ? "text-accent" : "text-ink-faint"}`}
            />
          )}
          <span className="truncate">{item.label}</span>
          {item.hint !== undefined && (
            <span className="ml-auto shrink-0 text-xs text-ink-faint">{item.hint}</span>
          )}
        </li>,
      );
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      className="mx-auto mt-[18svh] mb-auto w-full max-w-lg rounded-(--radius-overlay) border border-line bg-surface-overlay p-0 text-ink shadow-(--shadow-sheet) backdrop:bg-[oklch(0%_0_0/0.3)]"
      onCancel={(event) => {
        // keep React state authoritative over the native Esc close
        event.preventDefault();
        close();
      }}
      onClose={() => {
        // resync if the browser force-closes the dialog without a cancel
        if (isOpen) close();
      }}
      onPointerDown={(event) => {
        pointerDownOnBackdropRef.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && pointerDownOnBackdropRef.current) close();
      }}
    >
      {isOpen ? (
        <>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="search" className="size-4 shrink-0 text-ink-faint" />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={activeItem === undefined ? undefined : optionId(activeItem)}
              aria-label="Search commands"
              placeholder="Search pages, accounts, actions…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <ul
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Results"
            className="max-h-80 overflow-y-auto pb-2"
          >
            {rows.length > 0 ? (
              rows
            ) : (
              <li role="presentation" className="px-4 py-8 text-center text-sm text-ink-faint">
                No results
              </li>
            )}
          </ul>
          {/* Polite count so a screen-reader user hears results narrow as they
              type (and "No results" instead of silence). Replaced, not stacked,
              so rapid typing throttles to the latest count. */}
          <div aria-live="polite" className="sr-only">
            {results.length === 0
              ? "No results"
              : `${results.length} result${results.length === 1 ? "" : "s"}`}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
