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
): SurfaceInsights | null {
  const set = factSet(facts);
  const insights: Insight[] = [];
  for (const candidate of candidates) {
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
