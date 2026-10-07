import { describe, expect, test } from "vitest";
import {
  PART_ENTERED,
  VERDICT_PRESENTATION,
  embeddedLabel,
  provenancePanelName,
  provenanceTriggerName,
  verdictToneClass,
  type PresentedVerdict,
  type ProvenanceTone,
} from "./provenance-verdict";

const ALL = Object.keys(VERDICT_PRESENTATION) as PresentedVerdict[];

describe("VERDICT_PRESENTATION", () => {
  /**
   * The service's verdict union and this vocabulary have to stay in step: a
   * verdict with no presentation would render as a blank badge, which reads as
   * "fine" — the exact misreading this feature exists to prevent.
   */
  test("covers every verdict the service can return", () => {
    expect([...ALL].sort()).toEqual(
      ["broken", "counted", "derived", "manual", "market_value", "sourced", "unknown", "unverified"].sort(),
    );
  });

  test("every verdict has a word, a glyph and an accessible suffix", () => {
    for (const v of ALL) {
      const p = VERDICT_PRESENTATION[v];
      expect(p.word.length).toBeGreaterThan(0);
      expect(p.icon.length).toBeGreaterThan(0);
      expect(p.ariaSuffix.length).toBeGreaterThan(0);
    }
  });

  /**
   * ⛔ market_value, manual and counted are neither good nor bad. Toning them
   * "weak" would cry wolf on two thirds of a portfolio; toning them "proven"
   * would claim an arithmetic check that does not exist for any of them.
   */
  test("the three neutral verdicts are toned neither proven nor weak", () => {
    expect(VERDICT_PRESENTATION.market_value.tone).toBe("neutral");
    expect(VERDICT_PRESENTATION.manual.tone).toBe("neutral");
    expect(VERDICT_PRESENTATION.counted.tone).toBe("neutral");
  });

  /*
   * ⚖️ His answer, 2026-10-07 (§6A 50, extending §6A 33): "counted" is the ONE verb for a balance he typed, and the
   * badge says it too — but only of a BALANCE. A row he entered by hand (the Cash on Hand wallet's rows), a holding or
   * an amount he set keeps "you entered it": he typed those, he did not count them.
   */
  test('⚖️ a balance he typed reads "you counted it"; a row he typed keeps "you entered it"', () => {
    expect(VERDICT_PRESENTATION.counted.word).toBe("you counted it");
    expect(VERDICT_PRESENTATION.manual.word).toBe("you entered it");
    // told apart by the word and the name alone — the same glyph and the same tone
    expect(VERDICT_PRESENTATION.counted.icon).toBe(VERDICT_PRESENTATION.manual.icon);
    expect(provenanceTriggerName("Cash on Hand's balance", "counted")).toBe(
      "How Cash on Hand's balance is known — it rests on a balance you counted",
    );
    expect(provenanceTriggerName("Cash on Hand's balance", "manual")).toBe(
      "How Cash on Hand's balance is known — it was entered by hand",
    );
  });

  /*
   * 🔴 "…came to $66,477.60 is known — it was entered by hand" of a year's spending in which ONE $5,000.00 row was
   * typed (/summary/2026, review 2026-10-07). A total only part of which he typed says PART, in the badge and the name.
   */
  test("a total part of which he typed has its own word and its own name", () => {
    expect(PART_ENTERED.word).toBe("part you entered");
    expect(PART_ENTERED.word).toBe(PART_ENTERED.word.toLowerCase());
    expect(PART_ENTERED.word.length).toBeLessThanOrEqual(18);
    expect(
      provenanceTriggerName("Spending in Jan 1 – Aug 12, 2026 came to $66,477.60.", "manual", PART_ENTERED.word, PART_ENTERED.name),
    ).toBe("How Spending in Jan 1 – Aug 12, 2026 came to $66,477.60 is known — part of it was entered by hand");
    // with no name of its own, a badge word still completes the name as before
    expect(provenanceTriggerName("net worth", "unknown", "6 of 12 add up")).toBe("How net worth is known — 6 of 12 add up");
  });

  test("only the two proven verdicts read as proven", () => {
    const proven = ALL.filter((v) => VERDICT_PRESENTATION[v].tone === "proven");
    expect([...proven].sort()).toEqual(["derived", "sourced"]);
  });

  test("a figure that does not add up is the loudest thing on the page", () => {
    expect(VERDICT_PRESENTATION.broken.tone).toBe("broken");
    expect(VERDICT_PRESENTATION.broken.word).toMatch(/does not add up/);
  });

  /** The words go inside a sentence, so a capital letter would read as a shout. */
  test("every word is lower case and short enough to sit in a badge", () => {
    for (const v of ALL) {
      const { word } = VERDICT_PRESENTATION[v];
      expect(word).toBe(word.toLowerCase());
      expect(word.length).toBeLessThanOrEqual(18);
    }
  });
});

describe("verdictToneClass", () => {
  test("each tone maps to exactly one class, and they are all distinct", () => {
    const tones: ProvenanceTone[] = ["proven", "neutral", "weak", "broken"];
    const classes = tones.map(verdictToneClass);
    expect(new Set(classes).size).toBe(tones.length);
    for (const c of classes) expect(c).toMatch(/^text-/);
  });
});

/**
 * 🔴 A WHOLE SENTENCE EMBEDDED IN A SENTENCE. An insight's badge is labelled by
 * the insight itself, and every insight ends in a full stop, so a screen reader
 * heard "How Housing is the largest of your 12 monthly budgets, by what you
 * planned to spend, at $2,291.21. is proven — a plan". Measured 2026-09-14: 618
 * of 780 provenance-trigger names across 297 pages — every one rendered by
 * InsightList or NoticesCard.
 */
describe("the popover's accessible names", () => {
  const SENTENCE = "Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21.";

  test("a sentence loses exactly its own terminal full stop inside both names, and nothing else", () => {
    expect(provenanceTriggerName(SENTENCE, "manual", "a plan")).toBe(
      "How Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21 is known — a plan",
    );
    expect(provenancePanelName(SENTENCE)).toBe(
      "What Housing is the largest of your 12 monthly budgets, by what you planned to spend, at $2,291.21 is standing on",
    );
  });

  test("a noun phrase comes back unchanged — the other callers are untouched", () => {
    for (const label of ["net worth", "Housing budget", "Chase Sapphire, Aug 3 – Sep 2, 2026"]) {
      expect(embeddedLabel(label)).toBe(label);
    }
    expect(provenanceTriggerName("net worth", "derived")).toBe("How net worth is known — it adds up against a source document");
  });

  /*
   * 🔴 "IS PROVEN — IT WAS ENTERED BY HAND". The name said "is proven" of every
   * verdict, and five of the seven are not proofs. Measured 2026-09-14 on
   * /summary/2026, once its window took in the $5,000 car down payment entered
   * by hand on Aug 11: "How Spending in Jan 1 – Aug 12, 2026 came to $66,477.60
   * is proven — it was entered by hand", beside a badge reading "you entered
   * it". The name now says how the figure is KNOWN, and the phrase after the
   * dash says what that is — so no verdict's name can claim a proof.
   *
   * ⛔ The BADGE words are untouched (owner decision S33, 2026-09-14).
   */
  test("🔴 no verdict's name claims a proof — the name says how the figure is known", () => {
    const spending = "Spending in Jan 1 – Aug 12, 2026 came to $66,477.60.";
    expect(provenanceTriggerName(spending, "manual")).toBe(
      "How Spending in Jan 1 – Aug 12, 2026 came to $66,477.60 is known — it was entered by hand",
    );
    for (const v of ALL) {
      expect(provenanceTriggerName(spending, v)).not.toMatch(/proven/);
      expect(provenanceTriggerName(spending, v, "3 of 5 checked")).not.toMatch(/proven/);
    }
  });

  test("⛔ ONE stop, never all of them — a sentence ending in an abbreviation keeps the abbreviation's", () => {
    // three real merchants end in "Inc." — the ledger holds "Amato Pharmacy Inc."
    expect(embeddedLabel("7 transactions landed in Amato Pharmacy Inc..")).toBe("7 transactions landed in Amato Pharmacy Inc.");
    // inner decimals, percents and multiples survive
    expect(embeddedLabel("Dining rose 46.6%, 21.6× its usual, to $1,203.40.")).toBe("Dining rose 46.6%, 21.6× its usual, to $1,203.40");
  });

  test("no name ever carries a full stop before its own verb", () => {
    for (const v of ALL) {
      expect(provenanceTriggerName(SENTENCE, v)).not.toMatch(/\. is known/);
    }
    expect(provenancePanelName(SENTENCE)).not.toMatch(/\. is standing on/);
  });
});
