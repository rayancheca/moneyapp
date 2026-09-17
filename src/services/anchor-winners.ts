import { KEPT_OPENING_SOURCE, type AnchorSource } from "@/db/schema/balances";
import { compareDates } from "@/lib/dates";

/**
 * Which recorded balance a day's replay uses when several share the day — the
 * precedence `deriveDailyRows` reads, in a module of its own.
 *
 * ⛔ A leaf ON PURPOSE. `derivation` imports `coverage` (`basisIsChecked`), and
 * `coverage` has to know which days rest on a balance the owner typed, which is
 * a question about the WINNING anchor, not about any anchor on the day. Asking
 * `derivation` for it would close an import cycle; copying the precedence would
 * be a second definition of it. `derivation` re-exports `pickWinners`, so every
 * existing caller reads the same function.
 */
const ANCHOR_PRECEDENCE: Record<AnchorSource, number> = {
  statement: 0,
  ofx_ledger: 1,
  manual: 2,
  live: 3,
  // a balance kept from a statement he un-imported loses every day to anything recorded now (schema: KEPT_OPENING_SOURCE)
  unimported_statement: 4,
};

/** The two fields precedence reads — a whole `balance_anchors` row satisfies it. */
export interface RankedAnchor {
  anchoredOn: string;
  source: AnchorSource;
}

/**
 * Highest-precedence anchor per date.
 *
 * Generic so a caller holding whole `balance_anchors` rows gets those rows back
 * — `provenance` names the winning anchor's document, and must name the one this
 * replay used rather than whichever row SQLite returned first.
 */
export function pickWinners<T extends RankedAnchor>(anchors: readonly T[]): T[] {
  const byDate = new Map<string, T>();
  for (const a of anchors) {
    const current = byDate.get(a.anchoredOn);
    if (!current || ANCHOR_PRECEDENCE[a.source] < ANCHOR_PRECEDENCE[current.source]) {
      byDate.set(a.anchoredOn, a);
    }
  }
  return [...byDate.values()].sort((x, y) => compareDates(x.anchoredOn, y.anchoredOn));
}

/**
 * The opening balance kept from a statement he un-imported (`KEPT_OPENING_SOURCE`) that an account's replay starts
 * from — only when the account records no other balance, the oldest when there are several. Null otherwise: beside
 * anything recorded now it is inert. Here, in the leaf, because `coverage` asks it too.
 *
 * ⚖️ Owner decision 20, 2026-09-17: un-importing 2026-08-25-everyday-checking.pdf keeps Wells Fargo's 39 rows under
 * the Rocket Money export and takes both of its balances, and a balance is derived only from a recorded one — net
 * worth fell 11,312,501 → 11,072,834 cents on a copy of the real ledger. The $0.00 opening the statement printed for
 * Jul 26, 2026 stays, and the kept rows replay from it — unchecked (`deriveDailyRows`).
 */
export function keptOpeningOf<T extends RankedAnchor>(winners: readonly T[]): T | null {
  if (winners.some((w) => w.source !== KEPT_OPENING_SOURCE)) return null;
  return [...winners].sort((x, y) => compareDates(x.anchoredOn, y.anchoredOn))[0] ?? null;
}

/**
 * The days whose replayed balance is one the owner TYPED — a `manual` anchor
 * that won its day. A statement or a bank export recorded the same day wins it,
 * and the day is theirs.
 */
export function handTypedDays(winners: readonly RankedAnchor[]): Set<string> {
  return new Set(winners.filter((w) => w.source === "manual").map((w) => w.anchoredOn));
}
