/**
 * REAL-DB WRITE (dry-run by default). Extends the Robinhood Crypto ETH book
 * through the July and August 2026 crypto statements.
 *
 * ## What is wrong
 *
 * The book ends in a hand-entered row, written through `upsertHolding` on the
 * day the owner read his quantity off the app:
 *
 *     ETH  2026-07-10  -2.798146  cost $5,452.38  (= avg cost $1,948.57 × 2.798146)
 *     "user-confirmed current quantity — July activity, statement pending"
 *
 * The statement is no longer pending, and it disagrees with the row on
 * everything but the quantity. July page 3 prints that same 2.798146 ETH as a
 * Crypto Sale dated **2026-07-07** (not 07-10) for **$4,999.75** — and then
 * twelve daily purchases the book has never held. August page 3 prints two more
 * sales. So the book reads 14.619066 ETH at both closes, where the statements
 * print 15.237469 (07-31) and 14.203959 (08-31).
 *
 * ## What this writes
 *
 *   - deletes the placeholder (matched by id AND every field, never by id alone)
 *   - inserts the 15 statement trades, cost = the statement's VALUE column (the
 *     cash the trade moved — the October-backfill convention), note in the
 *     `Sale 0.050056 ETH (statement 2026-05)` form of the rows beside them
 *   - sets `holdings.quantity_e8` to the new event sum, because provenance's
 *     share-count gate asserts exactly that equality. `avg_cost_cents` is left
 *     alone: no statement prints a cost basis, so any new figure would be derived.
 *
 * ⛔ Nothing else. No transaction, statement period or balance anchor — the two
 * PDFs are not imported yet, and importing them through the app is what adds
 * those. The importer writes no holding_events, so an import after this script
 * cannot count a coin twice.
 *
 * Every figure below is re-read from the PDFs on each run and the script refuses
 * if one disagrees with the frozen table. The arbiter is exact: the trades must
 * carry the June close to each printed close to the last 1e-8 of a coin.
 *
 *   npx tsx scripts/extend-eth-history-2026-08.ts                         # DRY RUN on a throwaway .backup of data/moneyapp.db
 *   npx tsx scripts/extend-eth-history-2026-08.ts --db <path>             # DRY RUN, <path> opened read-only
 *   npx tsx scripts/extend-eth-history-2026-08.ts --db <path> --confirm   # WRITES to <path>
 *
 * ⚠️ `--confirm` needs an explicit `--db`; against data/moneyapp.db, stop the dev server first.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type AppDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import { accounts } from "@/db/schema";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings } from "@/db/schema/holdings";
import { formatCents, parseAmountToCents } from "@/lib/money";
import { formatQuantityE8, parseQuantityE8 } from "@/lib/robinhood-holdings";
import { rebuildAccount } from "@/services/derivation";
import { extractLines } from "@/services/import/profiles/pdf-profile";

/* ── the record ─────────────────────────────────────────────────────── */

const ACCOUNT_NAME = "Robinhood Crypto";
const SYMBOL = "ETH";
const SNAPSHOT_LABEL = "extend-eth-history-2026-08";
const REAL_DB = path.resolve(process.cwd(), "data", "moneyapp.db");
const END_OF_TIME = "9999-12-31";

const PLACEHOLDER = {
  id: "019f4cab-7592-75db-82cf-e1d54612865a",
  occurredOn: "2026-07-10",
  deltaE8: -279_814_600,
  costCents: 545_238,
  note: "user-confirmed current quantity — July activity, statement pending",
} as const;

/**
 * Where the book stands going in — the June 2026 statement, already imported
 * (data/statements/robinhood-crypto-8474/6c38cf345a50d15a-robinhood-crypto-statement-2026-06.pdf),
 * page 2: `Ethereum 17.417212 ETH $27359.93 100%` · `CLOSING BALANCE $27359.92709892`.
 * Checked against the database's own book on every run.
 */
const JUNE_CLOSE = { day: "2026-06-30", quantity: "17.417212", closingBalance: "27359.92709892" } as const;

interface StatementSpec {
  readonly label: string;
  readonly file: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly heldQuantity: string;
  readonly rowCount: number;
}

/** Page 2 carries PERIOD / BALANCE / CRYPTOCURRENCY HELD; page 3 the ACCOUNT ACTIVITY rows. */
const STATEMENTS: readonly StatementSpec[] = [
  {
    label: "2026-07",
    file: "statements/robinhood-crypto/robinhood-crypto-2026-07.pdf",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    openingBalance: "27359.92709892",
    closingBalance: "28365.48180495",
    heldQuantity: "15.237469",
    rowCount: 13, // one sale, twelve purchases
  },
  {
    label: "2026-08",
    file: "statements/robinhood-crypto/robinhood-crypto-2026-08.pdf",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    openingBalance: "28365.48180495",
    closingBalance: "35017.18251536",
    heldQuantity: "14.203959",
    rowCount: 2, // two sales
  },
];

const CLOSES = [
  { day: JUNE_CLOSE.day, quantity: JUNE_CLOSE.quantity, closingBalance: JUNE_CLOSE.closingBalance, cite: "2026-06 statement p2" },
  ...STATEMENTS.map((s) => ({ day: s.periodEnd, quantity: s.heldQuantity, closingBalance: s.closingBalance, cite: `${s.label} statement p2` })),
] as const;

/** The PDF covers two crypto accounts; the ETH one ends 8474 (its storage dir is robinhood-crypto-8474). */
const ETH_ACCOUNT_RE = /^ACCOUNT NUMBER \d*8474$/;
const ANY_ACCOUNT_RE = /^ACCOUNT NUMBER \d+$/;
/** DATE TYPE DEBIT CREDIT PRICE VALUE FEE */
const ROW_RE =
  /^(\d{4}-\d{2}-\d{2}) (Crypto Purchase|Crypto Sale) (--|[\d.]+ [A-Z]+) (--|[\d.]+ [A-Z]+) \$([\d.]+) \$(\d+\.\d{2}) (--|\$[\d.]+)$/;
const FIELD_RES = {
  periodStart: /^PERIOD START (\d{4}-\d{2}-\d{2})$/,
  periodEnd: /^PERIOD END (\d{4}-\d{2}-\d{2})$/,
  openingBalance: /^OPENING BALANCE \$([\d.]+)$/,
  closingBalance: /^CLOSING BALANCE \$([\d.]+)$/,
  heldQuantity: /^Ethereum ([\d.]+) ETH \$[\d.]+ 100%$/,
} as const;
type FieldName = keyof typeof FIELD_RES;

/* ── plumbing ───────────────────────────────────────────────────────── */

class Refusal extends Error {}

const failures: string[] = [];
function guard(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(54)} ${detail}`);
  if (!ok) failures.push(name);
}

const qty = (e8: bigint | number): string => formatQuantityE8(BigInt(e8));
const signed = (e8: bigint | number): string => (BigInt(e8) > 0n ? `+${qty(e8)}` : qty(e8));
const offBy = (c: number): string => (c >= 0 ? `+${formatCents(c)}` : `-${formatCents(-c)}`);

interface Cli {
  readonly dbPath: string | null;
  readonly confirm: boolean;
}

/** Throws before any file is opened, so `--confirm` without `--db` touches nothing. */
function parseCli(argv: readonly string[]): Cli {
  let dbPath: string | null = null;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--db") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Refusal("--db needs a path");
      dbPath = value;
      i += 1;
    } else if (arg.startsWith("--db=") && arg.length > "--db=".length) {
      dbPath = arg.slice("--db=".length);
    } else {
      throw new Refusal(`unknown argument ${arg}`);
    }
  }
  if (confirm && dbPath === null) {
    throw new Refusal("--confirm writes only to an explicit --db <path> — nothing was opened, nothing written");
  }
  return { dbPath, confirm };
}

/* ── reading the statements ─────────────────────────────────────────── */

interface PdfLine {
  readonly page: number;
  readonly text: string;
}
interface Captured {
  readonly value: string;
  readonly page: number;
  readonly text: string;
}
interface StatementTrade {
  readonly statement: string;
  readonly file: string;
  readonly page: number;
  readonly line: string;
  readonly day: string;
  readonly side: "Purchase" | "Sale";
  readonly quantity: string;
  readonly deltaE8: bigint;
  readonly price: string;
  readonly valueCents: number;
}
interface ReadStatement {
  readonly spec: StatementSpec;
  readonly sha256: string;
  readonly fields: Readonly<Record<FieldName, Captured>>;
  readonly trades: readonly StatementTrade[];
}

function splitAccounts(lines: readonly PdfLine[]): { eth: PdfLine[]; other: PdfLine[] } {
  const eth: PdfLine[] = [];
  const other: PdfLine[] = [];
  let current: PdfLine[] | null = null;
  for (const line of lines) {
    if (ANY_ACCOUNT_RE.test(line.text)) current = ETH_ACCOUNT_RE.test(line.text) ? eth : other;
    if (current !== null) current.push(line);
  }
  return { eth, other };
}

function singleCapture(file: string, lines: readonly PdfLine[], re: RegExp): Captured {
  const hits = lines.flatMap((l) => {
    const m = re.exec(l.text);
    return m ? [{ value: m[1] as string, page: l.page, text: l.text }] : [];
  });
  if (hits.length !== 1) throw new Refusal(`${file}: expected one line matching ${re}, found ${hits.length}`);
  return hits[0] as Captured;
}

function toTrade(spec: StatementSpec, line: PdfLine, m: RegExpExecArray): StatementTrade {
  const where = `${spec.file} p${line.page} "${line.text}"`;
  const group = (i: number): string => {
    const v = m[i];
    if (v === undefined) throw new Refusal(`${where}: column ${i} missing`);
    return v;
  };
  const side = group(2) === "Crypto Sale" ? "Sale" : "Purchase";
  const [cryptoLeg, otherLeg] = side === "Sale" ? [group(3), group(4)] : [group(4), group(3)];
  if (otherLeg !== "--" || cryptoLeg === "--") throw new Refusal(`${where}: expected exactly one crypto leg`);
  const [quantity, symbol] = cryptoLeg.split(" ") as [string, string];
  if (symbol !== SYMBOL) throw new Refusal(`${where}: not ${SYMBOL}`);
  if (group(7) !== "--") throw new Refusal(`${where}: a fee — this script does not know how it moves the coin count`);
  const units = parseQuantityE8(quantity);
  return {
    statement: spec.label,
    file: spec.file,
    page: line.page,
    line: line.text,
    day: group(1),
    side,
    quantity,
    deltaE8: side === "Sale" ? -units : units,
    price: group(5),
    valueCents: parseAmountToCents(`$${group(6)}`),
  };
}

async function readStatement(spec: StatementSpec): Promise<ReadStatement> {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), spec.file));
  // extractLines numbers lines page × 10,000 − y, so the page is the nearest multiple
  const lines = (await extractLines(buffer)).map((l) => ({ page: Math.round(l.y / 10_000), text: l.text }));
  const { eth, other } = splitAccounts(lines);
  if (eth.length === 0) throw new Refusal(`${spec.file}: no account ending 8474`);
  const stray = other.find((l) => ROW_RE.test(l.text) || FIELD_RES.heldQuantity.test(l.text));
  if (stray) throw new Refusal(`${spec.file}: the other account prints activity — p${stray.page} "${stray.text}"`);
  const names = Object.keys(FIELD_RES) as FieldName[];
  const fields = Object.fromEntries(names.map((n) => [n, singleCapture(spec.file, eth, FIELD_RES[n])])) as Record<FieldName, Captured>;
  const trades = eth.flatMap((l) => {
    const m = ROW_RE.exec(l.text);
    return m ? [toTrade(spec, l, m)] : [];
  });
  return { spec, sha256: createHash("sha256").update(buffer).digest("hex"), fields, trades };
}

function checkStatement(s: ReadStatement, openingE8: bigint, previousClosing: string): void {
  console.log(`\n  ${s.spec.file}  sha256 ${s.sha256.slice(0, 16)}…`);
  for (const f of Object.values(s.fields)) console.log(`    p${f.page}  ${f.text}`);
  for (const t of s.trades) console.log(`    p${t.page}  ${t.line}`);
  for (const name of Object.keys(FIELD_RES) as FieldName[]) {
    const f = s.fields[name];
    guard(`${s.spec.label} ${name} matches the frozen table`, f.value === s.spec[name], `p${f.page} ${f.value}`);
  }
  guard(`${s.spec.label} prints ${s.spec.rowCount} trades`, s.trades.length === s.spec.rowCount, `${s.trades.length} read`);
  guard(`${s.spec.label} opens at the previous CLOSING BALANCE`, s.fields.openingBalance.value === previousClosing, `$${previousClosing}`);
  const outside = s.trades.filter((t) => t.day < s.fields.periodStart.value || t.day > s.fields.periodEnd.value);
  guard(`${s.spec.label} every trade is inside the period`, outside.length === 0, outside.map((t) => t.day).join(", ") || "yes");
  // PRICE × quantity must reproduce VALUE — a mis-split column would not
  const mispriced = s.trades.filter((t) => Math.abs(Number(t.quantity) * Number(t.price) * 100 - t.valueCents) > 1);
  guard(`${s.spec.label} quantity × price = value (±1¢) on every row`, mispriced.length === 0, mispriced.map((t) => t.day).join(", ") || "yes");
  const closeE8 = s.trades.reduce((q, t) => q + t.deltaE8, openingE8);
  const printed = parseQuantityE8(s.fields.heldQuantity.value);
  guard(`${s.spec.label} trades carry ${qty(openingE8)} to the printed close`, closeE8 === printed, `${qty(closeE8)} vs ${qty(printed)}`);
}

function checkStatements(read: readonly ReadStatement[]): void {
  console.log("Statements read (ETH account only; the second account on pages 4–5 prints no holding and no activity)");
  let openingE8 = parseQuantityE8(JUNE_CLOSE.quantity);
  let previousClosing: string = JUNE_CLOSE.closingBalance;
  for (const s of read) {
    checkStatement(s, openingE8, previousClosing);
    openingE8 = parseQuantityE8(s.fields.heldQuantity.value);
    previousClosing = s.fields.closingBalance.value;
  }
}

/* ── the book ───────────────────────────────────────────────────────── */

interface BookEvent {
  readonly id: string;
  readonly occurredOn: string;
  readonly deltaE8: number;
  readonly costCents: number | null;
  readonly note: string | null;
  readonly eventKind: string;
  readonly createdAt: string;
}
interface Book {
  readonly accountId: string;
  readonly events: readonly BookEvent[];
  readonly holding: { readonly id: string; readonly quantityE8: number; readonly avgCostCents: number | null };
}
interface PlannedEvent {
  readonly occurredOn: string;
  readonly deltaE8: number;
  readonly costCents: number;
  readonly note: string;
  readonly trade: StatementTrade;
}
interface Plan {
  readonly book: Book;
  readonly state: "pending" | "applied";
  readonly placeholder: BookEvent | null;
  readonly inserts: readonly PlannedEvent[];
  readonly after: readonly { readonly occurredOn: string; readonly deltaE8: number }[];
  readonly firstChangedDay: string;
}

function loadBook(db: AppDatabase): Book {
  const found = db.select({ id: accounts.id, type: accounts.type }).from(accounts).where(eq(accounts.name, ACCOUNT_NAME)).all();
  if (found.length !== 1 || found[0]?.type !== "investment") throw new Refusal(`expected one investment account named ${ACCOUNT_NAME}`);
  const accountId = found[0].id;
  const events = db
    .select({
      id: holdingEvents.id,
      occurredOn: holdingEvents.occurredOn,
      deltaE8: holdingEvents.quantityDeltaE8,
      costCents: holdingEvents.costCents,
      note: holdingEvents.note,
      eventKind: holdingEvents.eventKind,
      createdAt: holdingEvents.createdAt,
    })
    .from(holdingEvents)
    .where(and(eq(holdingEvents.accountId, accountId), eq(holdingEvents.symbol, SYMBOL), eq(holdingEvents.assetType, "crypto")))
    .orderBy(asc(holdingEvents.occurredOn), asc(holdingEvents.id))
    .all();
  const rows = db
    .select({ id: holdings.id, quantityE8: holdings.quantityE8, avgCostCents: holdings.avgCostCents })
    .from(holdings)
    .where(and(eq(holdings.accountId, accountId), eq(holdings.symbol, SYMBOL), eq(holdings.assetType, "crypto")))
    .all();
  if (rows.length !== 1) throw new Refusal(`expected one ${SYMBOL} holdings row, found ${rows.length}`);
  return { accountId, events, holding: rows[0] as Book["holding"] };
}

function toPlanned(t: StatementTrade): PlannedEvent {
  const deltaE8 = Number(t.deltaE8);
  if (!Number.isSafeInteger(deltaE8)) throw new Refusal(`${t.day}: quantity out of integer range`);
  return { occurredOn: t.day, deltaE8, costCents: t.valueCents, note: `${t.side} ${t.quantity} ${SYMBOL} (statement ${t.statement})`, trade: t };
}

const sameEvent = (e: BookEvent, p: PlannedEvent): boolean =>
  e.occurredOn === p.occurredOn && e.deltaE8 === p.deltaE8 && e.costCents === p.costCents && e.note === p.note && e.eventKind === "trade";

const isPlaceholder = (e: BookEvent): boolean =>
  e.occurredOn === PLACEHOLDER.occurredOn && e.deltaE8 === PLACEHOLDER.deltaE8 && e.costCents === PLACEHOLDER.costCents && e.note === PLACEHOLDER.note;

const qtyAt = (events: Plan["after"], day: string): bigint =>
  events.reduce((q, e) => (e.occurredOn <= day ? q + BigInt(e.deltaE8) : q), 0n);

/** Idempotence: exactly two states are acceptable, and anything between them is refused. */
function buildPlan(db: AppDatabase, trades: readonly StatementTrade[]): Plan {
  const book = loadBook(db);
  const inserts = trades.map(toPlanned);
  const placeholder = book.events.find((e) => e.id === PLACEHOLDER.id) ?? null;
  if (placeholder !== null && !isPlaceholder(placeholder)) {
    throw new Refusal(`event ${PLACEHOLDER.id} exists but no longer reads as the placeholder: ${JSON.stringify(placeholder)}`);
  }
  const hits = inserts.map((p) => book.events.filter((e) => sameEvent(e, p)).length);
  if (hits.some((n) => n > 1)) throw new Refusal("a statement trade is already in the book more than once");
  const present = hits.filter((n) => n === 1).length;
  const state = placeholder !== null && present === 0 ? "pending" : placeholder === null && present === inserts.length ? "applied" : null;
  if (state === null) {
    throw new Refusal(`partial state — placeholder ${placeholder ? "present" : "absent"}, ${present}/${inserts.length} statement trades present`);
  }
  const [from, to] = [STATEMENTS[0]!.periodStart, STATEMENTS.at(-1)!.periodEnd];
  const foreign = book.events.filter(
    (e) => e.occurredOn >= from && e.occurredOn <= to && e.id !== PLACEHOLDER.id && !inserts.some((p) => sameEvent(e, p)),
  );
  if (foreign.length > 0) {
    throw new Refusal(`other ${SYMBOL} events inside ${from}..${to} would count twice: ${foreign.map((e) => `${e.occurredOn} ${signed(e.deltaE8)}`).join(", ")}`);
  }
  const after = state === "pending" ? [...book.events.filter((e) => e.id !== PLACEHOLDER.id), ...inserts] : book.events;
  const firstChangedDay = [PLACEHOLDER.occurredOn, ...inserts.map((p) => p.occurredOn)].sort()[0] as string;
  return { book, state, placeholder, inserts, after, firstChangedDay };
}

/* ── reporting ──────────────────────────────────────────────────────── */

function closeOn(db: AppDatabase, day: string): number | null {
  const row = db.get<{ close: number }>(sql`SELECT close FROM price_cache WHERE symbol = ${SYMBOL} AND asset_type = 'crypto' AND quoted_on = ${day}`);
  return row?.close ?? null;
}

function dailySeries(db: AppDatabase, accountId: string): Map<string, number> {
  const rows = db.all<{ day: string; v: number }>(sql`SELECT day, balance_cents v FROM daily_balances WHERE account_id = ${accountId}`);
  return new Map(rows.map((r) => [r.day, r.v]));
}

const mark = (v: number | null | undefined, printed: number): string =>
  v === null || v === undefined ? "—" : `${formatCents(v)} (off ${offBy(v - printed)})`;

function printPlan(plan: Plan): void {
  const p = plan.placeholder;
  console.log(`\nPlan — ${plan.state === "pending" ? "the placeholder is still in the book" : "ALREADY APPLIED: placeholder gone, every statement trade present"}`);
  if (p === null) {
    console.log("  delete  nothing");
  } else {
    console.log("  delete 1 event");
    console.log(`    ${p.id}  ${p.occurredOn}  ${signed(p.deltaE8)} ${SYMBOL}  cost ${p.costCents === null ? "—" : formatCents(p.costCents)}  ${p.eventKind}  created ${p.createdAt}`);
    console.log(`      note "${p.note}"`);
  }
  console.log(`  ${plan.state === "pending" ? "insert" : "already present:"} ${plan.inserts.length} events  (cost = the statement VALUE)`);
  console.log(`    ${"date".padEnd(10)}  ${"side".padEnd(8)}  ${"quantity".padStart(10)}  ${"price".padStart(15)}  ${"amount".padStart(9)}  source`);
  for (const { trade: t } of plan.inserts) {
    console.log(
      `    ${t.day}  ${t.side.padEnd(8)}  ${signed(t.deltaE8).padStart(10)}  ${`$${t.price}`.padStart(15)}  ${formatCents(t.valueCents).padStart(9)}  ${path.basename(t.file)} p${t.page}`,
    );
  }
  const h = plan.book.holding;
  console.log(
    `  holdings ${SYMBOL}  quantity_e8 ${qty(h.quantityE8)} → ${qty(qtyAt(plan.after, END_OF_TIME))}` +
      `   avg_cost_cents ${h.avgCostCents ?? "—"} (unchanged: no statement prints a cost basis)`,
  );
  const later = plan.after.filter((e) => e.occurredOn > STATEMENTS.at(-1)!.periodEnd).length;
  console.log(`  ${SYMBOL} events after ${STATEMENTS.at(-1)!.periodEnd}: ${later}`);
}

function checkPlan(db: AppDatabase, plan: Plan): void {
  const { book } = plan;
  console.log(`\n${SYMBOL} at each statement close — book now → book after  (statement)`);
  for (const c of CLOSES) {
    const [now, next] = [qtyAt(book.events, c.day), qtyAt(plan.after, c.day)];
    guard(`${c.day} equals the ${c.cite}`, next === parseQuantityE8(c.quantity), `${qty(now)} → ${qty(next)}  (${c.quantity})`);
  }
  const sum = qtyAt(book.events, END_OF_TIME);
  guard("holdings.quantity_e8 equals the event sum going in", BigInt(book.holding.quantityE8) === sum, `${qty(book.holding.quantityE8)} = ${qty(sum)}`);
  const placeholderQty = plan.placeholder === null ? null : -BigInt(plan.placeholder.deltaE8);
  const julySale = plan.inserts.find((i) => i.trade.side === "Sale")?.trade;
  if (placeholderQty !== null && julySale) {
    console.log(`  (the placeholder's ${qty(placeholderQty)} ETH is the ${julySale.day} sale of ${julySale.quantity} — ${placeholderQty === -julySale.deltaE8 ? "same quantity" : "DIFFERENT quantity"}, 3 days later, avg-cost priced)`);
  }
  console.log(`\nValue at each close — quantity × cached ${SYMBOL} close vs the printed CLOSING BALANCE (a price mark, never to the cent)`);
  const stored = dailySeries(db, book.accountId);
  for (const c of CLOSES.slice(1)) {
    const printed = parseAmountToCents(`$${c.closingBalance}`);
    const close = closeOn(db, c.day);
    const projected = close === null ? null : Math.round((Number(qtyAt(plan.after, c.day)) * close) / 1e6);
    console.log(`  ${c.day}  printed ${formatCents(printed)}  ·  app now ${mark(stored.get(c.day), printed)}  →  after ≈ ${mark(projected, printed)}  (close ${close ?? "—"})`);
  }
}

/* ── writing ────────────────────────────────────────────────────────── */

interface Fingerprint {
  readonly eventCount: number;
  readonly avgCostCents: number | null;
  readonly otherEvents: string;
  readonly otherHoldings: string;
  readonly transactions: string;
}

function fingerprint(db: AppDatabase, book: Book): Fingerprint {
  const id = book.accountId;
  return {
    eventCount: book.events.length,
    avgCostCents: book.holding.avgCostCents,
    otherEvents: JSON.stringify(
      db.all(sql`SELECT account_id, symbol, COUNT(*) n, SUM(quantity_delta_e8) q, COALESCE(SUM(cost_cents), 0) c
                 FROM holding_events WHERE NOT (account_id = ${id} AND symbol = ${SYMBOL})
                 GROUP BY account_id, symbol ORDER BY account_id, symbol`),
    ),
    otherHoldings: JSON.stringify(
      db.all(sql`SELECT id, quantity_e8, avg_cost_cents, is_active FROM holdings WHERE id <> ${book.holding.id} ORDER BY id`),
    ),
    transactions: JSON.stringify(db.get(sql`SELECT COUNT(*) n, COALESCE(SUM(amount_cents), 0) s FROM transactions`)),
  };
}

/** Returns the derived curve as it stood immediately before the write. */
function write(db: AppDatabase, plan: Plan): Map<string, number> {
  const { accountId } = plan.book;
  // re-derive FIRST, so the before/after comparison measures this write and not a stale curve
  rebuildAccount(db, accountId);
  const dailyBefore = dailySeries(db, accountId);
  const quantityE8 = Number(qtyAt(plan.after, END_OF_TIME));
  db.transaction((tx) => {
    const removed = tx
      .delete(holdingEvents)
      .where(and(eq(holdingEvents.id, PLACEHOLDER.id), eq(holdingEvents.accountId, accountId)))
      .run();
    if (removed.changes !== 1) throw new Error(`placeholder delete touched ${removed.changes} rows — rolled back`);
    for (const p of plan.inserts) {
      tx.insert(holdingEvents)
        .values({ accountId, symbol: SYMBOL, assetType: "crypto", occurredOn: p.occurredOn, quantityDeltaE8: p.deltaE8, costCents: p.costCents, eventKind: "trade", note: p.note })
        .run();
    }
    tx.update(holdings).set({ quantityE8, isActive: quantityE8 > 0 }).where(eq(holdings.id, plan.book.holding.id)).run();
  });
  // outside the transaction — rebuildAccount opens its own, and a nested BEGIN throws
  rebuildAccount(db, accountId);
  return dailyBefore;
}

function verify(db: AppDatabase, plan: Plan, before: Fingerprint, dailyBefore: Map<string, number>): void {
  console.log("\nVerification — read back from the database");
  const book = loadBook(db);
  guard("the placeholder is gone", !book.events.some((e) => e.id === PLACEHOLDER.id), PLACEHOLDER.id);
  const hits = plan.inserts.map((p) => book.events.filter((e) => sameEvent(e, p)).length);
  guard("every statement trade is in the book exactly once", hits.every((n) => n === 1), `${hits.filter((n) => n === 1).length}/${hits.length}`);
  const want = before.eventCount - 1 + plan.inserts.length;
  guard("one event out, the statement trades in", book.events.length === want, `${before.eventCount} → ${book.events.length}`);
  for (const c of CLOSES) {
    const got = qtyAt(book.events, c.day);
    guard(`${SYMBOL} on ${c.day} equals the ${c.cite}`, got === parseQuantityE8(c.quantity), `${qty(got)}  (${c.quantity})`);
  }
  const sum = qtyAt(book.events, END_OF_TIME);
  guard("holdings.quantity_e8 equals the event sum", BigInt(book.holding.quantityE8) === sum, `${qty(book.holding.quantityE8)} = ${qty(sum)}`);
  const after = fingerprint(db, book);
  guard("holdings.avg_cost_cents untouched", after.avgCostCents === before.avgCostCents, `${after.avgCostCents}`);
  guard("no other account's or symbol's holding_events changed", after.otherEvents === before.otherEvents, "fingerprint equal");
  guard("no other holdings row changed", after.otherHoldings === before.otherHoldings, "fingerprint equal");
  guard("no transaction was written", after.transactions === before.transactions, after.transactions);
  const dailyAfter = dailySeries(db, book.accountId);
  const earlier = [...dailyBefore].filter(([day]) => day < plan.firstChangedDay);
  const moved = earlier.filter(([day, v]) => dailyAfter.get(day) !== v);
  guard(`no daily balance before ${plan.firstChangedDay} changed`, moved.length === 0, moved.length === 0 ? `${earlier.length} days identical` : moved.slice(0, 3).map(([d]) => d).join(", "));
  console.log("\n  derived daily balance at each close — before → after  (printed CLOSING BALANCE)");
  for (const c of CLOSES.slice(1)) {
    const printed = parseAmountToCents(`$${c.closingBalance}`);
    console.log(`    ${c.day}  ${mark(dailyBefore.get(c.day), printed)} → ${mark(dailyAfter.get(c.day), printed)}  (${formatCents(printed)})`);
  }
}

/* ── modes ──────────────────────────────────────────────────────────── */

async function throwawayCopyOfRealDb(): Promise<{ file: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-eth-rehearse-"));
  const file = path.join(dir, "rehearsal.db");
  const live = new Database(REAL_DB, { readonly: true, fileMustExist: true });
  try {
    await live.backup(file);
  } finally {
    live.close();
  }
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function dryRun(dbPath: string | null, trades: readonly StatementTrade[]): Promise<number> {
  const copy = dbPath === null ? await throwawayCopyOfRealDb() : null;
  const file = copy?.file ?? path.resolve(dbPath as string);
  console.log(`\nDRY RUN on ${copy ? "a throwaway .backup of data/moneyapp.db" : file} — opened read-only`);
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const db: AppDatabase = drizzle(sqlite, { schema });
    const plan = buildPlan(db, trades);
    printPlan(plan);
    checkPlan(db, plan);
    if (failures.length > 0) return 1;
    console.log(plan.state === "applied" ? "\nNothing to do — already applied." : "\nDry run — nothing written. Re-run with --db <path> --confirm to write.");
    return 0;
  } finally {
    sqlite.close();
    copy?.cleanup();
  }
}

function applyTo(dbPath: string, trades: readonly StatementTrade[]): number {
  const file = path.resolve(dbPath);
  // createDatabase would CREATE a missing file and migrate an empty ledger into it
  if (!fs.existsSync(file)) throw new Refusal(`${file} does not exist`);
  console.log(`\nAPPLYING to ${file}${file === REAL_DB ? "  ⚠ the REAL database — the dev server must be stopped" : ""}`);
  const { db, sqlite } = createDatabase(file);
  try {
    const plan = buildPlan(db, trades);
    printPlan(plan);
    checkPlan(db, plan);
    if (failures.length > 0) {
      console.log("\nREFUSING to write — a pre-write guard failed.");
      return 1;
    }
    if (plan.state === "applied") {
      console.log("\nNothing to do — already applied. Nothing written.");
      return 0;
    }
    const before = fingerprint(db, plan.book);
    const dailyBefore = withPreMutationSnapshot(db, SNAPSHOT_LABEL, () => write(db, plan));
    verify(db, plan, before, dailyBefore);
    return failures.length > 0 ? 1 : 0;
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const read = await Promise.all(STATEMENTS.map(readStatement));
  checkStatements(read);
  if (failures.length > 0) {
    console.log("\nREFUSING — the statements do not read the way this script froze them.");
    return 1;
  }
  const trades = read.flatMap((s) => s.trades);
  return cli.confirm ? applyTo(cli.dbPath as string, trades) : dryRun(cli.dbPath, trades);
}

main()
  .then((code) => {
    console.log(failures.length > 0 ? `\n✗ ${failures.length} guard(s) failed: ${failures.join("; ")}` : code === 0 ? "\n✓ all guards passed" : "");
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Refusal ? `\n✗ REFUSING: ${error.message}` : error);
    process.exitCode = 1;
  });
