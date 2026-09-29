/**
 * What the import changes on its way that is not a record, put back as the ledger had it — the rest of the write of
 * scripts/reread-unrecorded-files.ts, run on the rehearsal copy and on the ledger alike, before either is compared.
 *
 * ⚖️ His rule (§6A 26, 2026-09-28): refuse if anything but the records changes. Measured on copies of the real ledger
 * (2026-09-28/29), the import changes two more things than the records, neither of them the re-read's business:
 *  - it rebuilds every account it reads to TODAY (`rebuildAccount`): caches last rebuilt Sep 14/15 ran on — Discover 15
 *    days, Robinhood Agentic 14, Robinhood Cash 14, Robinhood Brokerage 1 — the dashboard's "Robinhood Cash … 15 days
 *    unchecked" read 28, net worth ran a day further, and /summary's 2026 return moved with its valuation day (36.34% →
 *    36.17%). The days it added after the day an account's cache ended are taken back out (`keepCacheEnds`); every day
 *    before it must be the day the ledger had, to the cent and the basis, or the comparison refuses.
 *  - a new read derives each row's dedupe key from the row as it reads it: 3 Discover rows that
 *    scripts/fix-discover-backdated-adjustments.ts re-dated in place without re-keying came back under new keys. Each
 *    new row takes the key its older read's row had (`keepDedupeKeys`) — the three stay as they were: whether to
 *    re-key them is a question of its own, not this re-read's.
 * Neither is trusted: the face comparison that follows refuses any day, key or figure that is not as it was.
 */
import type { DbBundle } from "@/db/client";
import { contentOf, spansOf } from "./reread-unrecorded-face";

type Row = Record<string, unknown>;

/** What the ledger had, read before the import: where each cache ends, and the keys of the rows the re-read retires. */
export interface HadBefore {
  /** account → its last cached balance day */
  readonly ends: ReadonlyMap<string, string>;
  /** a retired read's live row, by content as the face reads it → its dedupe keys */
  readonly keys: ReadonlyMap<string, readonly string[]>;
  readonly accountNames: ReadonlyMap<string, string>;
}

const all = (bundle: DbBundle, sql: string, ...params: unknown[]): Row[] => bundle.sqlite.prepare(sql).all(...params) as Row[];
const listOf = (ids: readonly string[]): string => ids.map(() => "?").join(", ");

/** Each account's last cached balance day. */
function cacheEnds(bundle: DbBundle): Map<string, string> {
  return new Map(
    all(bundle, "SELECT account_id, max(day) AS day FROM daily_balances GROUP BY account_id").map((r) => [String(r.account_id), String(r.day)]),
  );
}

/** Live rows' dedupe keys, by content — the rows under `fileIds`. */
function keysOf(bundle: DbBundle, fileIds: readonly string[]): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  if (fileIds.length === 0) return keys;
  const spans = spansOf(bundle);
  for (const row of all(bundle, `SELECT * FROM transactions WHERE status != 'superseded' AND import_file_id IN (${listOf(fileIds)})`, ...fileIds)) {
    const content = contentOf(row, spans);
    keys.set(content, [...(keys.get(content) ?? []), String(row.dedupe_hash)].sort());
  }
  return keys;
}

/** Read before the import: `retiring` are the older reads' `import_files` ids. */
export function whatTheLedgerHad(bundle: DbBundle, retiring: readonly string[]): HadBefore {
  return {
    ends: cacheEnds(bundle),
    keys: keysOf(bundle, retiring),
    accountNames: new Map(all(bundle, "SELECT id, name FROM accounts").map((a) => [String(a.id), String(a.name)])),
  };
}

/**
 * Every account whose cache the import ran past where it ended: the days after that day taken back out. An account with
 * no cache before has nothing to keep — the comparison names every day it gained — and a day inside the old span that
 * the rebuild wrote differently is not this function's to hide: the comparison refuses it.
 *
 * ⚠️ Not `rebuildAccount(…, today = the old end)`: a rebuild runs to an account's last anchor whatever day it is given,
 * so a cache that stopped before its last anchor (a rebuild that ran before the statement was read) would come back
 * longer than it was.
 */
function keepCacheEnds(bundle: DbBundle, had: HadBefore): string[] {
  const trim = bundle.sqlite.prepare("DELETE FROM daily_balances WHERE account_id = ? AND day > ?");
  const kept: string[] = [];
  bundle.sqlite.transaction(() => {
    for (const [accountId, end] of cacheEnds(bundle)) {
      const was = had.ends.get(accountId);
      if (was === undefined || end <= was) continue;
      const days = trim.run(accountId, was).changes;
      kept.push(`${had.accountNames.get(accountId) ?? accountId}: balances cached through ${was}, as they were (the import's rebuild added ${days} day(s), to ${end})`);
    }
  })();
  return kept.sort();
}

/**
 * Each new read's live row takes the dedupe key its older read's row had — the one live row of the same content, as the
 * face reads it. Content several rows shared is left to the comparison.
 */
function keepDedupeKeys(bundle: DbBundle, had: HadBefore, freshIds: readonly string[]): string[] {
  if (freshIds.length === 0) return [];
  const spans = spansOf(bundle);
  const fresh = all(bundle, `SELECT * FROM transactions WHERE status != 'superseded' AND import_file_id IN (${listOf(freshIds)}) ORDER BY id`, ...freshIds);
  const rekey = bundle.sqlite.prepare("UPDATE transactions SET dedupe_hash = ? WHERE id = ?");
  const kept: string[] = [];
  bundle.sqlite.transaction(() => {
    for (const row of fresh) {
      const keys = had.keys.get(contentOf(row, spans));
      if (keys?.length !== 1 || keys[0] === row.dedupe_hash) continue;
      rekey.run(keys[0], row.id);
      kept.push(`"${String(row.raw_description)}" ${String(row.posted_on)}`);
    }
  })();
  return kept.length === 0 ? [] : [`${kept.length} dedupe key(s) as the ledger had them, not as the new read derives them: ${kept.join("; ")}`];
}

/** The import's changes that are not records, put back — each said. `freshIds`: the new reads' `import_files` ids. */
export function keepAsTheLedgerHad(bundle: DbBundle, had: HadBefore, freshIds: readonly string[]): string[] {
  return [...keepCacheEnds(bundle, had), ...keepDedupeKeys(bundle, had, freshIds)];
}
