"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  archiveCategoryAction,
  createCategoryAction,
  unarchiveCategoryAction,
} from "@/app/categories/actions";
import { Icon } from "@/components/shell/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { InfoTip } from "@/components/ui/InfoTip";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { CATEGORY_KIND_JARGON } from "@/lib/jargon";
import { CategoryRow } from "./CategoryRow";
import { toast } from "@/components/ui/Toast";
import type { CategoryTreeNode, MoveDestination } from "@/services/category-edit";
import { CREATABLE_CATEGORY_KINDS, KIND_ORDER, type CreatableCategoryKind } from "@/lib/category-kinds";

const KIND_LABEL: Record<string, string> = {
  expense: "Spending",
  income: "Income",
  rewards: "Rewards",
  investment: "Investments",
  transfer: "Transfers",
  system: "System",
};

// KIND_ORDER is imported, not redeclared: `reorderCategories` renumbers roots in
// exactly this sequence, so a local copy that drifted would persist an order the
// screen does not show.

interface CategoryManagerProps {
  tree: CategoryTreeNode[];
  /**
   * Valid re-parent targets per category id, computed once on the server.
   * `moveDestinations` does a full `categories` scan per call, so calling it
   * per-row from the client would be 77 table scans for one page.
   */
  destinations: Record<string, MoveDestination[]>;
}

/**
 * The category manager. Until this shipped, the 73 seeded categories were the
 * only ones that could ever exist — nothing outside `db/seed.ts` inserted a
 * row, so a new kind of spending (a car lease, say) had literally nowhere to
 * go. Create, archive and restore all live here; rename and re-parent stay on
 * the category's own page, where its spending is in view.
 *
 * Archiving, never deleting: a category id is referenced by transactions,
 * budgets and rules, so the row stays and the history keeps resolving. Every
 * row shows how many transactions point at it, so that is an informed choice.
 */
export function CategoryManager({ tree, destinations }: CategoryManagerProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [kind, setKind] = useState<CreatableCategoryKind>("expense");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // only live, editable roots can take a new child — archived ones and the
  // transfer/system roots would be refused by the service anyway
  const parentOptions = useMemo(
    () => tree.filter((r) => !r.isArchived && r.kind !== "transfer" && r.kind !== "system"),
    [tree],
  );

  const isTopLevel = parentId === "";

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    setBusy(true);
    void createCategoryAction({
      name,
      parentId: isTopLevel ? null : parentId,
      ...(isTopLevel ? { kind } : {}),
    })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        toast({ title: `Created ${r.data.name}`, tone: "positive" });
        setName("");
        router.refresh();
      })
      .finally(() => setBusy(false));
  }

  function setArchived(node: CategoryTreeNode, archived: boolean): void {
    if (busy) return;
    setBusy(true);
    const run = archived ? archiveCategoryAction : unarchiveCategoryAction;
    void run({ categoryId: node.id })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        toast({
          title: archived ? `Archived ${node.name}` : `Restored ${node.name}`,
          tone: "positive",
        });
        router.refresh();
      })
      .finally(() => setBusy(false));
  }

  const groups = KIND_ORDER.map((k) => ({
    kind: k,
    roots: tree.filter((r) => r.kind === k && (showArchived || !r.isArchived)),
  })).filter((g) => g.roots.length > 0);

  const archivedCount = tree.reduce(
    (n, r) => n + (r.isArchived ? 1 : 0) + r.children.filter((c) => c.isArchived).length,
    0,
  );

  return (
    <div className="space-y-6">
      <SurfaceCard>
        <h2 className="mb-1 text-sm font-medium">New category</h2>
        <p className="mb-4 text-xs text-ink-muted">
          A subcategory inherits its parent&apos;s kind — the kind drives the money math, so a child
          can never disagree with its parent. Categories nest one level deep.
        </p>
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Car Payment"
              maxLength={60}
              required
            />
          </Field>
          <Field label="Lives under">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {parentOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          {isTopLevel ? (
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as CreatableCategoryKind)}>
                {CREATABLE_CATEGORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="text-xs text-ink-faint md:pb-2.5">
              Inherits{" "}
              <span className="font-medium text-ink-muted">
                {KIND_LABEL[parentOptions.find((r) => r.id === parentId)?.kind ?? "expense"]}
              </span>
            </div>
          )}
          <div className="md:col-span-3">
            <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
              <Icon name="plus" className="size-3.5" />
              Create category
            </Button>
          </div>
        </form>
      </SurfaceCard>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          All categories
        </h2>
        {archivedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"} {archivedCount} archived
          </Button>
        )}
      </div>

      {groups.map((group) => {
        // the reorder basis is what the SCREEN shows: with archived rows hidden
        // they are not in this list, and the service's normalizeOrder sinks them
        // to the end of the group rather than dropping them
        const rootIds = group.roots.map((r) => r.id);
        return (
          <section key={group.kind} aria-label={`${KIND_LABEL[group.kind]} categories`}>
            {/* One tip per GROUP, not per row: /categories renders ~180
                controls already, and an info button on each of 77 rows would
                cost more in keyboard traversal than the jargon costs in
                confusion. The kind is also the only thing on this screen that
                silently changes the money math. */}
            <h3 className="mb-2 flex items-center text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              {KIND_LABEL[group.kind]}
              {CATEGORY_KIND_JARGON[group.kind] && (
                <InfoTip term={KIND_LABEL[group.kind]!} placement="bottom">
                  {CATEGORY_KIND_JARGON[group.kind]}
                </InfoTip>
              )}
            </h3>
            {/* one <li> per row, with children in a NESTED <ul>. A single <li>
                wrapping a root and all its children would open the root's detail
                panel above its own children and break reading order. */}
            <ul className="divide-y divide-line overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
              {group.roots.map((root) => {
                const shownChildren = root.children.filter((c) => showArchived || !c.isArchived);
                const childIds = shownChildren.map((c) => c.id);
                return (
                  <li key={root.id}>
                    <CategoryRow
                      node={root}
                      depth={0}
                      busy={busy}
                      onArchive={setArchived}
                      siblingIds={rootIds}
                      parentId={null}
                      destinations={destinations[root.id] ?? []}
                    />
                    {shownChildren.length > 0 && (
                      <ul>
                        {shownChildren.map((child) => (
                          <li key={child.id}>
                            <CategoryRow
                              node={child}
                              depth={1}
                              busy={busy}
                              onArchive={setArchived}
                              siblingIds={childIds}
                              parentId={root.id}
                              destinations={destinations[child.id] ?? []}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
