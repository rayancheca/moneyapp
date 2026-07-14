"use client";

import { useState, type ReactNode } from "react";
import { saveDashboardLayoutAction } from "@/app/settings/actions";
import { Icon } from "@/components/shell/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { moveItem, normalizeOrder } from "@/lib/reorder";

export interface ArrangeableSection {
  id: string;
  label: string;
  node: ReactNode;
}

/**
 * Dashboard sections in a user-arranged order (S7 "movable"). The server
 * renders every section and the saved order; "Arrange" mode adds a grip +
 * keyboard Move up/down per section (the same HTML5-drag + button pattern as
 * ManagedAccounts — every drag has a keyboard equivalent). Each move persists
 * immediately and optimistically; a failed save reverts with a toast.
 */
export function ArrangeableSections({ sections }: { sections: readonly ArrangeableSection[] }) {
  const [order, setOrder] = useState<string[]>(sections.map((s) => s.id));
  const [arranging, setArranging] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // the entrance cascade must play ONCE: React reorders keyed children via
  // insertBefore, which RESTARTS a CSS animation on the moved node — with the
  // class left on, every arrange-mode move flashed the moved section invisible
  // (fill-mode both holds the opacity-0 frame through its stagger delay).
  // After the last section's entrance ends the classes come off for good.
  const [entered, setEntered] = useState(false);

  const byId = new Map(sections.map((s) => [s.id, s]));
  // reconcile state with the CURRENT props every render — a section that
  // appears after mount (e.g. recent txns arriving) must render and be movable
  const effectiveOrder = normalizeOrder(
    order,
    sections.map((s) => s.id),
  );
  const ordered = effectiveOrder
    .map((id) => byId.get(id))
    .filter((s): s is ArrangeableSection => s !== undefined);

  function persist(next: string[], previous: string[]): void {
    setOrder(next);
    void saveDashboardLayoutAction(next).then((r) => {
      if (!r.ok) {
        setOrder(previous);
        toast({ title: r.error, tone: "negative" });
      }
    });
  }

  function move(id: string, delta: -1 | 1): void {
    const from = effectiveOrder.indexOf(id);
    if (from < 0) return;
    const to = from + delta;
    // explicit boundary no-op — the buttons stay enabled (aria-disabled) so
    // keyboard focus never drops when a section reaches an edge
    if (to < 0 || to >= effectiveOrder.length) return;
    persist(moveItem(effectiveOrder, from, to), order);
  }

  function drop(e: React.DragEvent, targetId: string): void {
    // without this, Firefox treats the text payload as a navigation target
    e.preventDefault();
    if (dragId === null || dragId === targetId) return;
    const from = effectiveOrder.indexOf(dragId);
    const to = effectiveOrder.indexOf(targetId);
    if (from < 0 || to < 0) return;
    persist(moveItem(effectiveOrder, from, to), order);
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          icon={arranging ? "check" : "arrow-up-down"}
          onClick={() => setArranging((a) => !a)}
        >
          {arranging ? "Done arranging" : "Arrange"}
        </Button>
      </div>
      {ordered.map((section, index) => (
        <div
          key={section.id}
          onDragOver={arranging ? (e) => e.preventDefault() : undefined}
          onDrop={arranging ? (e) => drop(e, section.id) : undefined}
          // S10: entrance cascade — sections rise in reading order on mount,
          // then the animation is removed (see `entered`); child animationend
          // events bubble, so only the wrapper's own animation flips the state
          style={entered ? undefined : { animationDelay: `${index * 60}ms` }}
          className={`${entered ? "" : "animate-fade-rise [animation-fill-mode:both] "}${
            arranging ? "rounded-(--radius-card) outline-dashed outline-1 outline-line" : ""
          }`}
          onAnimationEnd={
            !entered && index === ordered.length - 1
              ? (e) => {
                  if (e.target === e.currentTarget) setEntered(true);
                }
              : undefined
          }
        >
          {arranging ? (
            <div
              draggable
              onDragStart={(e) => {
                // Firefox refuses to start an HTML5 drag without a payload
                e.dataTransfer.setData("text/plain", section.id);
                e.dataTransfer.effectAllowed = "move";
                setDragId(section.id);
              }}
              onDragEnd={() => setDragId(null)}
              className="mb-2 flex cursor-grab items-center gap-2 px-1 active:cursor-grabbing"
            >
              <Icon name="grip-vertical" className="size-3.5 text-ink-faint" />
              <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
                {section.label}
              </span>
              {/* aria-disabled (not disabled) at the edges — focus must survive
                  a section reaching the top/bottom; move() no-ops there */}
              <button
                type="button"
                aria-label={`Move ${section.label} up`}
                aria-disabled={effectiveOrder.indexOf(section.id) === 0 || undefined}
                onClick={() => move(section.id, -1)}
                className="rounded-md p-1.5 text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-40"
              >
                <Icon name="chevron-up" className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${section.label} down`}
                aria-disabled={effectiveOrder.indexOf(section.id) === effectiveOrder.length - 1 || undefined}
                onClick={() => move(section.id, 1)}
                className="rounded-md p-1.5 text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-40"
              >
                <Icon name="chevron-down" className="size-3.5" />
              </button>
            </div>
          ) : null}
          {section.node}
        </div>
      ))}
    </div>
  );
}
