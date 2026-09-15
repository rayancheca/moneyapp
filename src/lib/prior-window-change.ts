import { formatCentsSigned } from "./money";

/**
 * A change against the prior window, in words — the one home for how
 * "Where it went" says it.
 *
 * The List's phone line, the relief's rail and the relief's description each
 * spelled "level with <prior window>" inline, beside their own zero test and
 * their own preposition for a change that was not zero. Two of the three said
 * "against"; the rail said "on". `lib/compared-windows` decides WHETHER there is
 * a prior window and names it; this says what a change against it reads as.
 *
 * ⛔ A zero change is said in words, never as a figure. `formatCentsSigned`
 * prints no sign on it, so "$0.00 against June 2026" reads like money spent, and
 * a category that stopped over a window whose entries netted to $0.00 looked
 * like one that spent nothing (`SpendingCategoriesTable`, 0b8d2af).
 *
 * ⛔ `=== 0`, never `Object.is`: a `-0` delta is no change, and must read as none.
 */
export interface ChangeAgainstPrior {
  /** exactly no change (`-0` included) — said in `words`, with no figure before it */
  level: boolean;
  /** "level with June 2026" — or, set after the signed figure, "against June 2026" */
  words: string;
}

export function changeAgainstPrior(deltaCents: number, priorLabel: string): ChangeAgainstPrior {
  return deltaCents === 0
    ? { level: true, words: `level with ${priorLabel}` }
    : { level: false, words: `against ${priorLabel}` };
}

/** The change as one phrase: "level with June 2026", or "+$12.00 against June 2026". */
export function changeAgainstPriorText(deltaCents: number, priorLabel: string): string {
  const change = changeAgainstPrior(deltaCents, priorLabel);
  return change.level ? change.words : `${formatCentsSigned(deltaCents)} ${change.words}`;
}
