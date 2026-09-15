import type { CategoryKind } from "@/db/schema/categories";

/*
 * The two lists of category kinds the manager renders and the category-edit
 * service enforces. Here rather than in `services/category-edit` because
 * `CategoryManager` is a `"use client"` component, and importing a value from
 * the service put the service's whole import graph in the browser bundle —
 * see `client-bundle-graph.ts`.
 */

/**
 * Kinds a user may create. `transfer` and `system` are deliberately absent:
 * the transfer detector and credit-match machinery resolve those BY NAME, so a
 * user-made one would either collide with a name detection depends on or sit
 * inert while looking real. Same reasoning that blocks renaming them.
 */
export const CREATABLE_CATEGORY_KINDS = ["expense", "income", "rewards", "investment"] as const;
export type CreatableCategoryKind = (typeof CREATABLE_CATEGORY_KINDS)[number];

/**
 * The order the manager groups roots in: what you spend first, then what comes
 * in, then the plumbing. Exported because `reorderCategories` has to renumber
 * roots in exactly the sequence the screen shows them, and a second copy of this
 * list would silently drift from the one the UI renders.
 */
export const KIND_ORDER: readonly CategoryKind[] = [
  "expense",
  "income",
  "rewards",
  "investment",
  "transfer",
  "system",
];
