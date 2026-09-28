/**
 * READ-ONLY. What a re-drop moved between two ledgers — the restore point taken before it and the ledger after —
 * keyed by the MONEY (account, day, amount), never the row id: a re-read supersedes every row its files wrote and
 * inserts their lines afresh, so every id changes while, when all is well, nothing the owner reads does.
 *
 *   pnpm tsx scripts/probe-chase-redrop.ts --before=<restore point> --after=data/moneyapp.db
 *
 * §6A 23, step 2 (`scripts/pin-fordham-aid-2026-09-28.ts` is step 1): against the restore point `pnpm
 * import-statements` takes, ONLY WORDS may move — 13 lines lose the statement's 20-digit margin id — with no category,
 * source, note, link, status or line gained or lost, and net worth identical on every day. Exit 1 on anything else.
 *
 * Both files are opened read-only and never migrated: `createDatabase` would run `migrate()` on the owner's restore
 * point (scripts/trial-import.ts).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCents } from "@/lib/money";
import { netWorthSeries } from "@/services/derivation";

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
/** the statement's right-margin identifier (chase-checking-statement-profile's MARGIN_ID_RE, anywhere in the line) */
const MARGIN_DIGITS = /\d{20}/;

type Seen = Record<(typeof SEEN)[number], unknown>;
interface Ledger {
  byMoney: Map<string, Seen[]>;
  netWorth: { day: string; cents: number }[];
  marginRows: number;
  live: { count: number; cents: number };
}

function read(file: string): Ledger {
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
      if (MARGIN_DIGITS.test(String(r.raw_description))) marginRows += 1;
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

interface Move {
  key: string;
  fields: string[];
  before: Seen | null;
  after: Seen | null;
}

/** Per money key: the lines both ledgers hold alike drop out; what is left pairs up by the fewest differing fields. */
function moves(before: Ledger, after: Ledger): Move[] {
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
    for (const was of b) {
      const ranked = a.map((x, j) => ({ j, fields: differing(was, x) })).sort((p, q) => p.fields.length - q.fields.length);
      const best = ranked[0];
      if (best === undefined) {
        out.push({ key, fields: ["(line gone)"], before: was, after: null });
        continue;
      }
      out.push({ key, fields: best.fields, before: was, after: a[best.j]! });
      a.splice(best.j, 1);
    }
    for (const now of a) out.push({ key, fields: ["(line new)"], before: null, after: now });
  }
  return out;
}

function main(): void {
  const arg = (name: string): string => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    if (hit === undefined || hit.length === name.length + 3) throw new Error(`--${name}=<db> is required`);
    return hit.slice(name.length + 3);
  };
  const stray = process.argv.slice(2).filter((a) => !a.startsWith("--before=") && !a.startsWith("--after="));
  if (stray.length > 0) throw new Error(`unknown argument(s): ${stray.join(" ")} — this probe takes --before=<db> and --after=<db>`);
  const before = read(arg("before"));
  const after = read(arg("after"));

  const moved = moves(before, after);
  const tally = new Map<string, number>();
  for (const m of moved) for (const f of m.fields) tally.set(f, (tally.get(f) ?? 0) + 1);
  const wordsOnly = moved.filter((m) => m.fields.every((f) => WORDS.has(f)));
  const other = moved.filter((m) => !m.fields.every((f) => WORDS.has(f)));

  const last = (l: Ledger) => (l.netWorth.length === 0 ? "—" : `${l.netWorth.at(-1)!.day} ${formatCents(l.netWorth.at(-1)!.cents)}`);
  const sameWorth = JSON.stringify(before.netWorth) === JSON.stringify(after.netWorth);
  console.log(`live rows          ${before.live.count} ${formatCents(before.live.cents)} → ${after.live.count} ${formatCents(after.live.cents)}`);
  console.log(`net worth          ${last(before)} → ${last(after)} (every day ${sameWorth ? "identical" : "MOVED"})`);
  console.log(`20-digit runs      ${before.marginRows} → ${after.marginRows} live rows`);
  console.log(`lines that moved   ${moved.length}: ${wordsOnly.length} only their words, ${other.length} anything else`);
  console.log(`  by field         ${JSON.stringify(Object.fromEntries([...tally].sort()))}`);
  for (const m of moved) {
    const detail = m.fields
      .filter((f) => f !== "normalized_description")
      .map((f) => (f.startsWith("(") ? f : `${f}: ${JSON.stringify(m.before?.[f as keyof Seen])} → ${JSON.stringify(m.after?.[f as keyof Seen])}`));
    console.log(`  ${m.key.slice(0, m.key.lastIndexOf(" "))}  ${detail.join(" · ")}`);
  }
  const clean = sameWorth && other.length === 0;
  console.log(clean ? "\nONLY WORDS MOVED" : "\n✗ more than words moved — read the lines above against the restore point");
  if (!clean) process.exitCode = 1;
}

main();
