import { withoutAchReferences } from "./normalize";

/**
 * How closely two normalized descriptions describe the same charge: 3 equal,
 * 2 one contains the other, 1 a long shared prefix, 0 unrelated.
 *
 * Lives in lib so the three callers provably share ONE definition of "these
 * two records describe the same purchase": takeover-victim selection (where 0
 * vetoes a supersede), re-parse carry-forward (where it only ranks candidates
 * that already match on money), and cross-source duplicate flagging (where 0
 * vetoes the flag). A second, drifting copy of this rule is how a supersede and
 * a flag would come to disagree about the same pair.
 */
/**
 * Eight characters is long enough that two unrelated merchants rarely collide,
 * short enough to survive one source truncating the other's tail. It is the
 * weakest of the three signals — "MTA*NYCT", "CTLP*CC " and "PAYMENT " all
 * reach it — so callers that act on a match must gate it behind money identity
 * as well, never on description alone.
 */
const SHARED_PREFIX_MIN = 8;

/**
 * ⛔ Both read in normalizer v3's form (`withoutAchReferences`), as absorption and the stripped key read a stored
 * description: a row stored before v3 keeps its ACH entry's individual ID, and the same line read again — or the
 * payee's next entry — carries none. 🔴 Compared as stored, Sep 24's payroll and its own line re-read scored 1, a
 * shared prefix, beside rows that score 3 (review of b53989c8).
 */
export function descriptionScore(candidate: string, incoming: string): number {
  const a = withoutAchReferences(candidate);
  const b = withoutAchReferences(incoming);
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return prefix >= SHARED_PREFIX_MIN ? 1 : 0;
}
