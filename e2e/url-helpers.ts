/**
 * URL helpers for specs that FOLLOW a link the app rendered.
 *
 * 🔴 Four specs resolved a category page as `` `${href}?period=2026` `` — a
 * bare-string append that was correct only while the app's own category links
 * carried no query. On 2026-09-11 they were given one (a bare
 * `/categories/<id>` means the CURRENT month to `resolvePeriod`, so every such
 * link opened an empty September page), and the append silently produced
 *
 *     /categories/<id>?period=2026?period=2026
 *
 * whose `period` parses as the literal `2026?period=2026`, matches neither the
 * month nor the year pattern, and falls back to — the current month. The specs
 * would have gone on passing against a page rendering the very thing the fix
 * removed, and their baselines would have pinned it.
 */

/** `path` with `key=value`, replacing any the app already put there. */
export function withParam(path: string, key: string, value: string): string {
  const [base, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${base}?${params.toString()}`;
}
