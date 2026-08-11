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
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { toast } from "@/components/ui/Toast";
import type { CategoryTreeNode } from "@/services/category-edit";
import { CREATABLE_CATEGORY_KINDS, type CreatableCategoryKind } from "@/services/category-edit";

const KIND_LABEL: Record<string, string> = {
  expense: "Spending",
  income: "Income",
  rewards: "Rewards",
  investment: "Investments",
  transfer: "Transfers",
  system: "System",
};

/** Order the tree reads in: what you spend first, then what comes in, then plumbing. */
const KIND_ORDER = ["expense", "income", "rewards", "investment", "transfer", "system"];

interface CategoryManagerProps {
  tree: CategoryTreeNode[];
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
export function CategoryManager({ tree }: CategoryManagerProps) {
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

      {groups.map((group) => (
        <section key={group.kind} aria-label={`${KIND_LABEL[group.kind]} categories`}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            {KIND_LABEL[group.kind]}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
            {group.roots.map((root) => (
              <li key={root.id}>
                <Row node={root} depth={0} busy={busy} onArchive={setArchived} />
                {root.children
                  .filter((c) => showArchived || !c.isArchived)
                  .map((child) => (
                    <Row key={child.id} node={child} depth={1} busy={busy} onArchive={setArchived} />
                  ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface RowProps {
  node: CategoryTreeNode;
  depth: 0 | 1;
  busy: boolean;
  onArchive: (node: CategoryTreeNode, archived: boolean) => void;
}

function Row({ node, depth, busy, onArchive }: RowProps) {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-colors duration-(--duration-fast) hover:bg-surface-leaf ${
        depth === 1 ? "border-t border-line/60 pl-10" : ""
      } ${node.isArchived ? "opacity-55" : ""}`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <Link
          href={`/categories/${node.id}`}
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
      <div className="flex shrink-0 items-center gap-3">
        <span className="figures text-xs text-ink-faint">
          {node.txnCount > 0 ? `${node.txnCount.toLocaleString()} txn` : "—"}
        </span>
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
      </div>
    </div>
  );
}
