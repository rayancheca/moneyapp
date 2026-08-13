import type { Metadata } from "next";
import { getDb } from "@/db/client";
import {
  allMoveDestinations,
  categoryTouchCounts,
  listCategoryTree,
  scheduledCategoryIds,
} from "@/services/category-edit";
import { categoryNoteRows, categorySectionNotes } from "@/lib/section-notes";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionNotes } from "@/components/insights/SectionNotes";
import { CategoryManager } from "@/components/categories/CategoryManager";

export const metadata: Metadata = { title: "Categories" };
export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const db = getDb();
  const tree = listCategoryTree(db);
  // ONE table read for all ~77 rows. Calling moveDestinations per row instead
  // re-scans the categories table each time and measurably slowed the whole e2e
  // suite, since this route renders eight times across it.
  const destinations = allMoveDestinations(db);
  // Which categories are holding nothing — derived from the tree already read
  // above (no extra scan) plus one indexed read for the scheduled set. The
  // flattening itself lives in categoryNoteRows, where it can be unit-tested.
  // Counts come from categoryTouchCounts, NOT the tree's own txnCount — see its
  // docstring: excluded rows and split parts both reach a category without
  // showing up in an active-parent-row count.
  const touches = categoryTouchCounts(db);
  const noteRows = categoryNoteRows(tree, scheduledCategoryIds(db), (id) => touches.get(id) ?? 0);
  return (
    <>
      <PageHeader
        title="Categories"
        description="Create, archive and restore the categories every other screen groups by. Archiving never deletes — past transactions keep resolving through the same id."
      />
      {/* Bare, like the /budgets and /investments mounts — SectionNotes renders
          null when there is nothing measured to say, so a spacing wrapper here
          would leave an empty margin-carrying div on every quiet page.
          No heading of its own either: zz-zz-zz-categories-arrange asserts one
          info tip per level-3 heading page-wide, so a note carrying an h3 would
          break an unrelated count. SectionNotes names itself with aria-label. */}
      <SectionNotes notes={categorySectionNotes({ rows: noteRows })} label="What this page noticed" />
      <CategoryManager tree={tree} destinations={destinations} />
    </>
  );
}
