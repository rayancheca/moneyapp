/**
 * How every surface punctuates a category path.
 *
 * Named rather than inlined because a path is only unambiguous while a category name cannot contain it —
 * `FORBIDDEN_NAME_CHARS` in `services/category-edit` is what makes that impossible, and `section-notes.test.ts`
 * asserts the two agree, so changing the separator here fails the build rather than silently reopening the ambiguity.
 */
export const PATH_SEPARATOR = " > ";

/**
 * ⛔ The ONE printer of a category path: "Parent > Child" for a subcategory, a top-level bare. The schema nests one
 * level, so a path is never longer than two names.
 *
 * 🔴 The review of §6A 54 (2026-10-08) found the merge confirmation printing its own copy (`categoryPathOf`); sixteen
 * inline copies in twelve modules printed it — among them /budgets, the picker, the palette, the review inbox, the
 * rule sentences, the import-hint guards, the bank-bucket map and the Claude categorizer's taxonomy. Each caller keeps
 * its own lookup and its own fallback for an unknown id ("a category", "Uncategorized", a throw); only the printing is
 * shared. `category-path.test.ts` fails on a new inline copy; `category-path-surfaces.test.ts` holds every surface.
 *
 * `parentName` is null or undefined for a top-level category — undefined so a caller can pass a lookup's
 * `byId.get(parentId)?.name` straight in.
 */
export function formatCategoryPath(parentName: string | null | undefined, name: string): string {
  return parentName === null || parentName === undefined ? name : `${parentName}${PATH_SEPARATOR}${name}`;
}
