import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { insightSelections } from "@/db/schema/insights";
import type { Fact } from "@/lib/insight-facts";
import { insightPoolHash } from "@/lib/insight-hash";
import type { InsightSurfaceId } from "@/lib/insight-surfaces";
import {
  runInsights,
  type InsightCandidate,
  type SurfaceInsights,
} from "./insights";
import { readSettings } from "./settings";

/**
 * PASS 72d — the one place that decides whether a surface speaks, and in what
 * order.
 *
 * ⛔ Read `lib/insight-grammar.ts` first for why insights exist at all. This
 * module adds nothing to what an insight may SAY; it is entirely about policy:
 *
 *  1. **The kill switch.** Global, plus one per surface. Off is a fully honest
 *     app rather than a degraded one — every figure keeps its provenance badge
 *     and every chart keeps its numbers; the prose is the only thing that goes.
 *  2. **The cached order.** Keyed by the pool's CONTENT (`lib/insight-hash`),
 *     so an unchanged page costs nothing and a moved figure invalidates exactly
 *     the judgement that rested on it, with nothing to expire.
 *
 * ## ⛔ A page render NEVER calls a model
 *
 * The cache is read here and filled somewhere else, on purpose. A model call
 * inside a server render would put a network round-trip and a charge on every
 * navigation, and a page whose cost depends on how often it is looked at is not
 * a page anyone can afford to leave open. A miss is not a failure: it renders
 * the surface's own editorial order, which is what the app shipped before any
 * of this existed.
 *
 * Split from `insight-selection` (which fills the cache) so the services can
 * import this without a cycle — that module imports the services.
 */

/**
 * Is this surface allowed to speak?
 *
 * ⚠️ ABSENT means ON. The per-surface map records a decision to turn something
 * OFF, so a surface added after a preference was saved speaks by default rather
 * than being silently mute until somebody notices.
 */
export function insightsEnabled(db: AppDatabase, surface: InsightSurfaceId): boolean {
  const settings = readSettings(db);
  if (!settings.insightsEnabled) return false;
  return settings.insightSurfaces[surface] !== false;
}

/** What a surface measured, before anything is proved. */
export interface InsightInput {
  facts: Fact[];
  candidates: InsightCandidate[];
  window: { label: string; note?: string | null };
}

/** The stored order for this exact pool, or null. */
export function cachedOrder(db: AppDatabase, facts: readonly Fact[], candidates: readonly InsightCandidate[]): string[] | null {
  const row = db
    .select({ claimKeys: insightSelections.claimKeys })
    .from(insightSelections)
    .where(eq(insightSelections.factHash, insightPoolHash(facts, candidates)))
    .get();
  return row ? parseKeys(row.claimKeys) : null;
}

/**
 * A stored order is JSON written by an earlier version of this app, so it is
 * parsed defensively rather than trusted: a hand-edited row must degrade to
 * "no opinion" and never take a page down. `applyOrder` drops any key this
 * pool does not contain, so a wrong-but-well-formed list is already harmless.
 */
function parseKeys(raw: string): string[] {
  let value: unknown;
  /*
   * ⚠️ The catch wraps the PARSE and nothing else. Wrapping the checks below it
   * as well made them dead: `("a string").filter` throws, the catch returned
   * `[]`, and deleting the `Array.isArray` guard changed no behaviour at all —
   * a guard whose removal nothing notices is not a guard.
   */
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * The whole policy in one call: every surface ends with this.
 *
 * `built === null` means the surface measured nothing it could speak about, and
 * that arrives here rather than being short-circuited by the caller so there is
 * exactly one place a surface can return from.
 */
export function surfaceInsights(
  db: AppDatabase,
  surface: InsightSurfaceId,
  built: InsightInput | null,
): SurfaceInsights | null {
  if (built === null) return null;
  if (!insightsEnabled(db, surface)) return null;
  return runInsights(built.facts, built.candidates, built.window, cachedOrder(db, built.facts, built.candidates));
}
