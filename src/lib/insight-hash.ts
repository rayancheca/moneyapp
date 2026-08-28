import { createHash } from "node:crypto";
import type { Fact } from "./insight-facts";
import { CLAIMS } from "./insight-grammar";

/**
 * The identity of a page's insight POOL — what a cached selection is keyed by.
 *
 * ⛔ A selection is an editorial judgement made over a specific set of measured
 * sentences. The moment any figure in that set moves, the judgement was made
 * about something that no longer exists, and serving it would be a stale order
 * over fresh numbers. So the key is the CONTENT, not the surface: an unchanged
 * page costs nothing to re-read, and a changed figure invalidates exactly the
 * selection that rested on it.
 *
 * ## What goes in, and why each part has to
 *
 * - **Every field of every bound fact.** Not just the display: two facts can
 *   render identically and differ where it matters (a rank of 1 of 2 and 1 of
 *   20 both print "1st"). `JSON.stringify` over sorted keys is used rather than
 *   a hand-written field list precisely so a field added to `Fact` later is
 *   included without anybody remembering to add it here.
 * - **The candidate list, in order.** The editorial order is the input the
 *   model is asked to improve on; a different starting list is a different
 *   question.
 * - **The vocabulary.** Every claim id AND its template, so editing the words
 *   of a template invalidates every selection made when it said something else.
 *   This is why `vocabularyVersion` reads `CLAIMS` rather than being a constant
 *   somebody has to remember to bump.
 *
 * ⚠️ The surface id is deliberately NOT in the hash. Two surfaces that produced
 * the identical pool would be asking the identical question, and a cache that
 * answered it twice would be paying twice for one judgement.
 */

/**
 * A stable JSON encoding: keys sorted, so two objects that differ only in
 * property order hash the same.
 *
 * `JSON.stringify`'s replacer runs on every value, and returning a NEW object
 * with sorted keys is what makes the encoding canonical — the serializer then
 * walks the sorted copy. Arrays are passed through untouched: their order is
 * meaning, not incidental.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const source = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
}

/**
 * The vocabulary's own fingerprint — ids AND templates.
 *
 * Read off `CLAIMS` rather than maintained by hand, because a version constant
 * somebody forgets to bump is a cache that serves an order chosen for words the
 * app no longer says.
 */
export function vocabularyVersion(claims: readonly { id: string; template: string }[] = CLAIMS): string {
  return createHash("sha256")
    .update(canonicalJson(claims.map((c) => [c.id, c.template])))
    .digest("hex")
    .slice(0, 12);
}

/** A candidate as the hash sees it: which words, over which slots. */
export interface HashableCandidate {
  readonly claimId: string;
  readonly a: string;
  readonly b?: string;
}

export function insightPoolHash(
  facts: readonly Fact[],
  candidates: readonly HashableCandidate[],
  /**
   * The vocabulary this pool was written in. A parameter rather than a closed-
   * over call so a test can prove the version really participates — a hash that
   * "includes the vocabulary" with no way to vary it is an unverifiable claim.
   */
  version: string = vocabularyVersion(),
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: version,
        facts,
        candidates: candidates.map((c) => (c.b === undefined ? [c.claimId, c.a] : [c.claimId, c.a, c.b])),
      }),
    )
    .digest("hex");
}
