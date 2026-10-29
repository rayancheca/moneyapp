"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { moveCategoryAction } from "@/app/categories/actions";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { settleAction } from "@/hooks/useAction";

export interface MoveDestination {
  id: string | null;
  label: string;
}

/**
 * A destination's press: the move, and the Undo card it raises — made here rather than inside the menu so the card
 * is tested where it is raised, as the transaction sheet's presses are (LinkPanels.test.ts). Both calls are settled:
 * a move that never reached the server says so, and the Undo RETURNS what the move back did, so a refused or failed
 * one keeps its card — and the parent it puts back — to be pressed again (`offerUndoToast` is the model).
 */
export async function pressMoveCategory(
  categoryId: string,
  currentParentId: string | null,
  to: MoveDestination,
  refresh: () => void,
): Promise<void> {
  const moved = await settleAction(() => moveCategoryAction({ categoryId, newParentId: to.id }));
  if (!moved.ok) {
    toast({ title: moved.error, tone: "negative" });
    return;
  }
  toast({
    title: `Moved to ${to.label}`,
    action: {
      label: "Undo",
      onAction: async () => {
        const back = await settleAction(
          () => moveCategoryAction({ categoryId, newParentId: currentParentId }),
          "Couldn’t move it back — try again",
        );
        refresh(); // re-render to server truth either way
        return back;
      },
    },
  });
  refresh();
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

  const items: MenuItem[] = destinations.map((d) => ({
    label: d.label,
    onSelect: () => void pressMoveCategory(categoryId, currentParentId, d, refresh),
  }));

  return <Menu label="Move category" items={items} />;
}
