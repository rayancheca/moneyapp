/**
 * Pure list-reorder math for the "movable" program (S7): drag/keyboard
 * reordering of dashboard sections, account cards, and anything else with a
 * persisted order. React-free and fully unit-tested.
 */

/** Returns a NEW array with the item at `from` moved to `to` (indices clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (list.length === 0) return next;
  const f = Math.max(0, Math.min(from, list.length - 1));
  const t = Math.max(0, Math.min(to, list.length - 1));
  if (f === t) return next;
  const [item] = next.splice(f, 1);
  next.splice(t, 0, item!);
  return next;
}

/**
 * Reconciles a SAVED order with the CANONICAL id set: unknown saved ids drop
 * (a section that no longer exists), missing ids append in canonical order (a
 * section added after the order was saved). The result always contains exactly
 * the canonical ids — a stale persisted layout can never hide a section.
 */
export function normalizeOrder(saved: readonly string[], canonical: readonly string[]): string[] {
  const canonicalSet = new Set(canonical);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of saved) {
    // dedupe as well as filter — a duplicated saved id must not render twice
    if (canonicalSet.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }
  return [...kept, ...canonical.filter((id) => !seen.has(id))];
}
