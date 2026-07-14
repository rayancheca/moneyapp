"use client";

import { useRouter } from "next/navigation";
import { renameCategoryAction } from "@/app/categories/actions";
import { InlineEditableText } from "@/components/ui/InlineEditableText";

/**
 * The category detail title as an inline-editable heading (S3). The chip and
 * breadcrumb mirror the saved name after refresh — one editing surface per
 * value. Transfer/system categories never render this (the page passes
 * editable=false) because detection matches on their names.
 */
export function CategoryNameHeading({
  categoryId,
  name,
  editable,
}: {
  categoryId: string;
  name: string;
  editable: boolean;
}) {
  const router = useRouter();
  if (!editable) return <h1 className="text-2xl font-semibold">{name}</h1>;
  return (
    <h1 className="text-2xl font-semibold">
      <InlineEditableText
        value={name}
        label="Category name"
        maxLength={60}
        className="text-2xl font-semibold"
        onSave={async (next) => {
          const result = await renameCategoryAction({ categoryId, name: next });
          if (result.ok) router.refresh();
          return { ok: result.ok, error: result.ok ? undefined : result.error };
        }}
      />
    </h1>
  );
}
