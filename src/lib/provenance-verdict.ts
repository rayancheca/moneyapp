import type { IconName } from "@/components/shell/Icon";

/**
 * How each provenance verdict presents itself — the word, the glyph and the
 * tone, in ONE place so a badge, a popover heading and any future surface
 * cannot drift apart.
 *
 * ⛔ The words are deliberately plain and deliberately unflattering. "adds up"
 * and "nothing checks it" are claims a reader can act on; "verified" and
 * "pending" are not. The whole feature is worth less than nothing if a figure
 * with no proof can be mistaken for one with proof, so the weak verdicts get
 * the loud glyph and the strong ones stay quiet.
 *
 * ⚠️ `market_value` and `manual` are neither good nor bad and must not be
 * toned as either. An investment priced from holdings is not a failure — there
 * is simply no arithmetic gate to pass — and a balance the owner typed is the
 * best evidence that will ever exist for cash in a safe.
 */
export type ProvenanceTone = "proven" | "neutral" | "weak" | "broken";

export interface VerdictPresentation {
  /** two or three words, lower case, readable inside a sentence */
  word: string;
  icon: IconName;
  tone: ProvenanceTone;
  /** completes "this figure …" for the trigger's accessible name */
  ariaSuffix: string;
}

export const VERDICT_PRESENTATION = {
  sourced: {
    word: "on a statement",
    icon: "circle-check",
    tone: "proven",
    ariaSuffix: "comes straight from a statement",
  },
  derived: {
    word: "adds up",
    icon: "circle-check",
    tone: "proven",
    ariaSuffix: "adds up against a source document",
  },
  market_value: {
    word: "market value",
    icon: "info",
    tone: "neutral",
    ariaSuffix: "is priced from holdings, not checked by arithmetic",
  },
  manual: {
    word: "you entered it",
    icon: "info",
    tone: "neutral",
    ariaSuffix: "was entered by hand",
  },
  unverified: {
    word: "nothing checks it",
    icon: "circle-alert",
    tone: "weak",
    ariaSuffix: "has nothing checking it",
  },
  unknown: {
    word: "no basis yet",
    icon: "circle-alert",
    tone: "weak",
    ariaSuffix: "has no basis yet",
  },
  broken: {
    word: "does not add up",
    icon: "warning",
    tone: "broken",
    ariaSuffix: "does not add up",
  },
} as const satisfies Record<string, VerdictPresentation>;

export type PresentedVerdict = keyof typeof VERDICT_PRESENTATION;

const TONE_CLASS: Record<ProvenanceTone, string> = {
  proven: "text-positive",
  neutral: "text-ink-muted",
  weak: "text-warning",
  broken: "text-negative",
};

export function verdictToneClass(tone: ProvenanceTone): string {
  return TONE_CLASS[tone];
}

/**
 * A label as it reads INSIDE another sentence: without its own terminal full
 * stop, and with every other character intact.
 *
 * 🔴 Most callers label a badge with a noun phrase ("net worth", "Housing
 * budget"), but InsightList and NoticesCard label it with the insight itself —
 * a finished sentence — and the name read "How Housing is the largest of your 12
 * monthly budgets, by what you planned to spend, at $2,291.21. is proven — a
 * plan". Measured 2026-09-14: 618 of 780 provenance-trigger names on 297 pages.
 *
 * ⛔ Exactly ONE stop, and only a final one: "$2,291.21", "46.6%" and "21.6×"
 * keep their points, and a sentence ending "…Amato Pharmacy Inc.." keeps the
 * abbreviation's. `/\.+$/` would eat it.
 */
export function embeddedLabel(label: string): string {
  return label.endsWith(".") ? label.slice(0, -1) : label;
}

/**
 * The trigger's accessible name — the badge word when a composite figure carries one.
 *
 * 🔴 "IS PROVEN — IT WAS ENTERED BY HAND". This read "How X is proven" for
 * every verdict, and five of the seven are not proofs: `manual`,
 * `market_value`, `unverified`, `unknown` and `broken` each put a claim of
 * proof in front of their own denial. Measured 2026-09-14 on /summary/2026,
 * once its window took in the $5,000 car down payment entered by hand on Aug
 * 11: "How Spending in Jan 1 – Aug 12, 2026 came to $66,477.60 is proven — it
 * was entered by hand", beside a badge reading "you entered it". Across
 * /summary, /spending, /budgets and every /categories/[id] page at its default
 * period, 80 of 159 names said "is proven" of a verdict that is not a proof:
 * "— a plan" ×14, "— it was entered by hand" ×2, "— it has no basis yet" ×64.
 *
 * ⛔ The name says how the figure is KNOWN, and the phrase after the dash says
 * what that is — so no verdict's name can claim a proof it does not have. The
 * badge WORDS are untouched (owner decision S33, 2026-09-14).
 */
export function provenanceTriggerName(label: string, verdict: PresentedVerdict, badgeWord?: string): string {
  return `How ${embeddedLabel(label)} is known — ${badgeWord ? badgeWord : `it ${VERDICT_PRESENTATION[verdict].ariaSuffix}`}`;
}

/** The panel's accessible name — through the same rule, so the button and its dialog name one claim. */
export function provenancePanelName(label: string): string {
  return `What ${embeddedLabel(label)} is standing on`;
}
