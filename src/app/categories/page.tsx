import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { listCategoryTree } from "@/services/category-edit";
import { PageHeader } from "@/components/ui/PageHeader";
import { CategoryManager } from "@/components/categories/CategoryManager";

export const metadata: Metadata = { title: "Categories" };
export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const tree = listCategoryTree(getDb());
  return (
    <>
      <PageHeader
        title="Categories"
        description="Create, archive and restore the categories every other screen groups by. Archiving never deletes — past transactions keep resolving through the same id."
      />
      <CategoryManager tree={tree} />
    </>
  );
}
