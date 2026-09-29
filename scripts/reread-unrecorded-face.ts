/**
 * What the ledger says, keyed by CONTENT — the before/after invariants of scripts/reread-unrecorded-files.ts.
 *
 * A re-read renews identity and nothing else it may keep: the file's rows, periods, anchors and holding events are
 * written again under new ids and a new `import_files` row, and the older read's rows are retired. So a face leaves out
 * exactly that identity (row ids, file ids, period ids, stamps) and keeps every column a figure, a category, a note, a
 * link or a balance is made of — and compares the rest of the database table by table, whole, so a table added later is
 * guarded without anyone listing it here.
 *
 * What a re-read MAY change, each named in the verdict rather than hidden in it:
 *  - the older reads retire and the new reads stand in their place (same name, bytes and archived original);
 *  - the records the re-read exists to write (`printed_lines`, and any `statement_copies` / `account_numbers`);
 *  - a dedupe key that now agrees with the day its row carries (the Discover v1 keys were derived from a back-dated Post
 *    Date that scripts/fix-discover-backdated-adjustments.ts had re-dated in place — measured 2026-09-28: 3 rows);
 *  - days after an account's last cached balance, when each is exactly what `rebuildAccount` writes on a copy of the
 *    untouched ledger today: the import rebuilds the accounts it read, and a cache last rebuilt on Sep 14 is carried to
 *    today (measured 2026-09-28: Discover 14 days, Robinhood Agentic 13, Robinhood Cash 13 — the dashboard's "15 days
 *    unchecked" for Robinhood Cash becomes the true 28) — and net worth's series runs as far as they do;
 *  - which of the two statements that print a month-end balance the balance cites, between two of the new reads, when
 *    the new one's own period prints that balance on that day (`compareAnchors` — 26 on 2026-09-28).
 * Anything else refuses.
 */
import path from "node:path";
import type { DbBundle } from "@/db/client";
import { addDays, todayIso } from "@/lib/dates";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { netWorthSeries } from "@/services/derivation";
import { summaryYears, yearSummaryView } from "@/services/year-summary";

type Row = Record<string, unknown>;
type Multiset = Map<string, number>;

/** Stamps every write moves; no figure is made of them. */
const STAMPS = ["created_at", "updated_at"] as const;

/** Tables the face reads by their own rule; every other table is compared whole, by content. */
const OWN_RULE = new Set([
  "transactions",
  "transaction_splits",
  "daily_balances",
  "statement_periods",
  "balance_anchors",
  "holding_events",
  "import_files",
  "printed_lines",
  "statement_copies",
  "account_numbers",
]);
/** The records a re-read exists to write. */
export const RECORD_TABLES = ["printed_lines", "statement_copies", "account_numbers"] as const;
/** Columns elsewhere that name a transaction — read as the row's content, since a re-read renews the id. */
const ROW_REFERENCES: Record<string, readonly string[]> = {
  duplicate_candidates: ["transaction_id_a", "transaction_id_b", "retired_transaction_id"],
  transfer_ambiguities: ["anchor_transaction_id"],
  unimported_transfer_legs: ["transaction_id"],
};

interface Anchor {
  cents: number;
  file: string | null;
  period: string | null;
}

interface Period {
  file: string;
  start: string;
  end: string;
  opens: number | null;
  closes: number | null;
}

export interface LedgerFace {
  /** every transaction by id, every column but `updated_at` */
  rows: Map<string, Row>;
  /** rows not superseded, by content: no id, no file, no dedupe key, the period as its span */
  live: Multiset;
  /** each live content's dedupe keys, sorted */
  keys: Map<string, string[]>;
  splits: Multiset;
  /** `account \x1f day` → `balance \x1f basis` */
  balances: Map<string, string>;
  /** statement periods, anchors, holding events and every table without a rule of its own, by content */
  tables: Map<string, Multiset>;
  /** `account \x1f day \x1f source` → the balance, and the file and period it cites */
  anchors: Map<string, Anchor>;
  /** statement periods by id — which days each prints */
  periods: Map<string, Period>;
  /** `import_files` by id, every column but `updated_at` */
  files: Map<string, Row>;
  /** `table \x1f id` → the record, every column but `updated_at` */
  records: Map<string, Row>;
  /** day → net worth, as the dashboard computes it */
  netWorth: Map<string, number>;
  /** every /summary year, as the page computes it — his 2026 return among them */
  summaries: string;
  /** the figures he asked after, as the pages print them: net worth today, each year's money-weighted return */
  headline: string;
  /** for messages: account and category names */
  accountNames: Map<string, string>;
  categoryNames: Map<string, string>;
}

const without = (row: Row, drop: readonly string[]): Row =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));
const bump = (m: Multiset, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};

function all(bundle: DbBundle, sql: string): Row[] {
  return bundle.sqlite.prepare(sql).all() as Row[];
}

/** A row's content: what the owner sees of it, and nothing a re-read renews. */
function contentOf(row: Row, spans: ReadonlyMap<string, string>): string {
  const { statement_period_id: period, ...rest } = without(row, ["id", "import_file_id", "dedupe_hash", ...STAMPS]);
  return JSON.stringify({ ...rest, period: period === null ? null : spans.get(String(period)) ?? "?" });
}

/** Every transaction by id, and the live ones by content — each row's content kept for what else names it. */
function rowFaces(bundle: DbBundle, spans: ReadonlyMap<string, string>) {
  const rows = new Map<string, Row>();
  const contentById = new Map<string, string>();
  const live: Multiset = new Map();
  const keys = new Map<string, string[]>();
  for (const row of all(bundle, "SELECT * FROM transactions")) {
    const id = String(row.id);
    rows.set(id, without(row, ["updated_at"]));
    const content = contentOf(row, spans);
    contentById.set(id, content);
    if (row.status === "superseded") continue;
    bump(live, content);
    keys.set(content, [...(keys.get(content) ?? []), String(row.dedupe_hash)].sort());
  }
  const splits: Multiset = new Map();
  for (const s of all(bundle, "SELECT * FROM transaction_splits")) {
    const row = contentById.get(String(s.transaction_id)) ?? null;
    bump(splits, JSON.stringify({ ...without(s, ["id", "transaction_id", ...STAMPS]), row }));
  }
  return { rows, contentById, live, keys, splits };
}

/** Periods, the balance on each anchored day, holding events, and every table without a rule of its own. */
function tableFaces(bundle: DbBundle, contentById: ReadonlyMap<string, string>): Map<string, Multiset> {
  const tables = new Map<string, Multiset>();
  const byContent = (table: string, drop: readonly string[], map: (r: Row) => Row = (r) => r) => {
    const m: Multiset = new Map();
    for (const r of all(bundle, `SELECT * FROM "${table}"`)) bump(m, JSON.stringify(map(without(r, drop))));
    tables.set(table, m);
  };
  byContent("statement_periods", ["id", "import_file_id", ...STAMPS]);
  // the balance on each day, whoever prints it — which statement it cites is `anchors`, compared by its own rule
  byContent("balance_anchors", ["id", "import_file_id", "statement_period_id", ...STAMPS]);
  byContent("holding_events", ["id", "import_file_id", ...STAMPS]);
  const others = all(bundle, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((t) => String(t.name))
    .filter((t) => !OWN_RULE.has(t));
  for (const table of others) {
    const refs = ROW_REFERENCES[table] ?? [];
    const named = (r: Row, c: string) =>
      r[c] === null || r[c] === undefined ? null : contentById.get(String(r[c])) ?? "?";
    byContent(table, ["id", ...STAMPS], (r) => ({ ...r, ...Object.fromEntries(refs.map((c) => [c, named(r, c)])) }));
  }
  return tables;
}

/** Which file and period each recorded balance cites, and which days each period prints. */
function citationFaces(bundle: DbBundle): Pick<LedgerFace, "anchors" | "periods"> {
  const anchors = new Map<string, Anchor>();
  for (const a of all(bundle, "SELECT * FROM balance_anchors")) {
    anchors.set(`${a.account_id}\x1f${a.anchored_on}\x1f${a.source}`, {
      cents: Number(a.balance_cents),
      file: a.import_file_id === null ? null : String(a.import_file_id),
      period: a.statement_period_id === null ? null : String(a.statement_period_id),
    });
  }
  const periods = new Map<string, Period>();
  for (const p of all(bundle, "SELECT * FROM statement_periods")) {
    periods.set(String(p.id), {
      file: String(p.import_file_id),
      start: String(p.period_start),
      end: String(p.period_end),
      opens: p.beginning_balance_cents === null ? null : Number(p.beginning_balance_cents),
      closes: p.ending_balance_cents === null ? null : Number(p.ending_balance_cents),
    });
  }
  return { anchors, periods };
}

/** The figures, as the dashboard and /summary compute them. */
function figureFaces(bundle: DbBundle, today: string): Pick<LedgerFace, "netWorth" | "summaries" | "headline"> {
  const series = netWorthSeries(bundle.db);
  const views = summaryYears(bundle.db).map((y) => yearSummaryView(bundle.db, y, today));
  const last = series.at(-1);
  const rate = (v: (typeof views)[number]) =>
    v.moneyWeightedReturn.computed ? `${(v.moneyWeightedReturn.rate * 100).toFixed(2)}%` : "not calculated";
  return {
    netWorth: new Map(series.map((p) => [p.day, p.totalCents])),
    summaries: JSON.stringify(views),
    headline: [
      last === undefined ? "no net worth" : `net worth ${formatCents(last.totalCents)} on ${last.day}`,
      `/summary return ${views.map((v) => `${v.year} ${rate(v)}`).join(" · ")}`,
    ].join(" · "),
  };
}

function nameFaces(bundle: DbBundle): Pick<LedgerFace, "accountNames" | "categoryNames"> {
  const categoryRows = all(bundle, "SELECT id, name, parent_id FROM categories");
  const byId = new Map(categoryRows.map((c) => [String(c.id), c]));
  const pathOf = (c: Row) => {
    const parent = c.parent_id === null ? undefined : byId.get(String(c.parent_id));
    return parent === undefined ? String(c.name) : `${String(parent.name)} › ${String(c.name)}`;
  };
  return {
    accountNames: new Map(all(bundle, "SELECT id, name FROM accounts").map((a) => [String(a.id), String(a.name)])),
    categoryNames: new Map(categoryRows.map((c) => [String(c.id), pathOf(c)])),
  };
}

/** Every cached balance: `account \x1f day` → `balance \x1f basis` — ONE reading, for the face and for the rebuild. */
export function balancesOf(bundle: DbBundle): Map<string, string> {
  return new Map(
    all(bundle, "SELECT account_id, day, balance_cents, basis FROM daily_balances").map((b) => [
      `${b.account_id}\x1f${b.day}`,
      `${b.balance_cents}\x1f${b.basis}`,
    ]),
  );
}

export function ledgerFace(bundle: DbBundle, today: string = todayIso()): LedgerFace {
  const spans = new Map(
    all(bundle, "SELECT id, account_id, period_start, period_end FROM statement_periods").map((p) => [
      String(p.id),
      `${p.account_id}|${p.period_start}|${p.period_end}`,
    ]),
  );
  const { rows, contentById, live, keys, splits } = rowFaces(bundle, spans);
  const balances = balancesOf(bundle);
  const records = new Map<string, Row>();
  for (const table of RECORD_TABLES) {
    for (const r of all(bundle, `SELECT * FROM ${table}`)) records.set(`${table}\x1f${r.id}`, without(r, ["updated_at"]));
  }
  const files = new Map(all(bundle, "SELECT * FROM import_files").map((f) => [String(f.id), without(f, ["updated_at"])]));
  return {
    rows,
    live,
    keys,
    splits,
    balances,
    tables: tableFaces(bundle, contentById),
    ...citationFaces(bundle),
    files,
    records,
    ...figureFaces(bundle, today),
    ...nameFaces(bundle),
  };
}

/** One file the re-read retires, and what must stand in its place. */
export interface RereadTarget {
  /** the older read's `import_files.id` */
  id: string;
  fileName: string;
  sha: string;
  profile: string;
  /** the version the profile reads at now — the new read's */
  version: number;
  /** its original as the archive lays it out, `<folder>/<name>` — the new read's must be the same one */
  archived: string;
}

/**
 * An original as the archive lays it out: `<root>/<account folder>/<sha prefix>-<name>` (`resolveArchiveFolder`), read
 * without its root — the root is the run's (`RereadExpectation.archiveRoot`).
 */
export function archivedAs(storagePath: string): string {
  return path.join(path.basename(path.dirname(storagePath)), path.basename(storagePath));
}

export interface RereadExpectation {
  targets: readonly RereadTarget[];
  /** `account \x1f day` → `balance \x1f basis`, as `rebuildAccount` writes them on a copy of the untouched ledger */
  rebuilt: ReadonlyMap<string, string>;
  /**
   * Where the run archived: each new read's original must be `<archiveRoot>/<target.archived>` — on the real ledger its
   * own statements root, so the very original its older read names. 🔴 Compared as `<folder>/<name>` alone, a real
   * write that archived outside data/statements read PASS (the review of uc/reread-34-runbook, 2026-09-29).
   */
  archiveRoot: string;
}

/**
 * `face` with each file's `storage_path` replaced as `paths` says, and nothing else — the real ledger as its rehearsal
 * copy reads it once every row is pointed into scratch (`copyArchiveInto`). Compared with the copy after the import, so
 * the rehearsal still reads the copy against the ledger itself.
 */
export function withStoragePaths(face: LedgerFace, paths: ReadonlyMap<string, string>): LedgerFace {
  const files = new Map([...face.files].map(([id, f]) => [id, { ...f, storage_path: paths.get(id) ?? f.storage_path }] as const));
  return { ...face, files };
}

export interface Verdict {
  failures: string[];
  /** what changed that a re-read may change — said, never silent */
  allowed: string[];
  /** the allowed changes as data: a real write must make exactly its rehearsal's */
  signature: string;
}

const MAX_EXAMPLES = 8;

function sameRow(a: Row, b: Row, except: readonly string[] = []): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => !except.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

function multisetDelta(a: Multiset, b: Multiset): { gone: string[]; came: string[] } {
  const gone: string[] = [];
  const came: string[] = [];
  for (const [k, n] of a) for (let i = (b.get(k) ?? 0); i < n; i++) gone.push(k);
  for (const [k, n] of b) for (let i = (a.get(k) ?? 0); i < n; i++) came.push(k);
  return { gone, came };
}

/** `"CORNER GROCER" · Chase Checking · 2026-03-12 · -$25.00 · Food › Groceries (bank_category) · active` */
function describeContent(content: string, face: LedgerFace): string {
  const r = JSON.parse(content) as Row;
  const category =
    r.category_id === null ? "no category" : face.categoryNames.get(String(r.category_id)) ?? String(r.category_id);
  return [
    `"${String(r.raw_description)}"`,
    face.accountNames.get(String(r.account_id)) ?? String(r.account_id),
    String(r.posted_on),
    formatCentsSigned(Number(r.amount_cents)),
    `${category} (${String(r.categorization_source)})`,
    String(r.status),
  ].join(" · ");
}

function examples(lines: readonly string[]): string {
  const more = lines.length > MAX_EXAMPLES ? `; … ${lines.length - MAX_EXAMPLES} more` : "";
  return `${lines.slice(0, MAX_EXAMPLES).join("; ")}${more}`;
}

/** The files: each older read retired, one new read in its place with the same name, bytes and original. */
function compareFiles(
  before: LedgerFace,
  after: LedgerFace,
  expect: RereadExpectation,
): { failures: string[]; fresh: Map<string, RereadTarget> } {
  const failures: string[] = [];
  const retiring = new Set(expect.targets.map((t) => t.id));
  for (const [id, row] of before.files) {
    const now = after.files.get(id);
    if (now === undefined) {
      failures.push(`import file ${String(row.file_name)} (${id}) is gone`);
      continue;
    }
    const name = String(row.file_name);
    const moved = sameRow(row, now, retiring.has(id) ? ["status"] : []);
    if (moved.length > 0) failures.push(`import file ${name} (${id}) changed: ${moved.join(", ")}`);
    if (retiring.has(id) && now.status !== "superseded") {
      failures.push(`the older read of ${name} was not retired (${String(now.status)})`);
    }
  }
  const fresh = new Map<string, RereadTarget>();
  const unclaimed = new Map([...after.files].filter(([id]) => !before.files.has(id)));
  for (const t of expect.targets) {
    const [id, row] = [...unclaimed].find(([, f]) => f.file_sha256 === t.sha && f.parser_version === t.version) ?? [];
    if (id === undefined || row === undefined) {
      failures.push(`${t.fileName} was not read again at ${t.profile} v${t.version}`);
      continue;
    }
    unclaimed.delete(id);
    fresh.set(id, t);
    const archived = path.join(expect.archiveRoot, t.archived);
    const wrong = [
      row.status === "parsed" ? null : `status ${String(row.status)}`,
      row.error === null ? null : `error ${String(row.error)}`,
      row.file_name === t.fileName ? null : `named ${String(row.file_name)}`,
      row.parser_profile === t.profile ? null : `profile ${String(row.parser_profile)}`,
      row.storage_path === archived ? null : `archived at ${String(row.storage_path)}, not ${archived}`,
    ].filter((w) => w !== null);
    if (wrong.length > 0) failures.push(`the new read of ${t.fileName}: ${wrong.join(", ")}`);
  }
  for (const [, row] of unclaimed) failures.push(`an import file nobody asked for: ${String(row.file_name)} (${String(row.status)})`);
  return { failures, fresh };
}

/** The rows: every row by id as it was (the retired reads' rows superseded, nothing else), and the live rows by content. */
function compareRows(
  before: LedgerFace,
  after: LedgerFace,
  expect: RereadExpectation,
  fresh: ReadonlyMap<string, RereadTarget>,
): { failures: string[]; keyChanges: string[] } {
  const failures: string[] = [];
  const retiring = new Set(expect.targets.map((t) => t.id));
  const changed: string[] = [];
  for (const [id, row] of before.rows) {
    const now = after.rows.get(id);
    if (now === undefined) {
      changed.push(`"${String(row.raw_description)}" ${String(row.posted_on)} (${id}) is gone`);
      continue;
    }
    const retires = retiring.has(String(row.import_file_id)) && row.status !== "superseded";
    const moved = sameRow(row, now, retires ? ["status"] : []);
    if (retires && now.status !== "superseded") moved.push(`status ${String(row.status)} → ${String(now.status)}`);
    if (moved.length > 0) changed.push(`"${String(row.raw_description)}" ${String(row.posted_on)} (${id}): ${moved.join(", ")}`);
  }
  if (changed.length > 0) failures.push(`${changed.length} existing row(s) changed: ${examples(changed)}`);
  const stray = [...after.rows]
    .filter(([id, r]) => !before.rows.has(id) && !fresh.has(String(r.import_file_id)))
    .map(([id, r]) => `"${String(r.raw_description)}" (${id})`);
  if (stray.length > 0) failures.push(`${stray.length} new row(s) under no re-read file: ${examples(stray)}`);

  const { gone, came } = multisetDelta(before.live, after.live);
  if (gone.length + came.length > 0) {
    failures.push(
      `the live rows are not the same money, days, descriptions, categories, notes and links — ` +
        `only before: ${examples(gone.map((c) => describeContent(c, before)))}` +
        ` | only after: ${examples(came.map((c) => describeContent(c, after)))}`,
    );
  }
  const keyChanges: string[] = [];
  const short = (keys: readonly string[]) => keys.map((k) => k.slice(0, 12)).join(",");
  for (const [content, keys] of before.keys) {
    const now = after.keys.get(content);
    if (now !== undefined && JSON.stringify(now) !== JSON.stringify(keys)) {
      keyChanges.push(`dedupe key of ${describeContent(content, before)}: ${short(keys)} → ${short(now)}`);
    }
  }
  const splits = multisetDelta(before.splits, after.splits);
  if (splits.gone.length + splits.came.length > 0) failures.push(`${splits.gone.length} split(s) gone, ${splits.came.length} came`);
  return { failures, keyChanges };
}

/** Every cached day as it was; a new day only after the account's last one, and only what a rebuild writes. */
function compareBalances(
  before: LedgerFace,
  after: LedgerFace,
  expect: RereadExpectation,
): { failures: string[]; carried: string[] } {
  const failures: string[] = [];
  const moved: string[] = [];
  const last = new Map<string, string>();
  const cell = (value: string | undefined) => value?.replace("\x1f", " ") ?? "nothing";
  for (const [key, value] of before.balances) {
    const [account, day] = key.split("\x1f") as [string, string];
    if (day > (last.get(account) ?? "")) last.set(account, day);
    const now = after.balances.get(key);
    if (now !== value) moved.push(`${before.accountNames.get(account) ?? account} ${day}: ${cell(value)} → ${cell(now)}`);
  }
  if (moved.length > 0) failures.push(`${moved.length} balance day(s) moved: ${examples(moved)}`);
  const tails = new Map<string, { n: number; to: string }>();
  const wrong: string[] = [];
  for (const [key, value] of after.balances) {
    if (before.balances.has(key)) continue;
    const [account, day] = key.split("\x1f") as [string, string];
    const name = after.accountNames.get(account) ?? account;
    const rebuilt = expect.rebuilt.get(key);
    if (day <= (last.get(account) ?? "")) wrong.push(`${name} ${day}: a day inside the cache the re-read added`);
    else if (rebuilt !== value) wrong.push(`${name} ${day}: ${cell(value)}, a rebuild of the untouched ledger writes ${cell(rebuilt)}`);
    else {
      const t = tails.get(name) ?? { n: 0, to: day };
      tails.set(name, { n: t.n + 1, to: day > t.to ? day : t.to });
    }
  }
  if (wrong.length > 0) failures.push(`${wrong.length} new balance day(s) no rebuild writes: ${examples(wrong)}`);
  const carried = [...tails]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, t]) => `${name}: ${t.n} day(s) carried to ${t.to}`);
  return { failures, carried };
}

/** The records: every one kept as it was; new ones only under the new reads, and every new read holds one. */
function compareRecords(
  before: LedgerFace,
  after: LedgerFace,
  fresh: ReadonlyMap<string, RereadTarget>,
): { failures: string[]; written: string[] } {
  const failures: string[] = [];
  for (const [key, row] of before.records) {
    const now = after.records.get(key);
    if (now === undefined || sameRow(row, now).length > 0) failures.push(`record ${key.replace("\x1f", " ")} changed or is gone`);
  }
  const counts = new Map<string, number>(RECORD_TABLES.map((t) => [t, 0]));
  const linesByFile = new Map<string, number>();
  for (const [key, row] of after.records) {
    if (before.records.has(key)) continue;
    const table = key.split("\x1f")[0] as string;
    counts.set(table, (counts.get(table) ?? 0) + 1);
    if (table === "account_numbers") continue;
    const file = String(row.import_file_id);
    if (!fresh.has(file)) failures.push(`a new ${table} record under a file the re-read did not write (${file})`);
    else if (table === "printed_lines") linesByFile.set(file, (linesByFile.get(file) ?? 0) + 1);
  }
  for (const [id, t] of fresh) if (!linesByFile.has(id)) failures.push(`${t.fileName} was read again and still records nothing it prints`);
  const written = [
    `${counts.get("printed_lines")} printed-line record(s) over ${linesByFile.size} file(s)`,
    `${counts.get("statement_copies")} statement cop(ies)`,
    `${counts.get("account_numbers")} card number(s)`,
  ];
  return { failures, written };
}

/**
 * Which statement each recorded balance cites. Two statements print a month-end balance — one closes on it, the next
 * opens the day after — and the anchor belongs to whichever file wrote it last (`upsertAnchor`), so a re-read that reads
 * the months oldest first (`oldestFirstWhereItMatters`) hands each boundary to the month that opens after it. Measured
 * on the real ledger 2026-09-28: 26 Robinhood month-ends, each printed by both of its statements, same balance, same
 * day — the provenance sheet of that day names the other statement. Allowed only in that form: from an older read to a
 * new read whose own period prints that balance on that day. An anchor any other file cites keeps its file and period.
 */
function compareAnchors(
  before: LedgerFace,
  after: LedgerFace,
  fresh: ReadonlyMap<string, RereadTarget>,
): { failures: string[]; handed: string[] } {
  const successorOf = new Map([...fresh].map(([newId, t]) => [t.id, newId] as const));
  const span = (face: LedgerFace, id: string | null) => {
    const p = id === null ? undefined : face.periods.get(id);
    return p === undefined ? "" : `${p.start}..${p.end}`;
  };
  const cites = (face: LedgerFace, a: Anchor) =>
    `${a.file === null ? "no file" : String(face.files.get(a.file)?.file_name ?? a.file)} ${span(face, a.period)}`;
  const wrong: string[] = [];
  const handed: string[] = [];
  for (const [key, was] of before.anchors) {
    const [account, day, source] = key.split("\x1f") as [string, string, string];
    const where = `${before.accountNames.get(account) ?? account} ${day} (${source})`;
    const now = after.anchors.get(key);
    if (now === undefined || now.cents !== was.cents) {
      wrong.push(`${where}: ${formatCentsSigned(was.cents)} → ${now === undefined ? "gone" : formatCentsSigned(now.cents)}`);
      continue;
    }
    const successor = was.file === null ? null : successorOf.get(was.file) ?? was.file;
    if (now.file === successor && span(after, now.period) === span(before, was.period)) continue;
    const move = `${where} ${formatCentsSigned(now.cents)}: ${cites(before, was)} → ${cites(after, now)}`;
    const between = was.file !== null && successorOf.has(was.file) && now.file !== null && fresh.has(now.file);
    if (between && printsOn(after, now, day)) handed.push(move);
    else wrong.push(move);
  }
  for (const key of after.anchors.keys()) {
    if (!before.anchors.has(key)) wrong.push(`an anchor appeared: ${key.replaceAll("\x1f", " ")}`);
  }
  return {
    failures: wrong.length > 0 ? [`${wrong.length} recorded balance(s) moved or cite another statement: ${examples(wrong)}`] : [],
    handed:
      handed.length > 0
        ? [`${handed.length} month-end balance(s) now cite the other statement that prints them (same day, same balance): ${examples(handed)}`]
        : [],
  };
}

/** The anchor's own period prints its balance on its day: it closes on it, or opens the day after (`printed-anchors`). */
function printsOn(face: LedgerFace, anchor: Anchor, day: string): boolean {
  const period = anchor.period === null ? undefined : face.periods.get(anchor.period);
  if (period === undefined || period.file !== anchor.file) return false;
  return (
    (period.end === day && period.closes === anchor.cents) ||
    (addDays(period.start, -1) === day && period.opens === anchor.cents)
  );
}

/** Does `after` differ from `before` only as a re-read of `expect.targets` may make it differ? */
export function compareFaces(before: LedgerFace, after: LedgerFace, expect: RereadExpectation): Verdict {
  const files = compareFiles(before, after, expect);
  const rows = compareRows(before, after, expect, files.fresh);
  const balances = compareBalances(before, after, expect);
  const records = compareRecords(before, after, files.fresh);
  const anchors = compareAnchors(before, after, files.fresh);
  const tables: string[] = [];
  for (const [table, rowsBefore] of before.tables) {
    const { gone, came } = multisetDelta(rowsBefore, after.tables.get(table) ?? new Map());
    if (gone.length + came.length === 0) continue;
    tables.push(`${table}: ${gone.length} row(s) gone, ${came.length} came — e.g. ${[...gone, ...came][0]?.slice(0, 300)}`);
  }
  for (const table of after.tables.keys()) if (!before.tables.has(table)) tables.push(`a table appeared: ${table}`);
  const netWorth = compareNetWorth(before, after);
  const figures = [
    ...netWorth.failures,
    ...(before.summaries === after.summaries ? [] : ["a /summary year moved (its return, income or spending)"]),
  ];
  const failures = [
    ...files.failures,
    ...rows.failures,
    ...balances.failures,
    ...anchors.failures,
    ...records.failures,
    ...tables,
    ...figures,
  ];
  const allowed = [
    `${files.fresh.size} file(s) read again at their profile's version; the older reads retired`,
    ...records.written,
    ...balances.carried,
    ...netWorth.extended,
    ...anchors.handed,
    ...rows.keyChanges,
  ];
  return {
    failures,
    allowed,
    signature: JSON.stringify([records.written, balances.carried, netWorth.extended, anchors.handed, rows.keyChanges]),
  };
}

/**
 * Net worth on every day it had, to the cent. It may only run LONGER — the carried days above reach today, and the
 * series ends where the caches end — never differ on a day it already had, nor gain one inside its span.
 */
function compareNetWorth(before: LedgerFace, after: LedgerFace): { failures: string[]; extended: string[] } {
  const last = [...before.netWorth.keys()].reduce((a, b) => (b > a ? b : a), "");
  const shown = (cents: number | undefined) => (cents === undefined ? "gone" : formatCents(cents));
  const moved = [...before.netWorth]
    .filter(([day, cents]) => after.netWorth.get(day) !== cents)
    .map(([day, cents]) => `${day} ${shown(cents)} → ${shown(after.netWorth.get(day))}`);
  const inside = [...after.netWorth.keys()].filter((day) => !before.netWorth.has(day) && day <= last);
  const beyond = [...after.netWorth.keys()].filter((day) => day > last).sort();
  return {
    failures: [
      ...(moved.length > 0 ? [`net worth moved on ${moved.length} day(s): ${examples(moved)}`] : []),
      ...(inside.length > 0 ? [`net worth gained ${inside.length} day(s) inside its span: ${examples(inside)}`] : []),
    ],
    extended: beyond.length > 0 ? [`net worth runs ${beyond.length} day(s) further, to ${beyond.at(-1)}`] : [],
  };
}

/**
 * Two faces of one ledger, equal in everything — the ledger has not moved between two reads of it. Entries are sorted
 * by key: a restored snapshot is a `VACUUM INTO` copy, and VACUUM renumbers the rowids a `SELECT *` walks in.
 */
export function sameFace(a: LedgerFace, b: LedgerFace): boolean {
  const sorted = <V>(m: ReadonlyMap<string, V>): [string, V][] => [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const flat = (f: LedgerFace) =>
    JSON.stringify([
      sorted(f.rows),
      sorted(f.balances),
      sorted(f.tables).map(([t, m]) => [t, sorted(m)]),
      sorted(f.anchors),
      sorted(f.periods),
      sorted(f.files),
      sorted(f.records),
      sorted(f.splits),
      sorted(f.netWorth),
      f.summaries,
    ]);
  return flat(a) === flat(b);
}
