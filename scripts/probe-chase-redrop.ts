/**
 * READ-ONLY. What a re-drop moved between two ledgers — the restore point taken before it and the ledger after —
 * keyed by the MONEY (account, day, amount), never the row id: a re-read supersedes every row its files wrote and
 * inserts their lines afresh, so every id changes while, when all is well, nothing the owner reads does.
 *
 *   pnpm tsx scripts/probe-chase-redrop.ts --before=<restore point> --after=data/moneyapp.db
 *
 * §6A 23, step 2 (`scripts/pin-fordham-aid-2026-09-28.ts` is step 1): against the restore point `pnpm
 * import-statements` takes, ONLY THE MARGIN IDS may move — 13 lines lose the statement's 20-digit margin identifier
 * and keep every other word — with no category, source, note, link, status or line gained or lost, and net worth
 * identical on every day the ledger had (a day added past its last must carry that worth: `worthOnEveryDay`). Exit 1
 * on anything else.
 *
 * A line is matched to its successor by the words it prints once the identifier is gone (`withoutMarginIdentifier`,
 * the rule the v2 read drops it by), and its words may move by that identifier and nothing more. Two lines of one
 * amount on one day are two charges, and the words are what tell them apart.
 *
 * Both files are opened read-only and never migrated: `createDatabase` would run `migrate()` on the owner's restore
 * point (scripts/trial-import.ts).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCents } from "@/lib/money";
import { normalizeDescription } from "@/lib/normalize";
import { netWorthSeries } from "@/services/derivation";
import { withoutMarginIdentifier } from "@/services/import/profiles/chase-checking-statement-profile";

/** What the owner can see of a line, beside its money. Ids, files, periods, hashes and stamps are the read's own. */
const SEEN = [
  "raw_description",
  "normalized_description",
  "transacted_on",
  "status",
  "category_id",
  "categorization_source",
  "categorization_confidence",
  "needs_review",
  "merchant_id",
  "bank_category",
  "notes",
  "transfer_group_id",
  "recurring_series_id",
  "series_link_source",
  "file_link_source",
  "splits",
] as const;
const WORDS: ReadonlySet<string> = new Set(["raw_description", "normalized_description"]);

type Seen = Record<(typeof SEEN)[number], unknown>;
export interface Ledger {
  byMoney: Map<string, Seen[]>;
  netWorth: { day: string; cents: number }[];
  marginRows: number;
  live: { count: number; cents: number };
}

export function readLedger(file: string): Ledger {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = new Map((sqlite.prepare("SELECT id, name FROM accounts").all() as { id: string; name: string }[]).map((a) => [a.id, a.name]));
    const splits = new Map<string, string>();
    for (const s of sqlite
      .prepare("SELECT transaction_id AS id, category_id, amount_cents, note FROM transaction_splits ORDER BY transaction_id, category_id, amount_cents")
      .all() as { id: string }[]) {
      const { id, ...part } = s;
      splits.set(id, `${splits.get(id) ?? ""}${JSON.stringify(part)}`);
    }
    const byMoney = new Map<string, Seen[]>();
    let marginRows = 0;
    const live = { count: 0, cents: 0 };
    for (const r of sqlite.prepare("SELECT * FROM transactions WHERE status != 'superseded'").all() as Record<string, unknown>[]) {
      // matched on the account's id, printed with its name
      const key = `${names.get(String(r.account_id)) ?? String(r.account_id)} ${String(r.posted_on)} ${formatCents(Number(r.amount_cents))} ${String(r.account_id)}`;
      const seen = Object.fromEntries(SEEN.map((c) => [c, c === "splits" ? (splits.get(String(r.id)) ?? null) : r[c]])) as Seen;
      byMoney.set(key, [...(byMoney.get(key) ?? []), seen]);
      if (carriesMarginIdentifier(String(r.raw_description))) marginRows += 1;
      live.count += 1;
      live.cents += Number(r.amount_cents);
    }
    const db = drizzle(sqlite, { schema }) as unknown as AppDatabase;
    const netWorth = netWorthSeries(db).map((p) => ({ day: p.day, cents: p.totalCents }));
    return { byMoney, netWorth, marginRows, live };
  } finally {
    sqlite.close();
  }
}

const differing = (a: Seen, b: Seen): string[] => SEEN.filter((c) => JSON.stringify(a[c]) !== JSON.stringify(b[c]));
const carriesMarginIdentifier = (raw: string): boolean => withoutMarginIdentifier(raw) !== raw;
/** The words a line prints once the margin identifier is gone: what a correct re-read prints for it. */
const words = (line: Seen): string => withoutMarginIdentifier(String(line.raw_description));

export interface Move {
  key: string;
  fields: string[];
  before: Seen | null;
  after: Seen | null;
}

/**
 * Per money key: the lines both ledgers hold alike drop out; what is left pairs up by the words each line prints once
 * the margin identifier is gone — its own charge — and only then, among what no line's words claim, by the fewest
 * differing fields.
 *
 * 🔴 Paired by the fewest differing fields alone, a CROSSED carry read as a clean one (the review of
 * uc/chase-redrop-runbook, 2026-09-28): when two lines of one amount on one day both lose their identifier, the line
 * that took the owner's category and note differs from his old line only in its words, so each old line paired with
 * its neighbour and the probe printed ONLY WORDS MOVED — the failure `claimCarry` records for this very re-read,
 * Adam's hand-set category on Lukas's +$20.00 of 2023-10-18.
 */
export function moves(before: Ledger, after: Ledger): Move[] {
  const out: Move[] = [];
  for (const key of [...new Set([...before.byMoney.keys(), ...after.byMoney.keys()])].sort()) {
    const b = [...(before.byMoney.get(key) ?? [])];
    const a = [...(after.byMoney.get(key) ?? [])];
    for (let i = b.length - 1; i >= 0; i--) {
      const j = a.findIndex((x) => differing(b[i]!, x).length === 0);
      if (j !== -1) {
        b.splice(i, 1);
        a.splice(j, 1);
      }
    }
    // every line that finds its own words first, so no line whose words moved can take another line's successor
    for (const ownWords of [true, false]) {
      for (let i = 0; i < b.length; ) {
        const was = b[i]!;
        const best = a
          .map((x, j) => ({ j, fields: differing(was, x) }))
          .filter(({ j }) => !ownWords || words(a[j]!) === words(was))
          .sort((p, q) => p.fields.length - q.fields.length)[0];
        if (best === undefined) {
          i += 1;
          continue;
        }
        out.push({ key, fields: best.fields, before: was, after: a[best.j]! });
        b.splice(i, 1);
        a.splice(best.j, 1);
      }
    }
    for (const was of b) out.push({ key, fields: ["(line gone)"], before: was, after: null });
    for (const now of a) out.push({ key, fields: ["(line new)"], before: null, after: now });
  }
  return out;
}

/**
 * The move the re-drop exists for, and no other: the line lost its margin identifier and kept every other word, and
 * nothing else the owner reads moved with it. The normalized words may follow the raw ones — the import derives them
 * (`normalizeDescription`) — but never move on their own.
 */
export function isMarginCleanup(move: Move): boolean {
  if (move.before === null || move.after === null || !move.fields.every((f) => WORDS.has(f))) return false;
  const was = String(move.before.raw_description);
  const now = String(move.after.raw_description);
  const derived = move.after.normalized_description;
  const normalizedFollows = derived === move.before.normalized_description || derived === normalizeDescription(now);
  return was !== now && withoutMarginIdentifier(was) === now && normalizedFollows;
}

export interface Verdict {
  moved: Move[];
  /** the lines that lost their margin identifier and nothing else */
  cleaned: Move[];
  other: Move[];
  sameWorth: boolean;
  /** days past the ledger's last that the re-read added at its last worth */
  carriedDays: string[];
  clean: boolean;
}

/**
 * Net worth on every day the ledger had, identical — and a day the re-read adds past its last carries that day's
 * worth. Re-deriving Chase Checking carries its last balance to the day the import runs (the runbook's `carried`
 * balances), so when the ledger last ran to an earlier day the series grows by those days at the same worth; any
 * day it had that moved or went missing, or an added day at another worth, is not the same. (Measured 2026-10-05:
 * the ledger ran to Oct 2, the staged re-drop to Oct 5 — 1,501 days identical, 3 added at $119,999.32.)
 */
export function worthOnEveryDay(
  before: Ledger["netWorth"],
  after: Ledger["netWorth"],
): { same: boolean; carried: string[] } {
  const prefix = after.slice(0, before.length);
  if (JSON.stringify(prefix) !== JSON.stringify(before)) return { same: false, carried: [] };
  const last = before.at(-1);
  const added = after.slice(before.length);
  if (added.length > 0 && (last === undefined || added.some((p) => p.cents !== last.cents || p.day <= last.day))) {
    return { same: false, carried: [] };
  }
  return { same: true, carried: added.map((p) => p.day) };
}

export function judge(before: Ledger, after: Ledger): Verdict {
  const moved = moves(before, after);
  const cleaned = moved.filter(isMarginCleanup);
  const other = moved.filter((m) => !isMarginCleanup(m));
  const worth = worthOnEveryDay(before.netWorth, after.netWorth);
  const sameWorth = worth.same;
  return { moved, cleaned, other, sameWorth, carriedDays: worth.carried, clean: sameWorth && other.length === 0 };
}

function main(): void {
  const arg = (name: string): string => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    if (hit === undefined || hit.length === name.length + 3) throw new Error(`--${name}=<db> is required`);
    return hit.slice(name.length + 3);
  };
  const stray = process.argv.slice(2).filter((a) => !a.startsWith("--before=") && !a.startsWith("--after="));
  if (stray.length > 0) throw new Error(`unknown argument(s): ${stray.join(" ")} — this probe takes --before=<db> and --after=<db>`);
  const before = readLedger(arg("before"));
  const after = readLedger(arg("after"));
  const { moved, cleaned, other, sameWorth, carriedDays, clean } = judge(before, after);
  const tally = new Map<string, number>();
  for (const m of moved) for (const f of m.fields) tally.set(f, (tally.get(f) ?? 0) + 1);

  const last = (l: Ledger) => (l.netWorth.length === 0 ? "—" : `${l.netWorth.at(-1)!.day} ${formatCents(l.netWorth.at(-1)!.cents)}`);
  console.log(`live rows          ${before.live.count} ${formatCents(before.live.cents)} → ${after.live.count} ${formatCents(after.live.cents)}`);
  console.log(`net worth          ${last(before)} → ${last(after)} (every day ${sameWorth ? "identical" : "MOVED"}${carriedDays.length > 0 ? `; ${carriedDays.length} day(s) added past the last, carrying its worth: ${carriedDays[0]} → ${carriedDays.at(-1)}` : ""})`);
  console.log(`margin ids         ${before.marginRows} → ${after.marginRows} live rows`);
  console.log(`lines that moved   ${moved.length}: ${cleaned.length} only their margin id, ${other.length} anything else`);
  console.log(`  by field         ${JSON.stringify(Object.fromEntries([...tally].sort()))}`);
  for (const m of moved) {
    // the normalized words are shown only when they moved on their own: beside the raw ones they say nothing new
    const detail = m.fields
      .filter((f) => f !== "normalized_description" || !m.fields.includes("raw_description"))
      .map((f) => (f.startsWith("(") ? f : `${f}: ${JSON.stringify(m.before?.[f as keyof Seen])} → ${JSON.stringify(m.after?.[f as keyof Seen])}`));
    console.log(`  ${m.key.slice(0, m.key.lastIndexOf(" "))}  ${detail.join(" · ")}`);
  }
  console.log(clean ? "\nONLY THE MARGIN IDS MOVED" : "\n✗ more than the margin ids moved — read the lines above against the restore point");
  if (!clean) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("probe-chase-redrop.ts")) main();
