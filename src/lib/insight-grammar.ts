import type { Fact, FactKind } from "./insight-facts";

/**
 * The closed vocabulary an insight may be written in.
 *
 * ⛔ An ALLOWLIST, not a denylist. Pass 46 tried to catch fabrication by
 * scanning finished prose for tells — digits, then quantity words — and a
 * denylist of English quantity words is unwinnable, because the language always
 * has another word ("largest", "biggest", "top", "chief", "dominant", …). This
 * table inverts that: a sentence exists only if it is one of these, and every
 * other sentence in the language is refused without having to be anticipated.
 *
 * Three properties make the whole scheme work, and none of them is optional:
 *
 *  1. **One claim per sentence.** A claim is the unit that gets checked, so a
 *     sentence that made two assertions could be half true and would have to be
 *     accepted or rejected whole. Several claims render as several sentences.
 *  2. **Every variable word comes from a fact**, through a named field. The
 *     template owns the fixed words and nothing else; there is no position in
 *     which free text can appear.
 *  3. **`holds` is a predicate over the bound facts**, not over the words. This
 *     is the half pass 46 could not have written: "is the largest" is accepted
 *     only when a `rank` fact says 1, so the exact string that got this feature
 *     held — *"{{f1}} is your largest spending category"* while f1 was third —
 *     is now a rejection with a reason rather than a warning.
 */

/**
 * The three fields a template may read off a fact. Kind-specific and DERIVED,
 * so a template cannot reach a raw number and print it unformatted.
 *
 * - `name`  — what the fact is about ("Dining")
 * - `value` — the app's own rendering of the measurement ("$1,963.24")
 * - `of`    — the context the measurement only means anything inside
 *             ("22 spending categories", "June and July", "everything you spend")
 */
export type FactField = "name" | "value" | "of";

/**
 * `of` is the field that carries a claim's frame of reference, and a scalar has
 * none — a scalar is a quantity, full stop. Reading `of` off one is a template
 * bug, and it fails loudly here rather than rendering "undefined" onto a page.
 */
export function factField(fact: Fact, field: FactField): string {
  if (field === "name") return fact.subject;
  if (field === "value") {
    // a trend's magnitude IS its window — there is no other number in it
    return fact.kind === "trend" ? `${fact.points} months` : fact.display;
  }
  switch (fact.kind) {
    case "rank":
      return `${fact.outOf} ${fact.amongLabel}`;
    case "share":
      return fact.ofLabel;
    case "delta":
      return `${fact.fromLabel} and ${fact.toLabel}`;
    case "trend":
      return fact.sinceLabel;
    case "count":
      return fact.noun;
    case "scalar":
      throw new Error("A scalar fact has no frame of reference — it is a quantity, not a comparison");
  }
}

/** A slot as it appears in a template and in rendered-then-reparsed text. */
export const SLOT_RE = /\{\{([ab])\.(name|value|of)\}\}/g;

interface ClaimShape {
  readonly id: string;
  /** fixed words plus `{{a.field}}` / `{{b.field}}` slots — nothing else */
  readonly template: string;
  /** which fact kind each slot letter accepts */
  readonly binds: { readonly a: FactKind; readonly b?: FactKind };
}

/**
 * A claim either asserts nothing beyond its facts' own displays, or it asserts
 * something AND says what would make that true.
 *
 * The two are one union rather than two optional fields so that a predicate
 * without a reason cannot be written down. A refusal whose reason was "a
 * supporting fact" would be useless to whoever has to act on it, and a `??`
 * fallback would quietly supply exactly that.
 */
export type ClaimTemplate = ClaimShape &
  (
    | { readonly holds?: undefined; readonly why?: undefined }
    | {
        /** what must be TRUE of the bound facts for these words to be honest */
        readonly holds: (a: Fact, b: Fact | undefined) => boolean;
        /** why `holds` exists, shown verbatim as the rejection reason */
        readonly why: string;
      }
  );

/**
 * ⛔ Neutral wording is a hard requirement, not a style note. The owner travels
 * and drives an EV, and three charges once flagged as "card-testing probes"
 * were all legitimate. Every template below DESCRIBES. None advises, none
 * praises, none warns, and none contains a word like "too", "should", "only" or
 * "surprisingly" that would smuggle a judgement into a measurement.
 */
export const CLAIMS: readonly ClaimTemplate[] = [
  // ── rank ────────────────────────────────────────────────────────────
  {
    id: "largest_in_set",
    template: "{{a.name}} is the largest of your {{a.of}}, at {{b.value}}.",
    binds: { a: "rank", b: "scalar" },
    holds: (a) => a.kind === "rank" && a.value === 1 && a.outOf >= 2,
    why: "a rank fact placing it 1st among at least two",
  },
  {
    id: "ranked_in_set",
    template: "{{a.name}} sits {{a.value}} of your {{a.of}}, at {{b.value}}.",
    binds: { a: "rank", b: "scalar" },
    holds: (a) => a.kind === "rank" && a.outOf >= 2,
    why: "a rank fact among at least two",
  },
  // ── share ───────────────────────────────────────────────────────────
  {
    id: "share_of_whole",
    template: "{{a.name}} is {{a.value}} of {{a.of}}.",
    binds: { a: "share" },
  },
  {
    id: "more_than_half",
    template: "{{a.name}} is more than half of {{a.of}}, at {{a.value}}.",
    binds: { a: "share" },
    holds: (a) => a.kind === "share" && a.value > 0.5,
    why: "a share fact above one half",
  },
  // ── count ───────────────────────────────────────────────────────────
  {
    id: "count_in_subject",
    template: "{{a.value}} landed in {{a.name}}.",
    binds: { a: "count" },
    holds: (a) => a.kind === "count" && a.value > 0,
    why: "a count fact above zero — a measured zero is not a finding",
  },
  // ── scalar ──────────────────────────────────────────────────────────
  {
    id: "measured_total",
    template: "{{a.name}} came to {{a.value}}.",
    binds: { a: "scalar" },
  },
  // ── delta ───────────────────────────────────────────────────────────
  {
    id: "rose_between",
    template: "{{a.name}} rose by {{a.value}} between {{a.of}}.",
    binds: { a: "delta" },
    holds: (a) => a.kind === "delta" && a.value > 0,
    why: "a delta fact with a positive value",
  },
  {
    id: "fell_between",
    template: "{{a.name}} fell by {{a.value}} between {{a.of}}.",
    binds: { a: "delta" },
    holds: (a) => a.kind === "delta" && a.value < 0,
    why: "a delta fact with a negative value",
  },
  {
    id: "unchanged_between",
    template: "{{a.name}} did not move between {{a.of}}.",
    binds: { a: "delta" },
    holds: (a) => a.kind === "delta" && a.value === 0,
    why: "a delta fact of exactly zero",
  },
  // ── trend ───────────────────────────────────────────────────────────
  {
    id: "trend_rising",
    template: "{{a.name}} has risen across {{a.value}} since {{a.of}}.",
    binds: { a: "trend" },
    holds: (a) => a.kind === "trend" && a.direction === "rising",
    why: "a trend fact whose direction is rising",
  },
  {
    id: "trend_falling",
    template: "{{a.name}} has fallen across {{a.value}} since {{a.of}}.",
    binds: { a: "trend" },
    holds: (a) => a.kind === "trend" && a.direction === "falling",
    why: "a trend fact whose direction is falling",
  },
  {
    id: "trend_flat",
    template: "{{a.name}} has held level across {{a.value}} since {{a.of}}.",
    binds: { a: "trend" },
    holds: (a) => a.kind === "trend" && a.direction === "flat",
    why: "a trend fact whose direction is flat",
  },
];

export const CLAIMS_BY_ID: ReadonlyMap<string, ClaimTemplate> = new Map(CLAIMS.map((c) => [c.id, c]));

/** Every claim id, for the model's tool schema — the enum is the allowlist. */
export const CLAIM_IDS: readonly string[] = CLAIMS.map((c) => c.id);

/**
 * ⛔ THE CROSS-SLOT RULE, and the attack that produced it.
 *
 * A two-fact claim says one thing about ONE subject: "{{a.name}} is the largest
 * … at {{b.value}}" is a sentence about a single category. Nothing in the
 * template says the two facts have to be about the same category, and the first
 * run of the attack suite proved that gap is exploitable — this sentence was
 * ACCEPTED:
 *
 *     "Groceries is the largest of your 22 spending categories, at $1,963.24."
 *
 * Groceries really is the largest. $1,963.24 really is a measured total. The
 * rank belonged to Groceries and the money belonged to Dining, so every token
 * was true and the sentence was false — a fabricated relationship assembled
 * entirely out of real facts, which is the exact failure class this whole
 * module exists to close.
 *
 * Enforced here rather than in each template's `holds`, so a template added
 * later inherits it instead of having to remember it.
 */
export function slotsAgree(a: Fact, b: Fact | undefined): boolean {
  return b === undefined || a.subject === b.subject;
}

export const SLOTS_DISAGREE_REASON =
  "the two facts are about different subjects, so the sentence would staple one subject's figure to another's";

/**
 * Structural checks on the vocabulary itself, run ONCE at import.
 *
 * These were originally runtime branches inside the renderer — "if this
 * template reads slot b but no b fact is bound, throw" — which is a guard
 * against a mistake that can only be made while WRITING a template, checked on
 * every render, in a branch no input could ever take. Hoisting them to import
 * time turns a malformed template into a build failure and lets the renderer
 * be a renderer.
 *
 * Exported so it can be called with a deliberately broken table: a check whose
 * failure path never runs is not a check.
 */
export function assertTemplatesWellFormed(claims: readonly ClaimTemplate[]): void {
  for (const claim of claims) {
    const letters = new Set<string>();
    for (const m of claim.template.matchAll(new RegExp(SLOT_RE.source, "gu"))) {
      const letter = m[1]!;
      letters.add(letter);
      const kind = letter === "a" ? claim.binds.a : claim.binds.b;
      if (kind === undefined) {
        throw new Error(`Claim "${claim.id}" reads slot ${letter}, which it does not bind`);
      }
      if (m[2] === "of" && kind === "scalar") {
        throw new Error(`Claim "${claim.id}" reads a frame of reference off a scalar slot`);
      }
    }
    if (!letters.has("a")) throw new Error(`Claim "${claim.id}" reads no facts at all`);
    if (claim.binds.b !== undefined && !letters.has("b")) {
      throw new Error(`Claim "${claim.id}" binds a second fact that no slot reads`);
    }
    const words = claim.template.replace(new RegExp(SLOT_RE.source, "gu"), " ");
    if (/\d/u.test(words)) throw new Error(`Claim "${claim.id}" states a figure of its own`);
    // one claim per sentence: a second full stop would be two assertions
    // sharing one accept/reject verdict
    if (words.split(".").length - 1 !== 1 || !claim.template.endsWith(".")) {
      throw new Error(`Claim "${claim.id}" is not exactly one sentence`);
    }
  }
}

assertTemplatesWellFormed(CLAIMS);
