import type { categories } from "@/db/schema/categories";
import type { CategoryPickerOption } from "./CategoryPicker";

/**
 * Flat, pre-ordered CategoryPicker options — each root then its children
 * (indented), each carrying the category identity (hue/icon; children inherit
 * the root's when their own is unset, §2.3). Shared by every surface that opens
 * the picker (the ledger sheet, the review inbox, cash-wallet manual entry).
 */

type CategoryRow = typeof categories.$inferSelect;

export function byHierarchy(a: CategoryRow, b: CategoryRow): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

export function buildCategoryPickerOptions(
  allCategories: readonly CategoryRow[],
): CategoryPickerOption[] {
  const live = allCategories.filter((c) => !c.isArchived);
  const roots = live.filter((c) => c.parentId === null).sort(byHierarchy);
  return roots.flatMap((root) => [
    { id: root.id, name: root.name, label: root.name, hue: root.color, icon: root.icon, depth: 0 },
    ...live
      .filter((c) => c.parentId === root.id)
      .sort(byHierarchy)
      .map((c) => ({
        id: c.id,
        name: c.name,
        label: `${root.name} > ${c.name}`,
        hue: c.color ?? root.color,
        icon: c.icon ?? root.icon,
        depth: 1,
      })),
  ]);
}
