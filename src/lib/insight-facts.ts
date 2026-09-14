import { formatCents, formatCentsSigned } from "./money";
import { UNPRINTABLE_NAME_CHARS } from "./printable-name";

/**
 * A fact an insight is allowed to speak about — carrying a MACHINE-READABLE
 * value, not only a rendered string.
 *
 * ⛔ This module exists because of a specific, executed failure. Pass 46 built
 * this feature the other way round: a `Fact` carried `display: string` and
 * nothing else, every figure reached the model as an opaque `{{f1}}` slot so it
 * could never emit a digit, and a validator scanned the result for fabricated
 * numbers. That validator was then run against 17 adversarial strings and
 * **accepted 16 of them**, including:
 *
 *     "{{f1}} is your largest spending category."   ← f1 was the THIRD largest
 *     "{{f1}} has been climbing since July."        ← no trend data existed
 *
 * Neither sentence contains a fabricated number. Both are false. Slots
 * constrain fabricated NUMBERS and say nothing whatever about fabricated
 * RELATIONSHIPS, and a denylist of English quantity words ("largest",
 * "climbing", "most", "doubled", …) is unwinnable — the language always has
 * another word.
 *
 * The root cause was the TYPE. With only a string, "is your largest" is not
 * merely unverified, it is **unverifiable even in principle**: nothing in the
 * fact set can be consulted to decide it. So this file starts again from the
 * type, and the rule it enforces is:
 *
 *   ⛔ A CLAIM IS EXPRESSIBLE ONLY IF A FACT OF THE MATCHING KIND BACKS IT.
 *
 * "is the largest" needs a `rank` fact whose value is 1. "has been rising since
 * July" needs a `trend` fact with a direction and a window. A sentence that
 * makes a relational claim with no fact of that kind behind it is not a warning
 * and not a lower-confidence rendering — it is a rejection.
 *
 * The second rule is that `display` is DERIVED here rather than accepted from a
 * caller, so the words and the number cannot drift apart. That is the same move
 * `budget-verdict` made after a headline and its own explanation disagreed at
 * exactly 100%: make the drift unrepresentable rather than fix an instance of
 * it.
 */

/**
 * What a fact is a fact ABOUT — which determines which claims can bind to it.
 *
 * - `scalar` — one measured quantity ($1,963.24 of Dining)
 * - `count`  — how many of something (502 purchases)
 * - `share`  — a part of a stated whole (32.3% of everything owned)
 * - `rank`   — a position in a stated ordering (1st of 22 categories)
 * - `delta`  — a signed change between two stated points (+$3,053.26, Jun→Jul)
 * - `trend`  — a direction over a stated window with a stated number of points
 * - `multiple` — how many times a stated other quantity something is (4.2×)
 */
export type FactKind = "scalar" | "count" | "share" | "rank" | "delta" | "trend" | "multiple";

/** How a scalar or delta renders. Chosen by the caller; APPLIED here. */
export type FactUnit = "money" | "percent" | "days" | "months" | "plain";

interface FactBase {
  /** slot name as it appears in a sentence: `f1`, `f2`, … */
  readonly id: string;
  /**
   * What the fact is about, in the app's own words — a category name, a month,
   * an account. Rendered as-is, so it must already be a real label from the
   * ledger and never a model-supplied string.
   */
  readonly subject: string;
  /** the app's own formatting of `value`, derived — never passed in */
  readonly display: string;
}

export interface ScalarFact extends FactBase {
  readonly kind: "scalar";
  readonly value: number;
  readonly unit: FactUnit;
}

export interface CountFact extends FactBase {
  readonly kind: "count";
  readonly value: number;
  /** what is being counted, singular — "purchase", "day", "account" */
  readonly noun: string;
  /**
   * The window it was counted over, as a prepositional phrase — "in Jul 2026",
   * "since the account opened". See `countFact` for what read wrong without it.
   */
  readonly within: string;
}

export interface ShareFact extends FactBase {
  readonly kind: "share";
  /** 0–1. A share above 1 is a bug in the caller, not a big share. */
  readonly value: number;
  /** the whole this is a share OF, named so the sentence can say it */
  readonly ofLabel: string;
}

export interface RankFact extends FactBase {
  readonly kind: "rank";
  /** 1-based position. 1 means largest/first. */
  readonly value: number;
  /** how many were ranked — a rank of 1 out of 1 is not a finding */
  readonly outOf: number;
  /** the set that was ranked — "spending categories", "accounts" */
  readonly amongLabel: string;
}

export interface DeltaFact extends FactBase {
  readonly kind: "delta";
  /** signed: negative means it fell */
  readonly value: number;
  readonly unit: FactUnit;
  readonly fromLabel: string;
  readonly toLabel: string;
  /**
   * The same quantity WITHOUT its sign — "$42.00", never "-$42.00".
   *
   * ⛔ This exists because a delta is the one kind whose direction gets stated
   * TWICE. `display` is signed and must stay signed: it is documented as the
   * app's own formatting of `value`, and `value` is signed. But every template
   * that prints a delta already says which way it went — `rose_between`,
   * `fell_between`, and `unchanged_between` (which prints no figure at all) are
   * the whole delta vocabulary — so printing `display` inside one produced
   * **"Travel fell by -$42.00 between June and July"**, a double negative that
   * shipped on three surfaces before anyone read it aloud.
   *
   * So the fact keeps the honest signed rendering of its own value, and the
   * GRAMMAR decides that a sentence stating a direction prints the magnitude.
   * That decision lives in `factField`, beside the same choice already made for
   * a trend, and `assertTemplatesWellFormed` refuses a delta template that does
   * not pin its direction with a `holds` predicate.
   */
  readonly magnitude: string;
}

export interface TrendFact extends FactBase {
  readonly kind: "trend";
  readonly direction: "rising" | "falling" | "flat";
  /** where the window starts, in the app's words — "July", "Feb 2026" */
  readonly sinceLabel: string;
  /**
   * How many observations the direction was read from. Two points are a line
   * through two points, not a trend; `trendFact` refuses fewer than three.
   */
  readonly points: number;
}

export interface MultipleFact extends FactBase {
  readonly kind: "multiple";
  /** how many times `ofLabel` this is; 1 means "the same as" */
  readonly value: number;
  /** what it is a multiple OF, named so the sentence can say it */
  readonly ofLabel: string;
}

export type Fact = ScalarFact | CountFact | ShareFact | RankFact | DeltaFact | TrendFact | MultipleFact;

/** Every fact in a set, by slot id. Built by `factSet`, which enforces the ids. */
export type FactSet = ReadonlyMap<string, Fact>;

const SLOT_PATTERN = /^f[1-9][0-9]*$/;

function assertSlotId(id: string): void {
  if (!SLOT_PATTERN.test(id)) {
    throw new Error(`Fact id must look like "f1", got ${JSON.stringify(id)}`);
  }
}

/**
 * `subject` and the various labels are rendered verbatim into a sentence, so
 * they are the one place a caller could smuggle markup or a fake figure into an
 * insight. They come from the ledger — a category name, a month — and this
 * module is downstream of every caller, so it checks rather than assuming.
 *
 * Digits are allowed: "Feb 2026" and "SoFi 9067" are real labels. What is
 * refused is anything that could open a tag, an entity or a slot.
 *
 * ⛔ The rule itself lives in `printable-name`, imported rather than restated.
 *
 * It has to be enforced in two other places this module cannot reach — the
 * write boundaries that accept a name from a person or a model, and the
 * surfaces that must DECLINE to speak about a name a bank printed — and three
 * copies of one character class is how they drift apart. `printable-name`'s
 * header carries the reasoning for the set.
 */
function assertLabel(what: string, value: string): void {
  if (value.trim() === "") throw new Error(`Fact ${what} cannot be empty`);
  if (UNPRINTABLE_NAME_CHARS.test(value)) {
    throw new Error(`Fact ${what} cannot contain < > { } or a backslash: ${JSON.stringify(value)}`);
  }
}

/**
 * Render a magnitude the way the rest of the app renders it.
 *
 * `signed` is separate from the unit because a scalar and a delta of the same
 * unit print differently on purpose: $120 of spending is "$120.00", a change of
 * $120 is "+$120.00". A delta that dropped its sign would read as a rise.
 *
 * The sign is an ASCII hyphen, matching `formatCentsSigned` exactly — a typographic
 * minus would survive NFKC normalisation as a DIFFERENT character from the one
 * the money formatter emits, and the validator compares these renderings for
 * equality.
 */
function render(value: number, unit: FactUnit, signed: boolean): string {
  // zero is not an increase — `formatCentsSigned` drops the sign there and every
  // other unit follows it, so "+0.0%" can never claim a rise that did not happen
  const sign = !signed || value === 0 ? "" : value < 0 ? "-" : "+";
  switch (unit) {
    case "money":
      return signed ? formatCentsSigned(value) : formatCents(value);
    case "percent":
      return `${sign}${renderPercent(Math.abs(value))}`;
    case "days":
    case "months": {
      const n = Math.abs(value);
      const noun = n === 1 ? unit.slice(0, -1) : unit;
      return `${sign}${Number.isInteger(n) ? n : n.toFixed(1)} ${noun}`;
    }
    case "plain": {
      const n = Math.abs(value);
      return `${sign}${Number.isInteger(n) ? n : n.toFixed(1)}`;
    }
  }
}

export function scalarFact(id: string, subject: string, value: number, unit: FactUnit): ScalarFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  if (!Number.isFinite(value)) throw new Error("A scalar fact needs a finite value");
  return { kind: "scalar", id, subject, value, unit, display: render(value, unit, false) };
}

/**
 * @param withinLabel the window the count was taken over, as a prepositional
 * phrase — "in Jul 2026", "since the account opened".
 *
 * 🔴 REQUIRED, because the sentence built from this fact reads as a standing
 * claim about the ledger without it. `count_in_subject` rendered "94
 * transactions landed in Food." over a count measured on ONE month: Food holds
 * 94 rows in Jul 2026 and 2,735 all time, so read alone it is off by 29×.
 * Measured 2026-09-10 across the 12 category pages that render the panel,
 * every one showed its own month's count with no window — Housing 7/34,
 * Transport 28/728, Health 1/138 — and /spending printed one more. Its two
 * siblings, built from the same facts array in the same call, both carry the
 * window: `rankFact`'s `amongLabel` ("spending categories in Jul 2026") and
 * `shareFact`'s `ofLabel` ("everything you spent in Jul 2026"). The module's
 * own ⛔ comment says why — "a superlative with no window reads as a standing
 * fact about the ledger" — and this fact was the one it never reached.
 */
export function countFact(
  id: string,
  subject: string,
  value: number,
  noun: string,
  withinLabel: string,
): CountFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("noun", noun);
  assertLabel("withinLabel", withinLabel);
  if (!Number.isInteger(value) || value < 0) throw new Error("A count fact needs a non-negative integer");
  return {
    kind: "count",
    id,
    subject,
    value,
    noun,
    within: withinLabel,
    display: `${value.toLocaleString("en-US")} ${value === 1 ? noun : `${noun}s`}`,
  };
}

export function shareFact(id: string, subject: string, value: number, ofLabel: string): ShareFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("ofLabel", ofLabel);
  /*
   * A share outside 0–1 is a caller bug every time — a percentage passed as 32.3
   * instead of 0.323 would render "3230.0%" and back a "more than half" claim
   * that is arithmetically impossible. Refused rather than clamped, because
   * clamping would turn the bug into a plausible-looking sentence.
   */
  if (!(value >= 0 && value <= 1)) throw new Error(`A share must be within 0–1, got ${value}`);
  return { kind: "share", id, subject, value, ofLabel, display: render(value, "percent", false) };
}

/**
 * "4.2×" — how many times some other stated quantity this is.
 *
 * ⛔ Refuses a non-positive multiple rather than rendering "0.0×" or "-3.1×".
 * A multiple is a ratio of two magnitudes, and a caller producing one at or
 * below zero has divided by something that was not a magnitude — most often a
 * median that netted to zero across refunds. Refusing is how that surfaces as a
 * throw in a service test rather than as a sentence on his dashboard.
 */
export function multipleFact(id: string, subject: string, value: number, ofLabel: string): MultipleFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("ofLabel", ofLabel);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`A multiple must be above zero, got ${value}`);
  return { kind: "multiple", id, subject, value, ofLabel, display: `${value.toFixed(1)}×` };
}

export function rankFact(id: string, subject: string, value: number, outOf: number, amongLabel: string): RankFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("amongLabel", amongLabel);
  if (!Number.isInteger(value) || value < 1) throw new Error("A rank starts at 1");
  if (!Number.isInteger(outOf) || outOf < value) throw new Error("A rank cannot exceed the size of its set");
  /*
   * The display is the ordinal ALONE — "3rd", not "3rd of 22". The set size is
   * the fact's frame of reference and belongs in `of`, which is what a template
   * reads when it needs it. Carrying it in both places produced
   * "sits 1st of 2 of your 2 spending categories" the first time a template
   * used them together.
   */
  return { kind: "rank", id, subject, value, outOf, amongLabel, display: ordinal(value) };
}

export function deltaFact(
  id: string,
  subject: string,
  value: number,
  unit: FactUnit,
  fromLabel: string,
  toLabel: string,
): DeltaFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("fromLabel", fromLabel);
  assertLabel("toLabel", toLabel);
  if (!Number.isFinite(value)) throw new Error("A delta fact needs a finite value");
  return {
    kind: "delta",
    id,
    subject,
    value,
    unit,
    fromLabel,
    toLabel,
    display: render(value, unit, true),
    // derived from the same formatter as `display`, never by stripping a
    // character off it — a second way to render one number is how the two
    // drift apart, which is the whole reason `display` is derived here at all
    magnitude: render(Math.abs(value), unit, false),
  };
}

export function trendFact(
  id: string,
  subject: string,
  direction: TrendFact["direction"],
  sinceLabel: string,
  points: number,
): TrendFact {
  assertSlotId(id);
  assertLabel("subject", subject);
  assertLabel("sinceLabel", sinceLabel);
  /*
   * ⛔ Three points, not two. Any two observations define a direction, so a
   * two-point "trend" is a tautology dressed as a finding — and "has been
   * climbing since July" was one of the strings that got this feature held. If
   * the ledger has two months, the honest sentence is a `delta`, which says
   * exactly what changed between two named points and claims nothing about the
   * shape between them.
   */
  if (!Number.isInteger(points) || points < 3) {
    throw new Error(`A trend needs at least 3 observations, got ${points}`);
  }
  const word = direction === "flat" ? "flat" : direction;
  return {
    kind: "trend",
    id,
    subject,
    direction,
    sinceLabel,
    points,
    display: `${word} across ${points} months since ${sinceLabel}`,
  };
}

/**
 * A percentage that never rounds a real quantity away, in either direction.
 *
 * ⛔ `$4.24 of $10,240.85` is 0.041%, and `toFixed(1)` prints it as "0.0%" —
 * a sentence asserting a measured zero about money that was really spent. The
 * mirror case is worse: 99.96% prints as "100.0%" and claims the whole of
 * something it does not account for. Both were on screen before this existed.
 *
 * 🔴 …AND SIX MORE SURFACES WENT ON DOING IT, because this was private to the
 * insight layer. Measured 2026-09-10: "Health · 1 entry · 0.0% · $4.24" in
 * /spending's table lens and again in its sankey link name; "0.0% of held" on
 * SoFi Savings ($0.10) and SoFi Checking ($0.01); WMT at $44.98 printed "0.0%"
 * twice on /investments; "Money in → Gifts & Donations · $10.43 · 0.0%".
 * Every one of those is money that really moved.
 *
 * The `<` and `>` here are the ONLY place a display carries them. Labels forbid
 * both (`FORBIDDEN_IN_LABEL`) because a label could otherwise open a tag; a
 * display is written by this module, never by a caller or a model, and React
 * escapes it as a text node.
 *
 * @param magnitude 0–1, not 0–100 — `sharePercent` takes the other framing.
 */
export function renderPercent(magnitude: number): string {
  const pct = magnitude * 100;
  if (pct > 0 && pct < 0.05) return "<0.1%";
  if (pct < 100 && pct >= 99.95) return ">99.9%";
  return `${pct.toFixed(1)}%`;
}

/** The same rule for callers holding an already-scaled 0–100 figure. */
export function sharePercent(pct: number): string {
  return renderPercent(pct / 100);
}

/**
 * A category's share of a period's spending — or the REASON it has none.
 *
 * 🔴 The other half of `renderPercent`'s rule. That one stops a real quantity
 * rounding away to "0.0%"; this one stops a quantity that moved the OTHER way
 * being CLAMPED to it. Every share of spending divides `Math.max(0, spentCents)`
 * by the period's positive spend, which is right for a WIDTH — a refunded
 * category legitimately has no footprint — and manufactures an exact zero for
 * the sentence beside it. "0.0%" is reserved, by construction and by this
 * module's own tests, for an exact zero.
 *
 * Measured on the real ledger, 2026-09-11, in all three lenses of one card:
 *
 *     /spending?period=2024-05          "Shopping · 0.0% · -$1,605.11"
 *     …&where=table                     "Shopping · 12 · 0.0% · -$1,605.11"
 *     …&where=relief                    "0.0% … -$1,544.58"
 *     /spending?period=2025-02           the Gambling row, the same way
 *
 * ⛔ The app's own accounts table already refuses this and names the reason —
 * "in credit — no share of the debt", "overdrawn — no share of what is held"
 * (`AccountsTable.tsx:487`, out of `side-magnitude`'s doctrine). The spending
 * card printed the zero.
 *
 * The share cell is 40px wide on the list lens, so the refusal is a dash and
 * the reason is its `title` — an attribute a screen reader reads and
 * `read-surface` prints. A bare dash asserting nothing still beats a figure
 * asserting something false.
 */
export function spendingShare(
  spentCents: number,
  sharePct: number,
  /**
   * How many categories the figure sums. The relief folds its tail into one
   * "N smaller categories" block, and the refusal first said "this category"
   * of it — the only refusal the relief rendered anywhere on the ledger was on
   * exactly that aggregate. A bundle netting money back says so in the plural.
   */
  memberCount = 1,
): { label: string; title: string | null } {
  if (spentCents < 0) {
    return {
      label: "—",
      title:
        memberCount > 1
          ? `took no share of spending — together these ${memberCount} categories netted money back`
          : "took no share of spending — this category netted money back",
    };
  }
  return { label: sharePercent(sharePct), title: null };
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Assemble a fact set, refusing duplicate slots.
 *
 * A duplicate `f1` would make a sentence's meaning depend on map insertion
 * order — two different claims about two different subjects rendering through
 * the same slot — which is precisely the kind of ambiguity this whole module
 * exists to make impossible.
 */
export function factSet(facts: readonly Fact[]): FactSet {
  const map = new Map<string, Fact>();
  for (const f of facts) {
    if (map.has(f.id)) throw new Error(`Duplicate fact slot ${f.id}`);
    map.set(f.id, f);
  }
  return map;
}
