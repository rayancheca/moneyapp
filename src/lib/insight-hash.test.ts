import { describe, expect, test } from "vitest";
import { countFact, rankFact, scalarFact } from "./insight-facts";
import { insightPoolHash, vocabularyVersion } from "./insight-hash";

const POOL = () => ({
  facts: [
    rankFact("f1", "Dining", 1, 22, "spending categories"),
    scalarFact("f2", "Dining", 196_324, "money"),
  ],
  candidates: [{ claimId: "largest_in_set", a: "f1", b: "f2" }],
});

describe("insightPoolHash", () => {
  test("the same pool hashes the same", () => {
    const a = POOL();
    const b = POOL();
    expect(insightPoolHash(a.facts, a.candidates)).toBe(insightPoolHash(b.facts, b.candidates));
  });

  test("a moved figure is a different pool", () => {
    const a = POOL();
    const b = POOL();
    b.facts[1] = scalarFact("f2", "Dining", 196_325, "money"); // one cent
    expect(insightPoolHash(a.facts, a.candidates)).not.toBe(insightPoolHash(b.facts, b.candidates));
  });

  /*
   * ⛔ The reason the whole fact is hashed rather than its rendering. Both of
   * these facts print "1st"; one is 1st of 2 and the other 1st of 20, and a
   * sentence built on them says something different. A hash over `display`
   * alone would serve one page's judgement to the other.
   */
  test("two facts that RENDER the same but are not the same are different pools", () => {
    const a = POOL();
    const b = POOL();
    b.facts[0] = rankFact("f1", "Dining", 1, 2, "spending categories");
    expect(a.facts[0]!.display).toBe(b.facts[0]!.display);
    expect(insightPoolHash(a.facts, a.candidates)).not.toBe(insightPoolHash(b.facts, b.candidates));
  });

  test("a different candidate list is a different question", () => {
    const a = POOL();
    expect(insightPoolHash(a.facts, a.candidates)).not.toBe(
      insightPoolHash(a.facts, [{ claimId: "ranked_in_set", a: "f1", b: "f2" }]),
    );
  });

  test("the ORDER of the candidates is part of the question", () => {
    const facts = [
      rankFact("f1", "Dining", 1, 22, "spending categories"),
      scalarFact("f2", "Dining", 196_324, "money"),
      countFact("f3", "Dining", 12, "transaction"),
    ];
    const one = { claimId: "largest_in_set", a: "f1", b: "f2" };
    const two = { claimId: "count_in_subject", a: "f3" };
    expect(insightPoolHash(facts, [one, two])).not.toBe(insightPoolHash(facts, [two, one]));
  });

  test("a one-slot and a two-slot candidate on the same claim differ", () => {
    const a = POOL();
    expect(insightPoolHash(a.facts, [{ claimId: "largest_in_set", a: "f1", b: "f2" }])).not.toBe(
      insightPoolHash(a.facts, [{ claimId: "largest_in_set", a: "f1" }]),
    );
  });

  test("it is a sha256 hex digest", () => {
    const a = POOL();
    expect(insightPoolHash(a.facts, a.candidates)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("vocabularyVersion", () => {
  test("the live vocabulary has one", () => {
    expect(vocabularyVersion()).toMatch(/^[0-9a-f]{12}$/);
  });

  /*
   * ⛔ Rewording a template must invalidate every selection made when it said
   * something else — an order chosen over sentences the app no longer writes is
   * an answer to a question nobody asked. Read off CLAIMS rather than kept as a
   * constant, because a constant is a thing to forget.
   */
  test("changing a template's WORDS changes the version", () => {
    const before = vocabularyVersion([{ id: "x", template: "{{a.name}} came to {{a.value}}." }]);
    const after = vocabularyVersion([{ id: "x", template: "{{a.name}} totalled {{a.value}}." }]);
    expect(before).not.toBe(after);
  });

  test("adding a claim changes the version", () => {
    const one = [{ id: "x", template: "a." }];
    expect(vocabularyVersion(one)).not.toBe(vocabularyVersion([...one, { id: "y", template: "b." }]));
  });

  test("the version is inside the pool hash, so a vocabulary change invalidates every pool", () => {
    const a = POOL();
    expect(insightPoolHash(a.facts, a.candidates, "aaaaaaaaaaaa")).not.toBe(
      insightPoolHash(a.facts, a.candidates, "bbbbbbbbbbbb"),
    );
    // and the default really is the live vocabulary, not some other constant
    expect(insightPoolHash(a.facts, a.candidates)).toBe(
      insightPoolHash(a.facts, a.candidates, vocabularyVersion()),
    );
  });
});
