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
