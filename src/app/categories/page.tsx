import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { allMoveDestinations, listCategoryTree } from "@/services/category-edit";
import { PageHeader } from "@/components/ui/PageHeader";
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
  return (
    <>
      <PageHeader
        title="Categories"
        description="Create, archive and restore the categories every other screen groups by. Archiving never deletes — past transactions keep resolving through the same id."
      />
      <CategoryManager tree={tree} destinations={destinations} />
    </>
  );
}
