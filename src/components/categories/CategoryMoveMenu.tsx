"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { moveCategoryAction } from "@/app/categories/actions";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";

export interface MoveDestination {
  id: string | null;
  label: string;
}

/**
 * Re-parent a category from its own page (S7 "movable"): move a subcategory
 * to another same-kind root or make it top-level. The server passes only the
 * VALID destinations; the guarded service re-checks everything. Undo moves it
 * back — the whole operation is a parentId pointer, history untouched.
 */
export function CategoryMoveMenu({
  categoryId,
  currentParentId,
  destinations,
}: {
  categoryId: string;
  currentParentId: string | null;
  destinations: readonly MoveDestination[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  if (destinations.length === 0) return null;

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function move(newParentId: string | null, label: string): void {
    void moveCategoryAction({ categoryId, newParentId }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({
        title: `Moved to ${label}`,
        action: {
          label: "Undo",
          onAction: () =>
            void moveCategoryAction({ categoryId, newParentId: currentParentId }).then((r) => {
              if (!r.ok) toast({ title: `Undo failed: ${r.error}`, tone: "negative" });
              refresh(); // re-render to server truth either way
            }),
        },
      });
      refresh();
    });
  }

  const items: MenuItem[] = destinations.map((d) => ({
    label: d.label,
    onSelect: () => move(d.id, d.label),
  }));

  return <Menu label="Move category" items={items} />;
}
