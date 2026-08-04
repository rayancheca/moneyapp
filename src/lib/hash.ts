import { createHash } from "node:crypto";

/**
 * Dedupe identity (schema.md, transactions table):
 * sha256(account_id, posted_on, amount_cents, RAW description, occurrence_index).
 * Raw text is byte-stable across exports of the same format — the normalizer
 * evolves freely because it is NOT part of this hash.
 */

/**
 * Length-prefixed canonical encoding: field boundaries cannot be forged even
 * by untrusted descriptions containing the separator itself (review finding).
 */
function canonicalize(fields: readonly string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join("\x1f");
}

export interface DedupeIdentity {
  accountId: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  occurrenceIndex: number;
}

export function dedupeHash(t: DedupeIdentity): string {
  const canonical = canonicalize([
    t.accountId,
    t.postedOn,
    String(t.amountCents),
    t.rawDescription,
    String(t.occurrenceIndex),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface OccurrenceKey {
  accountId: string;
  postedOn: string;
  amountCents: number;
  rawDescription: string;
}

/**
 * The documented occurrence_index algorithm (schema.md): within ONE incoming
 * file, identical (account, posted_on, amount, raw_description) rows are
 * numbered 0..n−1 in file-row order. Insert-time collide-and-skip and the
 * "higher count wins" rule live at the import layer; this function is the
 * deterministic numbering primitive it relies on.
 */
export function assignOccurrenceIndexes<T>(
  rows: readonly T[],
  key: (row: T) => OccurrenceKey,
): { row: T; occurrenceIndex: number }[] {
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const k = key(row);
    const mapKey = canonicalize([k.accountId, k.postedOn, String(k.amountCents), k.rawDescription]);
    const occurrenceIndex = counts.get(mapKey) ?? 0;
    counts.set(mapKey, occurrenceIndex + 1);
    return { row, occurrenceIndex };
  });
}

/**
 * One side of a duplicate pair, as the pair key sees it: the money and the
 * words, never the id. `transacted_on` is in because the detector will pair two
 * rows that agree on it while disagreeing on `posted_on`.
 */
export interface DuplicatePairSide {
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  normalizedDescription: string;
}

/**
 * Content identity of a duplicate PAIR, stable across the ids changing.
 *
 * Every unimport→re-import gives the same two charges brand-new row ids, so a
 * key built from ids would forget that the owner already answered "these are
 * not the same charge" and ask again — the import-order dependence
 * duplicate_candidates exists to end. Sides are sorted so the key does not
 * depend on which row the self-join happened to emit first.
 *
 * A re-parse that changes a normalized description changes this key, and that
 * is correct: the owner judged the words he was shown, and different words are
 * a different question.
 */
export function duplicatePairKey(accountId: string, left: DuplicatePairSide, right: DuplicatePairSide): string {
  const encode = (s: DuplicatePairSide): string =>
    canonicalize([s.postedOn, s.transactedOn ?? "", String(s.amountCents), s.normalizedDescription]);
  const sides = [encode(left), encode(right)].sort();
  return createHash("sha256").update(canonicalize([accountId, ...sides]), "utf8").digest("hex");
}

/** Content hash for import_files.file_sha256. */
export function fileSha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}
