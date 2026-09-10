import { describe, expect, test } from "vitest";
import { countFact, deltaFact, multipleFact, rankFact, scalarFact, shareFact, trendFact } from "./insight-facts";
import {
  CLAIMS,
  CLAIMS_BY_ID,
  CLAIM_IDS,
  SLOT_RE,
  assertTemplatesWellFormed,
  factField,
  slotsAgree,
  type ClaimTemplate,
} from "./insight-grammar";

describe("the three fields a template can read", () => {
  const rank = rankFact("f1", "Dining", 3, 22, "spending categories");
  const share = shareFact("f2", "Eating out", 0.101, "everything you spend");
  const delta = deltaFact("f3", "Travel", 99800, "money", "June", "July");
  const trend = trendFact("f4", "Dining", "rising", "March", 6);
  const count = countFact("f5", "Dining", 502, "purchase", "in Jul 2026");
  const scalar = scalarFact("f6", "Dining", 196324, "money");
  const multiple = multipleFact("f7", "This Target charge", 21.8, "your usual charge there");

  test("name is the subject, always", () => {
    for (const f of [rank, share, delta, trend, count, scalar, multiple]) {
      expect(factField(f, "name")).toBe(f.subject);
    }
  });

  test("of names the frame the measurement only means anything inside", () => {
    expect(factField(rank, "of")).toBe("22 spending categories");
    expect(factField(share, "of")).toBe("everything you spend");
    expect(factField(delta, "of")).toBe("June and July");
    /*
     * ⛔ The MAGNITUDE, not the signed display. Every delta template already
     * states the direction, so `display` inside one read "fell by -$42.00" —
     * a double negative that shipped on three surfaces. The fact keeps its
     * honest signed rendering; the grammar prints the unsigned one.
     */
    expect(factField(delta, "value")).toBe("$998.00");
    expect(delta.display).toBe("+$998.00");
    const fell = deltaFact("f8", "Travel", -99800, "money", "June", "July");
    expect(factField(fell, "value")).toBe("$998.00");
    expect(fell.display).toBe("-$998.00");
    expect(factField(trend, "of")).toBe("March");
    /* 🔴 the WINDOW, not the noun. No template bound a count's frame of
       reference until `count_in_subject` needed one, and the noun was never a
       frame — it is what `display` already prints. The sentence read "94
       transactions landed in Food." over a count measured on ONE month. */
    expect(factField(count, "of")).toBe("in Jul 2026");
    expect(factField(multiple, "of")).toBe("your usual charge there");
  });

  test("a scalar has no frame, and asking for one fails loudly", () => {
    // rendering "undefined" onto a page is the failure this replaces
    expect(() => factField(scalar, "of")).toThrow(/no frame of reference/);
  });

  test("a trend's value is its window — it has no other number", () => {
    expect(factField(trend, "value")).toBe("6 months");
    expect(factField(scalar, "value")).toBe("$1,963.24");
    expect(factField(rank, "value")).toBe("3rd");
  });
});

describe("the vocabulary is closed and self-consistent", () => {
  test("every claim id is unique", () => {
    expect(new Set(CLAIM_IDS).size).toBe(CLAIM_IDS.length);
    expect(CLAIMS_BY_ID.size).toBe(CLAIMS.length);
  });

  test("the shipped vocabulary passes its own import-time check", () => {
    // it already ran at import; calling it again states the guarantee out loud
    expect(() => assertTemplatesWellFormed(CLAIMS)).not.toThrow();
  });

  test("every claim with a predicate says why, so a refusal can be read", () => {
    for (const claim of CLAIMS) {
      if (claim.holds) expect(claim.why, claim.id).toBeTruthy();
    }
  });

  /**
   * ⛔ The neutrality sweep. The owner travels and drives an EV, and three
   * charges once flagged as "card-testing probes" were all legitimate — so a
   * template that advised, judged or accused would be wrong about him
   * personally, not merely off-tone. Checked over the FIXED words, which are
   * the only words the app itself chooses.
   */
  test("no template advises, judges or accuses", () => {
    const forbidden =
      /\b(should|must|need to|try to|consider|too much|too many|excessive|only|just|surprisingly|worryingly|unusual|suspicious|fraud|good|bad|better|worse|healthy|unhealthy|overspend)\b/i;
    for (const claim of CLAIMS) {
      const words = claim.template.replace(new RegExp(SLOT_RE.source, "gu"), " ");
      expect(forbidden.test(words), `${claim.id}: ${claim.template}`).toBe(false);
    }
  });

  test("every fact kind can say at least one thing", () => {
    const covered = new Set(CLAIMS.map((c) => c.binds.a));
    for (const kind of ["scalar", "count", "share", "rank", "delta", "trend", "multiple"] as const) {
      expect(covered.has(kind), `nothing can be said about a ${kind} fact`).toBe(true);
    }
  });
});

describe("the cross-slot rule", () => {
  test("one fact always agrees with itself", () => {
    expect(slotsAgree(scalarFact("f1", "Dining", 1, "money"), undefined)).toBe(true);
  });

  test("two facts agree only about the same subject", () => {
    const a = rankFact("f1", "Dining", 1, 22, "categories");
    expect(slotsAgree(a, scalarFact("f2", "Dining", 1, "money"))).toBe(true);
    expect(slotsAgree(a, scalarFact("f2", "Groceries", 1, "money"))).toBe(false);
  });
});

/**
 * ⛔ The import-time check, driven with tables that are deliberately broken.
 *
 * Every one of these was once a branch inside the renderer, reached by no
 * possible input and therefore never executed. They are mistakes a person makes
 * while WRITING a template, so they belong at import — and the only way to know
 * this check works is to hand it the mistakes.
 */
describe("a malformed vocabulary fails at import, not at render", () => {
  const claim = (over: Partial<ClaimTemplate>): ClaimTemplate =>
    ({ id: "x", template: "{{a.name}} came to {{a.value}}.", binds: { a: "scalar" }, ...over }) as ClaimTemplate;
  const bad = (over: Partial<ClaimTemplate>) => () => assertTemplatesWellFormed([claim(over)]);

  test("a slot the claim does not bind", () => {
    expect(bad({ template: "{{a.name}} is bigger than {{b.name}}." })).toThrow(/does not bind/);
  });

  test("a frame of reference read off a scalar", () => {
    expect(bad({ template: "{{a.name}} came to {{a.value}} of {{a.of}}." })).toThrow(/frame of reference/);
  });

  test("a sentence that reads no facts at all", () => {
    expect(bad({ template: "Spending went up." })).toThrow(/reads no facts/);
  });

  test("a second fact that no slot reads", () => {
    expect(bad({ binds: { a: "scalar", b: "scalar" } })).toThrow(/no slot reads/);
  });

  test("a figure written into the words", () => {
    expect(bad({ template: "{{a.name}} came to {{a.value}} across 6 months." })).toThrow(/figure of its own/);
  });

  test("two sentences pretending to be one claim", () => {
    expect(bad({ template: "{{a.name}} came to {{a.value}}. That is a lot." })).toThrow(/exactly one sentence/);
    expect(bad({ template: "{{a.name}} came to {{a.value}}" })).toThrow(/exactly one sentence/);
  });

  /**
   * ⛔ A delta prints an UNSIGNED magnitude, so the sentence is the only thing
   * left saying which way it went. A template that accepts either direction
   * would print "Travel moved by $42.00" over a rise and a fall alike — and
   * nothing downstream would notice, because the gate would accept it and the
   * sentence would simply be ambiguous. `holds` is what pins it.
   */
  test("a delta template that does not pin its direction", () => {
    expect(bad({ binds: { a: "delta" } })).toThrow(/direction is unpinned/);
    expect(bad({ template: "{{a.name}} is bigger than {{b.value}}.", binds: { a: "scalar", b: "delta" } })).toThrow(
      /direction is unpinned/,
    );
    // …and one that DOES pin it passes
    expect(bad({ binds: { a: "delta" }, holds: (a) => a.kind === "delta" && a.value > 0 })).not.toThrow();
  });

  /** Every delta claim the app actually ships pins its direction. */
  test("the shipped vocabulary already satisfies it", () => {
    for (const c of CLAIMS) {
      if (c.binds.a === "delta" || c.binds.b === "delta") expect(c.holds, c.id).toBeTruthy();
    }
  });
});
