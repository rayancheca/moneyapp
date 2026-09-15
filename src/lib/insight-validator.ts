import type { Fact, FactSet } from "./insight-facts";
import {
  CLAIMS,
  CLAIMS_BY_ID,
  SLOTS_DISAGREE_REASON,
  factField,
  slotsAgree,
  type ClaimTemplate,
  type FactField,
} from "./insight-grammar";
import { normalizeForCheck } from "./insight-text";

/**
 * The two gates an insight passes before a reader sees it.
 *
 * ⛔ Read the header of `insight-grammar.ts` first. The short version: pass 46
 * validated FINISHED PROSE for fabricated numbers, ran that validator against
 * 17 adversarial strings and accepted 16, because none of the false ones
 * contained a fabricated number — they contained fabricated RELATIONSHIPS.
 *
 * So there are two gates here, and they are deliberately not the same check:
 *
 *  - `checkClaim` is the WRITE gate. A model never emits prose; it emits a
 *    claim id from a closed enum plus fact slots, and this decides whether
 *    those facts support those words. Fabrication is impossible by
 *    construction, not by detection.
 *
 *  - `validateProse` is the READ gate, and it exists because "impossible by
 *    construction" is a claim about code that can regress. It takes an
 *    arbitrary string and answers one question: **could this app have produced
 *    this sentence from these facts?** Anything else — a cached insight from an
 *    older vocabulary, a hand-edited row, a future path that forgets to use the
 *    write gate — is refused at the point of rendering.
 *
 * Both refuse by default. There is no "low confidence" rendering and no
 * warning banner: an insight the app cannot prove does not appear, which is the
 * same rule every figure in this app already follows.
 */

/** Why a candidate was refused. Every one of these is a rejection, not a warning. */
export type RejectionCode =
  /** the words are not in the vocabulary at all */
  | "unknown-wording"
  /** a slot's text matches no field of the fact bound to it */
  | "unsourced-figure"
  /** the wording is ours, the facts are real, and they do not support the claim */
  | "unsupported-claim"
  /** a slot named a fact that is not in the set */
  | "unknown-fact"
  /** the fact is real but the wrong kind for this claim */
  | "wrong-fact-kind"
  /** the claim needs a second fact and did not get one, or got one it cannot use */
  | "arity";

export interface Accepted {
  readonly ok: true;
  readonly text: string;
  readonly claimId: string;
  /** the slots this sentence actually rests on — what a provenance popover lists */
  readonly factIds: readonly string[];
}

export interface Rejected {
  readonly ok: false;
  readonly code: RejectionCode;
  /** plain-language reason, safe to log and to show a developer */
  readonly reason: string;
}

export type Verdict = Accepted | Rejected;

const reject = (code: RejectionCode, reason: string): Rejected => ({ ok: false, code, reason });

/**
 * The cross-slot rule, as a rejection rather than a predicate.
 *
 * Phrased this way because `slotsAgree` is only ever false when a SECOND fact
 * exists — so a message built after a bare `!slotsAgree(...)` would have to
 * reach for `b?.subject`, and that `?.` is a branch no input can take. Naming
 * the `b === undefined` case here keeps the reason concrete and the code
 * reachable in both directions.
 */
function crossSlot(a: Fact, b: Fact | undefined): Rejected | null {
  if (slotsAgree(a, b) || b === undefined) return null;
  return reject("unsupported-claim", `${SLOTS_DISAGREE_REASON} (${a.subject} / ${b.subject})`);
}

/** The same for a claim's own predicate, shared by the write gate and the read gate. */
function predicateFails(claim: ClaimTemplate, a: Fact, b: Fact | undefined): Rejected | null {
  if (!claim.holds || claim.holds(a, b)) return null;
  return reject("unsupported-claim", `"${claim.id}" needs ${claim.why} — ${a.subject} does not have one`);
}

/** see `lib/insight-text` — the one fold both this gate and the template check read */
export { normalizeForCheck };

/**
 * Does this text contain a figure at all? Used only to give a SHARPER REASON
 * when wording is unknown — never as the check itself, which is the mistake
 * that made a digit scan look like an anti-fabrication guard in the first place.
 */
export function containsFigure(text: string): boolean {
  return /\d/u.test(normalizeForCheck(text));
}

function bindingFor(claim: ClaimTemplate, facts: FactSet, aId: string, bId: string | undefined): Verdict | { a: Fact; b?: Fact } {
  const a = facts.get(aId);
  if (!a) return reject("unknown-fact", `No fact ${aId} in this set`);
  if (a.kind !== claim.binds.a) {
    return reject("wrong-fact-kind", `"${claim.id}" needs a ${claim.binds.a} fact in slot a, got ${a.kind}`);
  }
  if (claim.binds.b === undefined) {
    if (bId !== undefined) return reject("arity", `"${claim.id}" takes one fact, two were given`);
    return { a };
  }
  if (bId === undefined) return reject("arity", `"${claim.id}" needs a second fact`);
  const b = facts.get(bId);
  if (!b) return reject("unknown-fact", `No fact ${bId} in this set`);
  if (b.kind !== claim.binds.b) {
    return reject("wrong-fact-kind", `"${claim.id}" needs a ${claim.binds.b} fact in slot b, got ${b.kind}`);
  }
  return { a, b };
}

function renderTemplate(claim: ClaimTemplate, a: Fact, b: Fact | undefined): string {
  return claim.template.replace(/\{\{([ab])\.(name|value|of)\}\}/g, (_m, letter: string, field: string) => {
    // `assertTemplatesWellFormed` ran at import: a template reads slot b only
    // if it binds b, and both gates resolve that binding before rendering
    const fact = (letter === "a" ? a : b)!;
    return factField(fact, field as FactField);
  });
}

/**
 * THE WRITE GATE. A claim id, one or two fact slots, and the facts they must
 * rest on.
 *
 * Note what is NOT a parameter: any text. The caller cannot supply a word.
 */
export function checkClaim(
  input: { claimId: string; a: string; b?: string },
  facts: FactSet,
): Verdict {
  const claim = CLAIMS_BY_ID.get(input.claimId);
  if (!claim) return reject("unknown-wording", `No claim named "${input.claimId}"`);

  const bound = bindingFor(claim, facts, input.a, input.b);
  if ("ok" in bound) return bound;

  const disagreement = crossSlot(bound.a, bound.b) ?? predicateFails(claim, bound.a, bound.b);
  if (disagreement) return disagreement;

  return {
    ok: true,
    text: renderTemplate(claim, bound.a, bound.b),
    claimId: claim.id,
    factIds: bound.b ? [bound.a.id, bound.b.id] : [bound.a.id],
  };
}

/**
 * A template turned into a matcher: fixed words matched literally, slots
 * captured. Built once per template rather than per call.
 *
 * The literal segments are escaped, so a template containing "$" or "." can
 * never act as a wildcard against a candidate. The slot pattern is lazy and
 * refuses to swallow a sentence break, which stops one slot absorbing the
 * literal text that should have anchored the next.
 */
function matcherFor(claim: ClaimTemplate): { re: RegExp; slots: { letter: "a" | "b"; field: FactField }[] } {
  const slots: { letter: "a" | "b"; field: FactField }[] = [];
  let source = "^";
  let last = 0;
  const re = /\{\{([ab])\.(name|value|of)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(claim.template)) !== null) {
    source += escapeRe(claim.template.slice(last, m.index));
    source += "(.+?)";
    slots.push({ letter: m[1] as "a" | "b", field: m[2] as FactField });
    last = m.index + m[0].length;
  }
  source += `${escapeRe(claim.template.slice(last))}$`;
  return { re: new RegExp(source, "u"), slots };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const MATCHERS = new Map<string, ReturnType<typeof matcherFor>>(CLAIMS.map((c) => [c.id, matcherFor(c)]));

/**
 * Every field a fact can legitimately print, normalised. A scalar has no `of`,
 * and asking for one throws, so the set is built defensively rather than by
 * mapping over all three fields.
 */
function printableFields(fact: Fact): Map<string, FactField> {
  const out = new Map<string, FactField>();
  for (const field of ["name", "value", "of"] as const) {
    try {
      out.set(normalizeForCheck(factField(fact, field)), field);
    } catch {
      // this kind does not have this field — nothing to record
    }
  }
  return out;
}

/**
 * THE READ GATE. Could this app have produced this sentence from these facts?
 *
 * Answered by parsing, not by scanning: the text must match one template's
 * fixed words exactly, every captured slot must equal a real field of a real
 * fact of the right kind, and the claim's own predicate must then hold. Three
 * independent ways to fail, each with its own reason, and every one of them a
 * refusal.
 */
export function validateProse(text: string, facts: FactSet): Verdict {
  const candidate = normalizeForCheck(text);
  if (candidate === "") return reject("unknown-wording", "Empty text is not a claim");

  let closest: Rejected | null = null;
  for (const claim of CLAIMS) {
    const matcher = MATCHERS.get(claim.id)!;
    const hit = matcher.re.exec(candidate);
    if (!hit) continue;

    // the wording is ours; from here a failure is about the FACTS, and that is
    // a sharper answer than "unknown wording", so it outranks a later miss
    const verdict = resolveCaptures(claim, matcher.slots, hit, facts);
    if (verdict.ok) return verdict;
    closest = closest ?? verdict;
  }

  if (closest) return closest;
  return reject(
    "unknown-wording",
    containsFigure(candidate)
      ? "Not one of the sentences this app writes, and it states a figure"
      : "Not one of the sentences this app writes",
  );
}

function resolveCaptures(
  claim: ClaimTemplate,
  slots: { letter: "a" | "b"; field: FactField }[],
  hit: RegExpExecArray,
  facts: FactSet,
): Verdict {
  /*
   * Which fact each letter refers to is not written in the text, so it is
   * INFERRED: the first capture for a letter proposes candidates, and every
   * later capture for the same letter narrows them. A sentence survives only
   * if one fact explains all of its slots at once — which is what stops a
   * sentence borrowing "Dining" from one fact and "$1,963.24" from another.
   */
  const candidates = new Map<"a" | "b", Fact[]>();
  for (const [i, slot] of slots.entries()) {
    // the regex matched, so every capture group has a value
    const captured = normalizeForCheck(hit[i + 1]!);
    const wantKind = slot.letter === "a" ? claim.binds.a : claim.binds.b;
    const pool =
      candidates.get(slot.letter) ??
      [...facts.values()].filter((f) => f.kind === wantKind);
    const narrowed = pool.filter((f) => printableFields(f).get(captured) === slot.field);
    if (narrowed.length === 0) {
      return reject(
        "unsourced-figure",
        `"${captured}" is not the ${slot.field} of any ${wantKind} fact this page measured`,
      );
    }
    candidates.set(slot.letter, narrowed);
  }

  /*
   * Both pools are non-empty here and neither `??` nor a length check is
   * needed: every template reads slot a (import-time check), a template reads
   * slot b exactly when it binds b, and the loop above returned already if any
   * slot narrowed to nothing.
   */
  const aPool = candidates.get("a")!;
  const bPool: (Fact | undefined)[] = claim.binds.b === undefined ? [undefined] : candidates.get("b")!;

  /*
   * ⛔ Search the PAIRS, not each slot independently.
   *
   * Taking the first candidate for `a` and the first for `b` is what let
   * "Groceries is the largest … at $1,963.24" through on the suite's first run:
   * each slot resolved to a real fact and the pair was never examined. A
   * sentence is accepted only if ONE pair explains all of its slots and
   * satisfies the claim — the narrowest thing that can be true.
   */
  let nearMiss: Rejected | null = null;
  for (const a of aPool) {
    for (const b of bPool) {
      const failure = crossSlot(a, b) ?? predicateFails(claim, a, b);
      if (failure) {
        nearMiss ??= failure;
        continue;
      }
      return { ok: true, text: renderTemplate(claim, a, b), claimId: claim.id, factIds: b ? [a.id, b.id] : [a.id] };
    }
  }
  // every pair failed, and `nearMiss` holds the first reason it failed for
  return nearMiss!;
}
