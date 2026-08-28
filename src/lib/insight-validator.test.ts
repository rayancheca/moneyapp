import { describe, expect, test } from "vitest";
import {
  countFact,
  deltaFact,
  factSet,
  rankFact,
  scalarFact,
  shareFact,
  trendFact,
  type Fact,
} from "./insight-facts";
import { checkClaim, containsFigure, normalizeForCheck, validateProse } from "./insight-validator";

/*
 * The fact set every attack is fired at. Deliberately shaped like the one
 * /spending will build, and deliberately containing the trap from the record:
 *
 *   f1  Dining is the THIRD largest category, not the largest.
 *
 * That single number is what made pass 46's validator accept
 * "{{f1}} is your largest spending category" — with no machine-readable rank
 * there was nothing to consult, so the sentence was not merely unchecked, it
 * was uncheckable.
 */
const FACTS = factSet([
  rankFact("f1", "Dining", 3, 22, "spending categories"),
  scalarFact("f2", "Dining", 196324, "money"),
  shareFact("f3", "Eating out", 0.101, "everything you spend"),
  countFact("f4", "Dining", 502, "purchase"),
  deltaFact("f5", "Travel", 99800, "money", "June", "July"),
  rankFact("f6", "Groceries", 1, 22, "spending categories"),
  scalarFact("f7", "Groceries", 19422, "money"),
  trendFact("f8", "Dining", "rising", "March", 6),
]);

/**
 * ⛔ PASS 46'S VALIDATOR, restated so the improvement stays measurable.
 *
 * Its whole design: every figure reaches the model as an opaque `{{fN}}` slot,
 * the app substitutes the real display afterwards, and the finished text is
 * scanned for digits the model must therefore have invented. It is a perfectly
 * sound guard against fabricated NUMBERS — and the reason this file exists is
 * that fabricated numbers were never the interesting failure.
 *
 * Kept here rather than deleted so the attack suite proves something. A suite
 * that only ever runs against the new validator cannot distinguish "these
 * attacks are hard" from "these attacks are trivial"; running both makes the
 * difference a number the test prints.
 */
function naiveValidate(text: string, facts: ReadonlyMap<string, Fact>): boolean {
  const substituted = text.replace(/\{\{(f[0-9]+)\}\}/g, (m, id: string) => facts.get(id)?.display ?? m);
  let outsideSlots = substituted;
  for (const f of facts.values()) outsideSlots = outsideSlots.split(f.display).join("");
  // the original bug verbatim: no `u` flag, so `½` is not a digit
  return !/\d/.test(outsideSlots);
}

interface Attack {
  readonly text: string;
  readonly why: string;
  /** true for the three strings recorded verbatim in the pass-46 postmortem */
  readonly recorded?: boolean;
  /**
   * What pass 46's validator does with this string — MEASURED, not guessed.
   * Stated per attack rather than as an aggregate so that adding an attack
   * forces a claim about the old design too; an aggregate would drift silently.
   */
  readonly naiveAccepts: boolean;
}

/**
 * The strings this feature has to refuse.
 *
 * ⚠️ Three of these are the ones the pass-46 handoff quoted verbatim
 * (`recorded: true`). The other fourteen of that original seventeen were not
 * written down anywhere — the record kept the COUNT and the three examples, not
 * the list. The rest below are new, written against the failure classes the
 * postmortem named plus the ones the rewrite itself suggested. Saying so
 * matters: pretending to have restored a list that no longer exists would be
 * the same kind of unsourced claim this module is built to refuse.
 */
const ATTACKS: readonly Attack[] = [
  // ── the three from the record ────────────────────────────────────────
  {
    text: "{{f1}} is your largest spending category.",
    why: "f1 is the third largest",
    naiveAccepts: true,
    recorded: true,
  },
  {
    text: "{{f1}} has been climbing since July.",
    why: "invented trend and invented date",
    naiveAccepts: true,
    recorded: true,
  },
  {
    text: "{{f1}} used about ½ of its plan.",
    why: "a vulgar fraction is a figure; /\\d/ without the u flag does not see it",
    naiveAccepts: true,
    recorded: true,
  },
  // ── fabricated ORDERINGS ────────────────────────────────────────────
  {
    text: "Dining is the largest of your 22 spending categories, at $1,963.24.",
    why: "our exact wording, our exact figures, and f1 ranks Dining third",
    naiveAccepts: false,
  },
  {
    text: "Dining is the biggest of your 22 spending categories, at $1,963.24.",
    why: "'biggest' is a synonym no denylist would have held, and it is not in the vocabulary",
    naiveAccepts: false,
  },
  {
    text: "Dining is the largest of your 22 accounts, at $1,963.24.",
    why: "'accounts' is not the set that was ranked",
    naiveAccepts: false,
  },
  // ── fabricated TRENDS and PROJECTIONS ───────────────────────────────
  {
    text: "Groceries has risen across 6 months since March.",
    why: "the trend fact is about Dining; Groceries has no trend fact at all",
    naiveAccepts: false,
  },
  {
    text: "Dining has fallen across 6 months since March.",
    why: "the trend fact says rising",
    naiveAccepts: false,
  },
  {
    text: "Dining will reach $2,400.00 next month.",
    why: "a projection — no fact kind can support a claim about the future",
    naiveAccepts: false,
  },
  // ── fabricated DIRECTION ────────────────────────────────────────────
  {
    text: "Travel fell by +$998.00 between June and July.",
    why: "the delta is positive",
    naiveAccepts: true,
  },
  {
    text: "Travel did not move between June and July.",
    why: "the delta is +$998.00",
    naiveAccepts: true,
  },
  // ── fabricated MAGNITUDE relations ──────────────────────────────────
  {
    text: "Eating out is more than half of everything you spend, at 10.1%.",
    why: "10.1% is not more than half",
    naiveAccepts: true,
  },
  {
    text: "Dining is 10.1× Groceries.",
    why: "nothing in the fact set measures a ratio between two categories",
    naiveAccepts: false,
  },
  // ── BORROWED figures: every token real, the combination invented ────
  {
    text: "Groceries is the largest of your 22 spending categories, at $1,963.24.",
    why: "the rank is Groceries', the money is Dining's — one sentence, two subjects",
    naiveAccepts: false,
  },
  {
    text: "Dining came to $194.22.",
    why: "$194.22 is Groceries' total",
    naiveAccepts: true,
  },
  // ── CHARACTER tricks ────────────────────────────────────────────────
  {
    text: "Dining came to ＄１９４．２２.",
    why: "fullwidth forms fold to $194.22, which is GROCERIES' total — folding must not manufacture truth",
    naiveAccepts: true,
  },
  {
    text: "Dining came to $1,963.24²",
    why: "a superscript riding on a real figure",
    naiveAccepts: true,
  },
  // ── JUDGEMENT, ADVICE and ACCUSATION ────────────────────────────────
  {
    text: "Dining came to $1,963.24, which is too much.",
    why: "a verdict on his spending — the notice describes, it never judges",
    naiveAccepts: true,
  },
  {
    text: "You should cut back on Dining.",
    why: "advice",
    naiveAccepts: true,
  },
  {
    text: "Dining came to $1,963.24, more than most people spend.",
    why: "a comparison to a population this app has never measured",
    naiveAccepts: true,
  },
  {
    text: "These charges look like card testing.",
    why: "an accusation; three such flags were once raised on his ledger and all three were legitimate",
    naiveAccepts: true,
  },
  // ── CAUSATION ───────────────────────────────────────────────────────
  {
    text: "Travel rose by +$998.00 between June and July because of your trip.",
    why: "a cause; a delta measures change, never its reason",
    naiveAccepts: true,
  },
  // ── INJECTION ───────────────────────────────────────────────────────
  {
    text: "Dining came to <b>$1,963.24</b>.",
    why: "markup",
    naiveAccepts: true,
  },
  {
    text: "Dining came to {{f7.value}}.",
    why: "an unrendered slot reaching the reader",
    naiveAccepts: false,
  },
  {
    text: "",
    why: "empty text is not a claim",
    naiveAccepts: true,
  },
];

describe("the attack suite", () => {
  /*
   * ⛔ This is the assertion that makes the rest of the file mean something. If
   * the attacks were easy, a validator that did nothing would pass them, and
   * "24 of 24 refused" would be worth nothing. Running pass 46's own validator
   * over the same list shows how far most of them get: it is the red the suite
   * had to start from, preserved rather than described.
   */
  test("pass 46's validator accepts 16 of these — that is why this file exists", () => {
    for (const a of ATTACKS) {
      expect(naiveValidate(a.text, FACTS), `${a.text} — ${a.why}`).toBe(a.naiveAccepts);
    }
    // the aggregate, so the headline figure is asserted and not merely narrated
    expect(ATTACKS.filter((a) => a.naiveAccepts)).toHaveLength(16);
    // and every one of the three the record kept is among them
    expect(ATTACKS.filter((a) => a.recorded).every((a) => a.naiveAccepts)).toBe(true);
  });

  /*
   * ⚠️ The nine it DOES catch are the ones written as finished prose containing
   * a bare figure — "22 spending categories" is nine characters of digits
   * outside any slot. That is not the old design working; it is the old design
   * being handed input it was never given. Pass 46's model emitted SLOT form,
   * which is why the three recorded strings are in slot form here and why the
   * new ones are not: each is written in the form the gate that sees it
   * actually receives.
   */

  test.each(ATTACKS.map((a) => [a.text || "(empty string)", a] as const))("refuses %s", (_label, attack) => {
    const verdict = validateProse(attack.text, FACTS);
    expect(verdict.ok, `${attack.text} — ${attack.why}`).toBe(false);
  });

  test("every refusal carries a reason a developer can act on", () => {
    for (const a of ATTACKS) {
      const v = validateProse(a.text, FACTS);
      expect(v.ok).toBe(false);
      if (v.ok) continue;
      expect(v.reason.length).toBeGreaterThan(10);
    }
  });

  test("the ones that use our exact wording are refused for the FACTS, not the words", () => {
    // this is the whole point: same sentence, wrong subject
    const v = validateProse("Dining is the largest of your 22 spending categories, at $1,963.24.", FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unsupported-claim");
    expect(v.reason).toContain("1st among at least two");
  });

  test("a borrowed figure is refused even when both halves are ours", () => {
    // the rank is Groceries', the money is Dining's; nothing here is invented
    const v = validateProse("Groceries is the largest of your 22 spending categories, at $1,963.24.", FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unsupported-claim");
    expect(v.reason).toContain("different subjects");
  });

  test("a borrowed figure is refused as unsourced, not as unsupported", () => {
    const v = validateProse("Dining came to $194.22.", FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unsourced-figure");
  });
});

describe("what the app is allowed to say", () => {
  test("a rank of 1 renders, and names the set it was ranked in", () => {
    const v = checkClaim({ claimId: "largest_in_set", a: "f6", b: "f7" }, FACTS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Groceries is the largest of your 22 spending categories, at $194.22.");
    expect(v.factIds).toEqual(["f6", "f7"]);
  });

  test("the same claim on a third-place fact is refused", () => {
    const v = checkClaim({ claimId: "largest_in_set", a: "f1", b: "f2" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unsupported-claim");
  });

  test("a third-place fact can still say where it sits", () => {
    const v = checkClaim({ claimId: "ranked_in_set", a: "f1", b: "f2" }, FACTS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Dining is the 3rd largest of your 22 spending categories, at $1,963.24.");
  });

  /*
   * The other half of the NFKC decision, and the reason folding is safe.
   *
   * A true claim written in fullwidth glyphs is still that true claim, and the
   * read gate answers with the app's OWN rendering rather than echoing what it
   * was handed. So folding can canonicalise a sentence but can never promote a
   * false one — `＄１９４．２２` folds to a real figure that belongs to a
   * different subject and is refused two lines above.
   */
  test("a true claim in the wrong glyphs comes back in the app's own words", () => {
    const v = validateProse("Ｄｉｎｉｎｇ ｃａｍｅ ｔｏ ＄１，９６３．２４.", FACTS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Dining came to $1,963.24.");
    // nothing fullwidth reaches the reader
    expect(/[！-～]/u.test(v.text)).toBe(false);
  });

  test("every accepted sentence survives the read gate it was written by", () => {
    // the two gates must agree, or an insight could be written and then refused
    // at render time — which would be a blank section with no explanation
    const written = [
      checkClaim({ claimId: "largest_in_set", a: "f6", b: "f7" }, FACTS),
      checkClaim({ claimId: "share_of_whole", a: "f3" }, FACTS),
      checkClaim({ claimId: "count_in_subject", a: "f4" }, FACTS),
      checkClaim({ claimId: "measured_total", a: "f2" }, FACTS),
      checkClaim({ claimId: "rose_between", a: "f5" }, FACTS),
      checkClaim({ claimId: "trend_rising", a: "f8" }, FACTS),
    ];
    for (const w of written) {
      expect(w.ok).toBe(true);
      if (!w.ok) continue;
      const reread = validateProse(w.text, FACTS);
      expect(reread.ok, w.text).toBe(true);
    }
  });
});

describe("checkClaim refuses malformed input before it renders anything", () => {
  test("an unknown claim id", () => {
    const v = checkClaim({ claimId: "is_your_largest", a: "f1" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unknown-wording");
  });

  test("a fact that is not in the set", () => {
    const v = checkClaim({ claimId: "measured_total", a: "f99" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unknown-fact");
  });

  test("the right fact, the wrong kind", () => {
    const v = checkClaim({ claimId: "trend_rising", a: "f1" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("wrong-fact-kind");
  });

  test("a second fact where none is taken", () => {
    const v = checkClaim({ claimId: "measured_total", a: "f2", b: "f7" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("arity");
  });

  test("a missing second fact", () => {
    const v = checkClaim({ claimId: "largest_in_set", a: "f6" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("arity");
  });

  test("a second fact that is in the set but the wrong kind", () => {
    const v = checkClaim({ claimId: "largest_in_set", a: "f6", b: "f4" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("wrong-fact-kind");
  });

  test("a second fact that is not in the set at all", () => {
    const v = checkClaim({ claimId: "largest_in_set", a: "f6", b: "f99" }, FACTS);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unknown-fact");
  });
});

describe("normalisation", () => {
  test("folds the forms a digit scan can be walked around", () => {
    expect(normalizeForCheck("½")).toBe("1⁄2");
    expect(normalizeForCheck("１０")).toBe("10");
    expect(normalizeForCheck("2²")).toBe("22");
    expect(normalizeForCheck("  a   b  ")).toBe("a b");
  });

  test("containsFigure sees what /\\d/ without the u flag does not", () => {
    expect(containsFigure("about ½ of it")).toBe(true);
    expect(containsFigure("１０ things")).toBe(true);
    expect(containsFigure("no numbers here")).toBe(false);
  });
});

describe("the delta and trend claims that need a direction", () => {
  const set = factSet([
    deltaFact("f1", "Travel", -4200, "money", "June", "July"),
    deltaFact("f2", "Rent", 0, "money", "June", "July"),
    trendFact("f3", "Coffee", "falling", "March", 4),
    trendFact("f4", "Rent", "flat", "March", 12),
  ]);

  /**
   * ⛔ "fell by $42.00", never "fell by -$42.00". The word already carries the
   * direction, so the signed rendering made it a double negative — it shipped on
   * three surfaces and reached his year summary before anyone read it aloud. The
   * fact still holds the signed `display`; the GRAMMAR prints the magnitude.
   */
  test("a fall renders as a fall, and says so once", () => {
    const v = checkClaim({ claimId: "fell_between", a: "f1" }, set);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Travel fell by $42.00 between June and July.");
    expect(v.text).not.toContain("-$");
  });

  /** …and a rise does not announce itself twice either. */
  test("a rise renders without a redundant plus", () => {
    const rising = factSet([deltaFact("f1", "Travel", 4200, "money", "June", "July")]);
    const v = checkClaim({ claimId: "rose_between", a: "f1" }, rising);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Travel rose by $42.00 between June and July.");
  });

  /**
   * ⛔ The check that had to pass before the sign could be removed. Direction is
   * pinned by the claim's `holds` predicate against the fact's SIGNED `value`,
   * not by the rendered sign — so an unsigned magnitude cannot let a fabricated
   * direction through, and two deltas of equal magnitude and opposite sign are
   * still told apart.
   */
  test("an unsigned magnitude does not let a fabricated direction through", () => {
    const both = factSet([
      deltaFact("f1", "Travel", -4200, "money", "June", "July"),
      deltaFact("f2", "Travel", 4200, "money", "June", "July"),
    ]);
    // both facts render "$42.00", so only `holds` can separate them
    expect((both.get("f1") as { magnitude: string }).magnitude).toBe(
      (both.get("f2") as { magnitude: string }).magnitude,
    );

    const fell = validateProse("Travel fell by $42.00 between June and July.", both);
    const rose = validateProse("Travel rose by $42.00 between June and July.", both);
    expect(fell.ok).toBe(true);
    expect(rose.ok).toBe(true);
    if (fell.ok) expect(fell.factIds).toEqual(["f1"]);
    if (rose.ok) expect(rose.factIds).toEqual(["f2"]);

    // …and with only the falling fact present, the rise is refused outright
    const fallingOnly = factSet([deltaFact("f1", "Travel", -4200, "money", "June", "July")]);
    expect(validateProse("Travel rose by $42.00 between June and July.", fallingOnly).ok).toBe(false);
  });

  test("a fall cannot be called a rise", () => {
    expect(checkClaim({ claimId: "rose_between", a: "f1" }, set).ok).toBe(false);
  });

  test("an exact zero is neither, and says so", () => {
    const v = checkClaim({ claimId: "unchanged_between", a: "f2" }, set);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.text).toBe("Rent did not move between June and July.");
    expect(checkClaim({ claimId: "rose_between", a: "f2" }, set).ok).toBe(false);
    expect(checkClaim({ claimId: "fell_between", a: "f2" }, set).ok).toBe(false);
  });

  test("falling and flat trends each render only under their own claim", () => {
    const falling = checkClaim({ claimId: "trend_falling", a: "f3" }, set);
    expect(falling.ok).toBe(true);
    if (falling.ok) expect(falling.text).toBe("Coffee has fallen across 4 months since March.");
    const flat = checkClaim({ claimId: "trend_flat", a: "f4" }, set);
    expect(flat.ok).toBe(true);
    if (flat.ok) expect(flat.text).toBe("Rent has held level across 12 months since March.");
    expect(checkClaim({ claimId: "trend_rising", a: "f3" }, set).ok).toBe(false);
    expect(checkClaim({ claimId: "trend_flat", a: "f3" }, set).ok).toBe(false);
  });
});

describe("the claims that refuse a measured zero or a set of one", () => {
  const set = factSet([
    countFact("f1", "Dining", 0, "purchase"),
    rankFact("f2", "Dining", 1, 1, "spending categories"),
    scalarFact("f3", "Dining", 0, "money"),
    shareFact("f4", "Dining", 0.6, "everything you spend"),
    shareFact("f5", "Coffee", 0.5, "everything you spend"),
  ]);

  test("nothing counted is not a finding", () => {
    expect(checkClaim({ claimId: "count_in_subject", a: "f1" }, set).ok).toBe(false);
  });

  test("first of one is not a ranking", () => {
    expect(checkClaim({ claimId: "largest_in_set", a: "f2", b: "f3" }, set).ok).toBe(false);
    expect(checkClaim({ claimId: "ranked_in_set", a: "f2", b: "f3" }, set).ok).toBe(false);
  });

  test("more than half means strictly more than half", () => {
    expect(checkClaim({ claimId: "more_than_half", a: "f4" }, set).ok).toBe(true);
    expect(checkClaim({ claimId: "more_than_half", a: "f5" }, set).ok).toBe(false);
  });
});
