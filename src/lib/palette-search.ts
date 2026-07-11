/**
 * Pure filter/rank for the command palette (plan §2.5).
 *
 * Tiers (best first): exact label prefix > word-boundary prefix > label
 * substring > keyword substring. Order is stable within a tier (original item
 * order). Matching is case- and diacritic-insensitive. An empty (or
 * whitespace-only) query returns the first `limit` items in original order.
 */

export interface PaletteItem {
  id: string;
  label: string;
  keywords?: string[];
  group: string;
}

const DEFAULT_LIMIT = 12;

/** NFD-decompose then strip combining marks: "Café" and "cafe" both → "cafe". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function paletteSearch<T extends PaletteItem>(
  items: readonly T[],
  query: string,
  limit = DEFAULT_LIMIT,
): T[] {
  const q = fold(query).trim();
  if (q === "") {
    return items.slice(0, limit);
  }

  const labelPrefix: T[] = [];
  const wordPrefix: T[] = [];
  const labelSubstring: T[] = [];
  const keywordSubstring: T[] = [];

  for (const item of items) {
    const label = fold(item.label);
    if (label.startsWith(q)) {
      labelPrefix.push(item);
    } else if (label.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) {
      wordPrefix.push(item);
    } else if (label.includes(q)) {
      labelSubstring.push(item);
    } else if ((item.keywords ?? []).some((keyword) => fold(keyword).includes(q))) {
      keywordSubstring.push(item);
    }
  }

  return [...labelPrefix, ...wordPrefix, ...labelSubstring, ...keywordSubstring].slice(0, limit);
}

/**
 * Reorders results so each group's items are contiguous (group order = first
 * appearance; item order preserved within a group). paletteSearch ranks by
 * match TIER across all groups, so a query matching items from several groups
 * in different tiers would otherwise interleave them — which makes a grouped
 * renderer emit the same group header (and its DOM id) more than once.
 */
export function groupContiguous<T extends { group: string }>(items: readonly T[]): T[] {
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byGroup.get(item.group);
    if (bucket) bucket.push(item);
    else byGroup.set(item.group, [item]);
  }
  return [...byGroup.values()].flat();
}
