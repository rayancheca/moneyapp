import { factSet, type Fact } from "@/lib/insight-facts";
import { checkClaim } from "@/lib/insight-validator";
import type { Provenance } from "./provenance";

/**
 * The part of an insight surface that is the same everywhere.
 *
 * ⛔ Read `lib/insight-grammar.ts` first for why any of this exists. What lives
 * here is only the loop: take a surface's measured facts and the claims worth
 * trying on them, ask the write gate which of those claims the facts support,
 * attach the proof, and stop at a readable number of sentences.
 *
 * Extracted from `spending-insights` when the second surface arrived, and
 * deliberately BEFORE the third: every surface that repeats this loop is
 * another place the cap, the drop-if-unprovable rule and the key scheme could
 * quietly diverge. A surface should have to write down its facts and nothing
 * else.
 */

/** How many accepted claims reach a page. A wall of text is not an insight. */
export const MAX_INSIGHTS = 4;

/**
 * Every place in the app that speaks, as a closed list.
 *
 * ⛔ The list exists so the kill switch can be exhaustive rather than a set of
 * booleans that grew one page at a time. `/settings` renders it, the per-surface
 * switch is keyed by it, and a surface added later that forgets to appear here
 * is a surface the owner cannot turn off.
 *
 * ⚠️ Measured before it was written (`scripts/probe-insight-pool.ts`, 533
 * surfaces on the real ledger): 364 of them say nothing at all, and no page in
 * the ledger has ever had more than four things to say. So the entity surfaces
 * below are one page SHAPE, not one page — 399 merchant pages share `merchant`.
 */
export const INSIGHT_SURFACES = [
  { id: "spending", label: "Spending", where: "/spending" },
  { id: "category", label: "A category", where: "/categories/[id]" },
  { id: "budgets", label: "Budgets", where: "/budgets" },
  { id: "year", label: "A year in review", where: "/summary/[year]" },
  { id: "account", label: "An account", where: "/accounts/[id]" },
  { id: "merchant", label: "A merchant", where: "/merchants/[id]" },
  { id: "recurring", label: "A commitment", where: "/recurring/[id]" },
  { id: "notices", label: "Notices", where: "the dashboard" },
] as const;

export type InsightSurfaceId = (typeof INSIGHT_SURFACES)[number]["id"];

export interface InsightCandidate {
  /** a claim id from the closed vocabulary */
  claimId: string;
  /** slot a — a fact id in this surface's set */
  a: string;
  /** slot b, for the two-fact claims */
  b?: string;
  /**
   * The proof for this sentence. Called ONLY if the claim is accepted, so a
   * surface never pays for provenance on a claim it cannot make.
   */
  prove: () => Provenance | null;
}

export interface Insight {
  /**
   * Stable across renders — the React key, and a dismissal id later.
   *
   * Claim id AND slots, not the claim id alone: two candidates may legitimately
   * use one template about different facts (two categories, both risen), and a
   * duplicate key silently makes React reuse the wrong node.
   */
  id: string;
  /** the sentence, rendered by the app from its own vocabulary */
  text: string;
  /** which template said it — for the tests, and for a future per-claim opt-out */
  claimId: string;
  provenance: Provenance;
}

/**
 * A candidate's stable identity — the same string `Insight.id` carries.
 *
 * ⛔ Derived from the claim and its SLOTS, never from the rendered sentence, so
 * it can be computed before anything is proved. That is what lets a cached
 * ORDER be applied to a candidate list without paying for the provenance of the
 * candidates it drops.
 *
 * Claim id AND slots, not the claim id alone: two candidates may legitimately
 * use one template about different facts, and a shared key would make one of
 * them impossible to name.
 */
export function candidateKey(c: { claimId: string; a: string; b?: string }): string {
  return c.b === undefined ? `${c.claimId}:${c.a}` : `${c.claimId}:${c.a}+${c.b}`;
}

/**
 * Put a chosen order in front, and keep everything else behind it.
 *
 * ⛔ A REORDER, never a filter, and that is the safety property of the whole
 * selection feature. A model that returns nothing, returns keys this pool does
 * not contain, or returns two of the same, cannot empty a page or hide a
 * sentence the app would otherwise have shown — the worst it can do is leave
 * the editorial order alone. Unknown keys are dropped rather than trusted;
 * duplicates collapse; the remainder follows in the order the surface chose.
 */
export function applyOrder<T extends { claimId: string; a: string; b?: string }>(
  candidates: readonly T[],
  order: readonly string[] | null,
): readonly T[] {
  if (!order) return candidates;
  const byKey = new Map(candidates.map((c) => [candidateKey(c), c]));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    const hit = byKey.get(key);
    if (!hit || seen.has(key)) continue;
    seen.add(key);
    picked.push(hit);
  }
  return [...picked, ...candidates.filter((c) => !seen.has(candidateKey(c)))];
}

export interface SurfaceInsights {
  /** what every claim here is about, e.g. "Jul 2026" or "Dining" */
  windowLabel: string;
  /**
   * Why that window and not the obvious one — measured, in the app's own words.
   * Null when the window needs no explanation.
   */
  windowNote: string | null;
  insights: Insight[];
}

/**
 * Run a surface's candidates through the write gate.
 *
 * Returns null rather than an empty list when nothing is expressible. ⛔ Nothing
 * to say is not a weakness and must not render as one — this distinction has
 * cost four separate services in this codebase, and an insight strip that says
 * "no insights available" would be the fifth.
 */
export function runInsights(
  facts: readonly Fact[],
  candidates: readonly InsightCandidate[],
  window: { label: string; note?: string | null },
  /**
   * A cached editorial order (pass 72d), or null for the surface's own.
   *
   * ⛔ Applied HERE rather than by the caller so that the cap, the drop-if-
   * unprovable rule and the ordering stay in one loop. The order changes which
   * four sentences survive the cap and can never change whether one is true:
   * every candidate still goes through the same write gate and still has to be
   * proved.
   */
  order: readonly string[] | null = null,
): SurfaceInsights | null {
  const set = factSet(facts);
  const insights: Insight[] = [];
  for (const candidate of applyOrder(candidates, order)) {
    if (insights.length >= MAX_INSIGHTS) break;
    const verdict = checkClaim(candidate, set);
    if (!verdict.ok) continue;
    /*
     * An insight the app cannot prove does not render. Same rule as every other
     * figure on every other surface — a sentence with no chain behind it is
     * exactly the thing this whole feature was rebuilt to make impossible.
     */
    const provenance = candidate.prove();
    if (!provenance) continue;
    insights.push({
      id: `${verdict.claimId}:${verdict.factIds.join("+")}`,
      text: verdict.text,
      claimId: verdict.claimId,
      provenance,
    });
  }
  if (insights.length === 0) return null;
  return { windowLabel: window.label, windowNote: window.note ?? null, insights };
}
