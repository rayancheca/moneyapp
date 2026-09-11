"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  renameCategoryAction,
  reorderCategoriesAction,
} from "@/app/categories/actions";
import { Icon } from "@/components/shell/Icon";
import { Button } from "@/components/ui/Button";
import { Disclosure, DisclosureChevron } from "@/components/ui/Disclosure";
import { InlineEditableText } from "@/components/ui/InlineEditableText";
import { toast } from "@/components/ui/Toast";
import { moveItem } from "@/lib/reorder";
import { categoryCountLabel } from "@/lib/section-notes";
import type { CategoryTreeNode } from "@/services/category-edit";
import { CategoryMoveMenu } from "./CategoryMoveMenu";
import type { MoveDestination } from "@/services/category-edit";

export interface CategoryRowProps {
  node: CategoryTreeNode;
  depth: 0 | 1;
  busy: boolean;
  onArchive: (node: CategoryTreeNode, archived: boolean) => void;
  /** the sibling ids the SCREEN is showing, in display order — the reorder basis */
  siblingIds: readonly string[];
  destinations: MoveDestination[];
  /** null for a root — CategoryMoveMenu needs it to exclude the current parent */
  parentId: string | null;
}

/**
 * One category, expandable in place.
 *
 * Collapsed it stays the dense scan-line it has always been (name, badges, txn
 * count) so a 77-row taxonomy is still readable at a glance. Expanding reveals
 * the things that previously forced a trip to the category's own page — its name
 * is editable here, and it can be re-parented and reordered — because the manager
 * is where you think about the SHAPE of the taxonomy, and bouncing to a detail
 * page to rename one thing broke that train of thought.
 *
 * Reordering is up/down buttons, not drag. HTML5 `dragstart` never fires from a
 * finger, and the owner's primary device is a phone; the two shipped drag
 * surfaces in this app are mouse-only. Buttons work with a finger, a keyboard and
 * a screen reader for free.
 */
export function CategoryRow({
  node,
  depth,
  busy,
  onArchive,
  siblingIds,
  destinations,
  parentId,
}: CategoryRowProps) {
  const router = useRouter();
  const countLabel = categoryCountLabel(node);
  const index = siblingIds.indexOf(node.id);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < siblingIds.length - 1;

  function nudge(delta: -1 | 1): void {
    if (index < 0) return;
    const next = moveItem(siblingIds, index, index + delta);
    void reorderCategoriesAction({ orderedIds: [...next] }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      router.refresh();
    });
  }

  return (
    <Disclosure
      className={depth === 1 ? "border-t border-line/60" : ""}
      panelClassName="border-t border-line/60 bg-surface-sunken/30"
      summary={(d) => (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-colors duration-(--duration-fast) hover:bg-surface-leaf ${
            depth === 1 ? "pl-10" : ""
          } ${node.isArchived ? "opacity-55" : ""}`}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            {/* ⛔ ALL TIME, because the count beside this link is all time.
                `resolvePeriod` reads a bare href as the CURRENT month, so every
                row of this page — "Groceries · 261 transactions" — opened a
                September 2026 page reading "$0.00 · 0 transactions". */}
            <Link
              href={`/categories/${node.id}?period=ALL`}
              className={`truncate hover:text-accent hover:underline ${
                depth === 0 ? "text-sm font-medium" : "text-sm text-ink-muted"
              }`}
            >
              {node.name}
            </Link>
            {node.isArchived && (
              <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
                Archived
              </span>
            )}
            {!node.isEditable && (
              <span
                className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint"
                title="Imports and transfer detection resolve this category by name, so it stays fixed"
              >
                Locked
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* which zero it is, when it is zero — the note above this list
                counts SUBTREES, so a bare em dash on a parent whose children
                hold 259 rows put two meanings of "holds transactions" on one
                screen. See `categoryCountLabel`. */}
            <span className="figures text-xs text-ink-faint" title={countLabel.title ?? undefined}>
              {countLabel.text}
            </span>
            {/* the trigger's accessible name is FROZEN — it must not change with
                `open`, or axe's label-content-name-mismatch (serious) fires on a
                control whose visible text is a bare chevron */}
            <button
              type="button"
              onClick={d.toggle}
              aria-expanded={d["aria-expanded"]}
              aria-controls={d["aria-controls"]}
              aria-label={`Details for ${node.name}`}
              className="rounded-md p-1 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <DisclosureChevron open={d.open} />
            </button>
          </div>
        </div>
      )}
    >
      {/* Nothing inside a closed row is rendered at all. With 77 rows, eagerly
          mounting every panel's inline editor, buttons and move menu costs real DOM
          and hydration work for panels nobody opened — and measurably slowed the
          whole e2e suite. The height transition still animates; only the content
          is deferred. */}
      {(open) =>
        open ? (
      <div className={`space-y-3 px-4 py-3 ${depth === 1 ? "pl-10" : ""}`}>
        {node.isEditable ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-xs text-ink-faint">Name</span>
            <InlineEditableText
              value={node.name}
              label={`Name of ${node.name}`}
              maxLength={60}
              className="text-sm font-medium"
              onSave={async (next) => {
                const r = await renameCategoryAction({ categoryId: node.id, name: next });
                if (r.ok) router.refresh();
                return { ok: r.ok, error: r.ok ? undefined : r.error };
              }}
            />
          </div>
        ) : (
          <p className="text-xs text-ink-muted">
            Imports and transfer detection resolve this category by name, so it cannot be renamed,
            moved or archived. Its spending still groups and drills like any other.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* order within its own group. aria-disabled, not disabled: a control
              that vanishes from the tab order at the edge of a list loses focus
              mid-interaction (the ArrangeableSections/ManagedAccounts rule) */}
          <span className="text-xs text-ink-faint">Order</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${node.name} up`}
            aria-disabled={!canMoveUp || busy}
            onClick={() => canMoveUp && !busy && nudge(-1)}
          >
            <Icon name="chevron-up" className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${node.name} down`}
            aria-disabled={!canMoveDown || busy}
            onClick={() => canMoveDown && !busy && nudge(1)}
          >
            <Icon name="chevron-down" className="size-3.5" />
          </Button>

          {destinations.length > 0 && (
            <CategoryMoveMenu
              categoryId={node.id}
              currentParentId={parentId}
              destinations={destinations}
            />
          )}

          {node.isEditable &&
            (node.isArchived ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onArchive(node, false)}>
                Restore
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onArchive(node, true)}>
                Archive
              </Button>
            ))}

          <Link
            href={`/categories/${node.id}?period=ALL`}
            className="ml-auto text-xs text-accent hover:underline"
          >
            Open {node.name} →
          </Link>
        </div>
      </div>
        ) : null
      }
    </Disclosure>
  );
}
