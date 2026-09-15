import { formatDayFull } from "@/lib/format-date";
import { formatCents, parseAmountToCents } from "@/lib/money";
import { dayWindowLabel } from "@/lib/period";
import { formatQuantityE8, parseQuantityE8 } from "@/lib/robinhood-holdings";
import {
  ParseError,
  type BookEvent,
  type CanonicalTxn,
  type EquityAssetType,
  type PendingTrade,
  type PositionTrade,
  type PrintedPosition,
  type StatementPositions,
} from "../types";
import { RH_CODE_CATEGORY } from "./csv-profiles";
import type { Line } from "./pdf-profile";
import { parseAccountActivity, type ActivityRow } from "./robinhood-crypto-movement";

/**
 * The positions reader for a Robinhood brokerage statement section whose account the ledger tracks as a CASH
 * account — #655929651, "Robinhood Agentic", the money Claude's agent trades.
 *
 * ⚖️ The owner, 2026-09-15: when the agent buys a stock, show TWO accounts. Robinhood Agentic keeps the unspent cash,
 * and a brokerage book paired with it holds the positions — as Robinhood Cash and Robinhood Brokerage split
 * #487513525 — and every statement still proves the cash to the cent.
 *
 * Everything here comes from the section's own printed lines, and each table must prove itself before anything
 * leaves this module:
 *  - Account Activity: every row signed by its column, placed by its code, and summed against the printed Total
 *    Funds Paid and Received (the bank's own arithmetic);
 *  - Executed Trades Pending Settlement: every row read and summed against its own total — noted, never posted;
 *  - Securities Held (and Loaned Securities): every position's quantity × price against its printed value, the
 *    values against the table's Total Securities, and that against the Account Summary's closing;
 *  - the arbiter: what the ledger's book held before the period, plus every Buy and Sell the activity lists, must
 *    equal the printed positions EXACTLY. Measured on #487513525 across the real archive, that identity holds in 24 of
 *    25 consecutive month pairs; the miss is COKE's 10-for-1 split, which prints no row.
 *
 * A section that fails any of it is WITHHELD (`UnprovableSection`), named on the file with why — the safety net's
 * rule: a refusal about one account's section never erases another account's provable money.
 *
 * ⛔ DATES. Positions and cash are SETTLED, and Account Activity lists the trades that settled in the period dated by
 * their TRADE date: August 2026's activity carries `AAPL Buy 07/31/2026 5`, which July printed as pending, settling
 * 08/03. A trade dated before the period is therefore a position from the period's first day — dated by its trade
 * day it would land in the month before and break the positions that month printed (16 of #487513525's months carry
 * one).
 */

const PROFILE_ID = "robinhood-brokerage-statement-pdf";

/**
 * A refusal about ONE cash-account section: the technical message a whole-file refusal throws, and the reason in
 * plain words the notice carries when the rest of the file imports without the section.
 */
export class UnprovableSection extends ParseError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(PROFILE_ID, message);
  }
}

const US_DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const MONEY = String.raw`(\(?\$[\d,]+\.\d\d\)?)`;
const MONEY_ANYWHERE_RE = /\$[\d,]+\.\d/;
const DATE_ANYWHERE_RE = /\d{2}\/\d{2}\/\d{4}/;
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,11}$/;
const QUANTITY_RE = /^\d[\d,]*(?:\.\d+)?$/;
const PRICE_RE = /^\$[\d,]+\.\d+$/;
const ACCOUNT_TYPES: ReadonlySet<string> = new Set(["Cash", "Margin"]);

/** `Total Funds Paid and Received $0.00 $26.64` — the Account Activity table's Debit and Credit column totals. */
const TOTAL_FUNDS_RE = new RegExp(String.raw`^Total Funds Paid and Received ${MONEY} ${MONEY}$`);

/** `Total Executed Trades Pending Settlement $0.00 $0.00` — the pending-trades table's Debit and Credit totals. */
export const PENDING_TITLE = "Executed Trades Pending Settlement";
const TOTAL_PENDING_RE = new RegExp(String.raw`^Total ${PENDING_TITLE} ${MONEY} ${MONEY}$`);
/** a row of that table carries a trade date or an amount; its title, note, header and a page break carry neither */
const PENDING_ROW_RE = new RegExp(String.raw`\d{2}/\d{2}/\d{4}|${MONEY}`);

const PORTFOLIO_TITLE = "Portfolio Summary";
/**
 * `WMT Cash 0.25 $104.87000 $26.22 $0.24 94.11%` — one position in Securities Held or Loaned Securities: symbol, account
 * type, quantity, price, market value, estimated dividend, share of the portfolio. Measured on #487513525's real rows
 * (`AAPL Margin 21.150657 $316.85000 $6,701.59 $22.01 9.06%`); its name prints on the line above, `Estimated Yield`
 * below.
 */
const HELD_ROW_RE = new RegExp(String.raw`^([A-Z][A-Z0-9.-]{0,11}) (?:Cash|Margin) (\d[\d,]*(?:\.\d+)?) \$([\d,]+\.\d+) ${MONEY} ${MONEY} \d+(?:\.\d+)?%$`);
/**
 * `Total Securities $26.22 $0.24 94.11%` — the Portfolio Summary's own total (market value, estimated dividend,
 * share), NOT the Account Summary's `Total Securities <open> <close>`: two money tokens and a percentage, where that
 * one is exactly two money tokens. On #487513525 it counts Loaned Securities too (`Total Securities * $72,959.32`).
 */
const PORTFOLIO_TOTAL_RE = new RegExp(String.raw`^Total Securities ?\*{0,3} ?${MONEY} ${MONEY} \d+(?:\.\d+)?%$`);

/** Account Activity codes that move only cash, filed exactly as the activity CSV files them. */
const CASH_CODES: ReadonlySet<string> = new Set(["ITRF", "CDIV", "INT", "SLIP"]);

/** Lines that sit above a trade row and are not its instrument's name. */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  "Account Activity",
  "Dividend Reinvestment",
  "Recurring",
  "Stock Lending",
  PENDING_TITLE,
  "These transactions may not be reflected in the other summaries",
]);

function toIso(usDate: string): string {
  const [mm, dd, yyyy] = usDate.split("/") as [string, string, string];
  return `${yyyy}-${mm}-${dd}`;
}

function quantityOf(printed: string, who: string, text: string): bigint {
  try {
    return parseQuantityE8(printed);
  } catch {
    throw new UnprovableSection(
      `${who} prints a quantity this reader cannot hold to eight decimals — "${text}"`,
      `it shows a quantity this reader cannot read ("${text}")`,
    );
  }
}

/** A BigInt count of 1e-8 shares, as the schema's integer column holds it — refusing anything that would lose precision. */
function toStoredQuantity(value: bigint, who: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new UnprovableSection(`${who} prints a quantity beyond the ledger's range: ${value}`, "it shows a quantity beyond what the ledger can hold");
  }
  return n;
}

/** quantity_e8 × a printed price (any number of decimals) → cents, rounded half up — exact, in integers. */
function valueCentsAt(quantityE8: bigint, price: string): bigint {
  const [whole, frac = ""] = price.replaceAll(",", "").split(".") as [string, string?];
  const scaled = BigInt(`${whole}${frac}`);
  const denominator = 10n ** 8n * 10n ** BigInt(frac.length);
  return (quantityE8 * scaled * 100n * 2n + denominator) / (2n * denominator);
}

/** The instrument name printed on the line above a row, when that line is one. */
function nameAbove(table: readonly Line[], row: Line): string | null {
  const text = table[table.indexOf(row) - 1]?.text.trim() ?? "";
  if (text === "" || NOT_A_NAME.has(text) || text.startsWith("CUSIP:") || text.startsWith("Description ")) return null;
  if (MONEY_ANYWHERE_RE.test(text) || DATE_ANYWHERE_RE.test(text) || /^Page \d+ of \d+$/.test(text)) return null;
  return text;
}

/* ── Account Activity ────────────────────────────────────────────────────────────────────────────────────────── */

/** A Buy or Sell the section's Account Activity lists — its shares, and the cash row it is. */
export interface TradeRow {
  readonly side: "Buy" | "Sell";
  readonly symbol: string;
  readonly tradedOn: string;
  readonly quantityE8: bigint;
  /** signed by its column: a Buy negative, a Sell positive */
  readonly amountCents: number;
  readonly printed: string;
}

export interface ActivityRead {
  /** every row, as the cash account stores it */
  readonly txns: CanonicalTxn[];
  /** the rows that move shares, in print order */
  readonly trades: TradeRow[];
}

/**
 * The section's Account Activity — every row signed by its column, placed by its code, and checked against the printed
 * Total Funds Paid and Received.
 *
 * Each row's code is the token printed just before its date (`ITRF`, `Buy`, `CDIV`…), the table's Transaction column.
 * Cash codes become the cash account's rows, filed as the activity CSV files them (`RH_CODE_CATEGORY`); a Buy or Sell
 * is ALSO a trade, read from the Symbol, Qty and Price tokens around its date.
 *
 * ⛔ Refused: a `COIN` row (a crypto money movement — the owner does not track #655929651's crypto account until it
 * holds crypto, so its cash would leave for nowhere), any code this reader has no place for, a trade whose columns do
 * not read, a Buy in the Credit column or a Sell in the Debit column, and rows that do not add up.
 */
export function readAccountActivity(own: readonly Line[], who: string): ActivityRead {
  const totalsAt = own.findIndex((l) => TOTAL_FUNDS_RE.test(l.text));
  if (totalsAt === -1) {
    throw new UnprovableSection(
      `${who} prints no Total Funds Paid and Received line — refusing to import its Account Activity unchecked`,
      "it prints no Total Funds Paid and Received line, so its activity cannot be checked",
    );
  }
  // the table runs from its title to its totals; the Executed Trades table after it has its own columns
  const tableAt = own.findIndex((l) => l.text === "Account Activity");
  const table = tableAt === -1 || tableAt > totalsAt ? [] : own.slice(tableAt, totalsAt);
  const read = parseAccountActivity(table, () => true).map((row) => readActivityRow(row, table, who));

  const rows = read.map((r) => r.txn);
  const debits = rows.reduce((n, r) => (r.amountCents < 0 ? n - r.amountCents : n), 0);
  const credits = rows.reduce((n, r) => (r.amountCents > 0 ? n + r.amountCents : n), 0);
  const totals = TOTAL_FUNDS_RE.exec((own[totalsAt] as Line).text) as RegExpExecArray;
  const printedDebits = parseAmountToCents(totals[1] as string);
  const printedCredits = parseAmountToCents(totals[2] as string);
  if (debits !== printedDebits || credits !== printedCredits) {
    throw new UnprovableSection(
      `${who}'s Account Activity rows total ${debits}/${credits} against a printed Total Funds Paid and Received of ${printedDebits}/${printedCredits}`,
      `its activity rows add up to ${formatCents(debits)} out and ${formatCents(credits)} in, but it prints ` +
        `${formatCents(printedDebits)} out and ${formatCents(printedCredits)} in — a row this reader cannot see is there`,
    );
  }
  return { txns: rows, trades: read.flatMap((r) => (r.trade === undefined ? [] : [r.trade])) };
}

function readActivityRow(row: ActivityRow, table: readonly Line[], who: string): { txn: CanonicalTxn; trade?: TradeRow } {
  const { line } = row;
  const dateAt = line.tokens.findIndex((t) => US_DATE_RE.test(t.str));
  const code = line.tokens[dateAt - 1]?.str ?? "";
  if (code === "COIN") {
    throw new UnprovableSection(
      `${who} prints a Crypto Money Movement — "${line.text}" — and the ledger tracks no crypto account for it, refusing to post cash to nowhere`,
      `it shows a crypto money movement ("${line.text}"), and its crypto account is not tracked`,
    );
  }
  if (code === "Buy" || code === "Sell") return readTradeRow(row, code, dateAt, table, who);
  if (!CASH_CODES.has(code)) {
    throw new UnprovableSection(
      `${who} prints an Account Activity row this reader has no place for — "${line.text}" — refusing to drop it`,
      `it shows activity this reader has no place for ("${line.text}")`,
    );
  }
  const description = line.tokens[0]?.str.trim() ?? "";
  if (description === "") {
    throw new UnprovableSection(
      `${who} prints an ${code} row with no description — "${line.text}"`,
      code === "ITRF" ? `it shows a transfer with no description ("${line.text}")` : `it shows a ${code} row with no description ("${line.text}")`,
    );
  }
  return {
    txn: {
      postedOn: row.postedOn,
      amountCents: row.amountCents,
      // the description token, which is the activity CSV's own wording for the same row
      rawDescription: description,
      bankCategory: code,
      categoryPath: RH_CODE_CATEGORY[code] ?? undefined,
    },
  };
}

function readTradeRow(
  row: ActivityRow,
  side: "Buy" | "Sell",
  dateAt: number,
  table: readonly Line[],
  who: string,
): { txn: CanonicalTxn; trade: TradeRow } {
  const { line } = row;
  // `WMT Cash Buy 08/20/2026 0.25 $100.00000 $25.00`, or the same after a `CUSIP: 931142103` token
  const symbol = line.tokens[dateAt - 3]?.str ?? "";
  const accountType = line.tokens[dateAt - 2]?.str ?? "";
  const quantity = line.tokens[dateAt + 1]?.str ?? "";
  const price = line.tokens[dateAt + 2]?.str ?? "";
  if (!SYMBOL_RE.test(symbol) || !ACCOUNT_TYPES.has(accountType) || !QUANTITY_RE.test(quantity) || !PRICE_RE.test(price)) {
    throw new UnprovableSection(
      `${who} prints a ${side} this reader cannot read column by column — "${line.text}"`,
      `it shows a ${side === "Buy" ? "purchase" : "sale"} this reader cannot read ("${line.text}")`,
    );
  }
  // the column is the authority on direction; a Buy takes cash and a Sell brings it, so each must sit where it belongs
  if (row.amountCents === 0 || (side === "Buy") !== row.amountCents < 0) {
    throw new UnprovableSection(
      `${who} prints a ${side} in the ${row.amountCents < 0 ? "Debit" : "Credit"} column — "${line.text}" — refusing to guess its direction`,
      `it shows a ${side === "Buy" ? "purchase" : "sale"} in the wrong column ("${line.text}")`,
    );
  }
  const quantityE8 = quantityOf(quantity, who, line.text);
  if (quantityE8 === 0n) {
    throw new UnprovableSection(`${who} prints a ${side} of no shares — "${line.text}"`, `it shows a trade of no shares ("${line.text}")`);
  }
  return {
    txn: {
      postedOn: row.postedOn,
      amountCents: row.amountCents,
      rawDescription: nameAbove(table, line) ?? symbol,
      bankCategory: side,
      categoryPath: RH_CODE_CATEGORY[side] ?? undefined,
    },
    trade: { side, symbol, tradedOn: row.postedOn, quantityE8, amountCents: row.amountCents, printed: line.text },
  };
}

/* ── Executed Trades Pending Settlement ──────────────────────────────────────────────────────────────────────── */

/**
 * The section's trades pending settlement — read, checked against the table's own total, and never posted.
 *
 * Robinhood prints over the table "These transactions may not be reflected in the other summaries", and they are not:
 * a trade executed on the last trading day is in no settled figure this month, and next month's Account Activity
 * lists it by its trade date. Posting it here would post it twice.
 *
 * ⛔ A missing total or title is refused — then nothing shows that no trade is pending — and so is a row that does not
 * read (two dates, a Buy or Sell, a quantity) or rows that do not add up to the printed total.
 */
export function readPendingTrades(own: readonly Line[], who: string, last4: string): PendingTrade[] {
  const totalAt = own.findIndex((l) => TOTAL_PENDING_RE.test(l.text));
  if (totalAt === -1) {
    throw new UnprovableSection(
      `${who} prints no Total ${PENDING_TITLE} line, so nothing shows no trade is pending — refusing to import it as a cash account (····${last4})`,
      `it prints no ${PENDING_TITLE} total, so nothing shows that no trade is waiting to settle`,
    );
  }
  const titleAt = own.findIndex((l) => l.text === PENDING_TITLE);
  if (titleAt === -1 || titleAt > totalAt) {
    throw new UnprovableSection(
      `${who} prints no ${PENDING_TITLE} title above its total — refusing to read the table unbounded`,
      `it prints no ${PENDING_TITLE} title above that table's total, so the table cannot be read`,
    );
  }
  const table = own.slice(titleAt + 1, totalAt);
  const rows = parseAccountActivity(table, (l) => PENDING_ROW_RE.test(l.text));
  const unread = table.find((l) => PENDING_ROW_RE.test(l.text) && !rows.some((r) => r.line === l));
  if (unread) throw unreadablePending(who, unread);
  const pending = rows.map((row) => readPendingRow(row, table, who));

  const debits = pending.reduce((n, p) => (p.amountCents < 0 ? n - p.amountCents : n), 0);
  const credits = pending.reduce((n, p) => (p.amountCents > 0 ? n + p.amountCents : n), 0);
  const totals = TOTAL_PENDING_RE.exec((own[totalAt] as Line).text) as RegExpExecArray;
  const printedDebits = parseAmountToCents(totals[1] as string);
  const printedCredits = parseAmountToCents(totals[2] as string);
  if (debits !== printedDebits || credits !== printedCredits) {
    throw new UnprovableSection(
      `${who}'s trades pending settlement total ${debits}/${credits} against a printed Total ${PENDING_TITLE} of ${printedDebits}/${printedCredits}`,
      `its trades waiting to settle add up to ${formatCents(debits)} out and ${formatCents(credits)} in, but it prints ` +
        `${formatCents(printedDebits)} out and ${formatCents(printedCredits)} in`,
    );
  }
  return pending;
}

function unreadablePending(who: string, line: Line): UnprovableSection {
  return new UnprovableSection(
    `${who} prints a trade pending settlement this reader cannot read — "${line.text}"`,
    `it shows a trade waiting to settle this reader cannot read ("${line.text}")`,
  );
}

function readPendingRow(row: ActivityRow, table: readonly Line[], who: string): PendingTrade {
  const { line } = row;
  const dates = line.tokens.flatMap((t, i) => (US_DATE_RE.test(t.str) ? [i] : []));
  const [tradeAt, settleAt] = dates;
  const side = tradeAt === undefined ? "" : (line.tokens[tradeAt - 1]?.str ?? "");
  const quantity = settleAt === undefined ? "" : (line.tokens[settleAt + 1]?.str ?? "");
  if (dates.length !== 2 || (side !== "Buy" && side !== "Sell") || !QUANTITY_RE.test(quantity)) throw unreadablePending(who, line);
  if (row.amountCents === 0 || (side === "Buy") !== row.amountCents < 0) throw unreadablePending(who, line);
  // no Symbol column in this table: the name prints above, or (tokens before the account type) in the row itself
  const inline = line.tokens.slice(0, Math.max(0, (tradeAt as number) - 2)).map((t) => t.str.trim()).join(" ");
  return {
    side,
    description: nameAbove(table, line) ?? inline,
    tradedOn: toIso(line.tokens[tradeAt as number]!.str),
    settlesOn: toIso(line.tokens[settleAt as number]!.str),
    quantityE8: toStoredQuantity(quantityOf(quantity, who, line.text), who),
    amountCents: row.amountCents,
    printed: line.text,
  };
}

/* ── Securities Held ─────────────────────────────────────────────────────────────────────────────────────────── */

/** A position the Portfolio Summary prints at the period's end. */
export interface HeldRow {
  readonly symbol: string;
  readonly quantityE8: bigint;
  readonly marketValueCents: number;
}

/**
 * The section's printed positions — Securities Held and Loaned Securities, from the Portfolio Summary title to its
 * Total Securities line — each checked three ways:
 *  1. quantity × price against its printed market value, to the cent (a misread column);
 *  2. the values against the table's own Total Securities (a row this reader cannot see);
 *  3. that total against the Account Summary's closing Total Securities (a table read in the wrong place).
 *
 * ⛔ A line inside the table that carries money and is not a position is refused, never skipped — a position printed
 * by CUSIP rather than symbol is one.
 */
export function readHeldPositions(own: readonly Line[], who: string, closingSecuritiesCents: number): HeldRow[] {
  const totalAt = own.findIndex((l) => PORTFOLIO_TOTAL_RE.test(l.text));
  if (totalAt === -1) {
    throw new UnprovableSection(
      `${who} prints no Portfolio Summary Total Securities line — refusing to read its positions unchecked`,
      "it prints no Portfolio Summary total, so its positions cannot be checked",
    );
  }
  const titleAt = own.findIndex((l) => l.text === PORTFOLIO_TITLE);
  if (titleAt === -1 || titleAt > totalAt) {
    throw new UnprovableSection(
      `${who} prints no ${PORTFOLIO_TITLE} title above its Total Securities — refusing to read its positions unbounded`,
      `it prints no ${PORTFOLIO_TITLE} title above its securities total, so its positions cannot be read`,
    );
  }
  const rows = own.slice(titleAt + 1, totalAt).flatMap((l): HeldRow[] => {
    const m = HELD_ROW_RE.exec(l.text);
    if (!m) {
      if (!MONEY_ANYWHERE_RE.test(l.text)) return [];
      throw new UnprovableSection(
        `${who} prints a Portfolio Summary line this reader cannot read — "${l.text}" — refusing to drop a position`,
        `it shows a line among its positions this reader cannot read ("${l.text}")`,
      );
    }
    const quantityE8 = quantityOf(m[2] as string, who, l.text);
    const marketValueCents = parseAmountToCents(m[4] as string);
    const computed = valueCentsAt(quantityE8, m[3] as string);
    if (computed - BigInt(marketValueCents) > 1n || BigInt(marketValueCents) - computed > 1n) {
      throw new UnprovableSection(
        `${who} prints ${m[1]} at ${formatCents(marketValueCents)}, but its quantity × price is ${computed} cents — "${l.text}"`,
        `it shows ${m[1]} worth ${formatCents(marketValueCents)}, which its printed quantity and price do not make ("${l.text}")`,
      );
    }
    return [{ symbol: m[1] as string, quantityE8, marketValueCents }];
  });

  const printedTotal = parseAmountToCents((PORTFOLIO_TOTAL_RE.exec((own[totalAt] as Line).text) as RegExpExecArray)[1] as string);
  const listed = rows.reduce((n, r) => n + r.marketValueCents, 0);
  if (listed !== printedTotal) {
    throw new UnprovableSection(
      `${who}'s positions total ${listed} against a printed Total Securities of ${printedTotal}`,
      `its positions add up to ${formatCents(listed)}, but it prints ${formatCents(printedTotal)} of securities — a position this reader cannot see is there`,
    );
  }
  if (printedTotal !== closingSecuritiesCents) {
    throw new UnprovableSection(
      `${who}'s Portfolio Summary totals ${formatCents(printedTotal)} of securities against an Account Summary closing of ${formatCents(closingSecuritiesCents)}`,
      `its Portfolio Summary lists ${formatCents(printedTotal)} of securities, but its Account Summary closes at ${formatCents(closingSecuritiesCents)}`,
    );
  }
  return rows;
}

/* ── The arbiter ─────────────────────────────────────────────────────────────────────────────────────────────── */

export interface PositionsInput {
  readonly who: string;
  readonly period: { readonly start: string; readonly end: string };
  /** the Account Summary's opening Total Securities; null when it prints N/A */
  readonly openingSecuritiesCents: number | null;
  readonly held: readonly HeldRow[];
  readonly trades: readonly TradeRow[];
  /** every quantity change the account's brokerage book already holds; empty when it has no book yet */
  readonly bookEvents: readonly BookEvent[];
  readonly assetTypes: Readonly<Record<string, EquityAssetType>>;
}

/**
 * The section's positions, PROVEN — or null for a month with no position in it at all: nothing held, nothing traded,
 * no opening securities, and nothing in the book before it. That month is cash, exactly as the cash reader always read
 * it.
 *
 * The arbiter: for every symbol, what the book held before the period + this period's Buys − Sells = what Securities
 * Held prints at its end. Anything else is withheld with the symbol and both figures — a split (which prints no row),
 * a transfer in or out, or a trade this reader cannot see is a question, never a guess.
 *
 * ⛔ Also withheld:
 *  - trades the book already holds inside this window (another statement file of the same month): a second copy
 *    would count the shares twice;
 *  - trades when the book already holds a LATER month: those positions were proven without this month's;
 *  - an opening Total Securities with no position in the book behind it;
 *  - a symbol whose asset type no position in the ledger records — a ticker never says stock or ETF, and a wrong
 *    guess prices it against the wrong series.
 */
export function provePositions(input: PositionsInput): StatementPositions | null {
  const { who, period, held, trades, bookEvents, assetTypes } = input;
  const before = new Map<string, bigint>();
  for (const e of bookEvents) {
    if (e.occurredOn < period.start) before.set(e.symbol, (before.get(e.symbol) ?? 0n) + BigInt(e.quantityDeltaE8));
  }
  const heldBefore = [...before.values()].some((q) => q !== 0n);
  const opening = input.openingSecuritiesCents ?? 0;
  if (trades.length === 0 && held.length === 0 && opening === 0 && !heldBefore) return null;

  if (bookEvents.some((e) => e.occurredOn >= period.start && e.occurredOn <= period.end)) {
    throw new UnprovableSection(
      `${who}'s book already holds trades inside ${period.start} … ${period.end} from another statement file — refusing to count them twice`,
      `the ledger already holds this account's trades for ${dayWindowLabel(period.start, period.end)} from another statement, and a second copy would count its shares twice`,
    );
  }
  if (trades.length > 0 && bookEvents.some((e) => e.occurredOn > period.end)) {
    throw new UnprovableSection(
      `${who}'s book already holds trades after ${period.end} — this period's would land beneath positions a later statement proved without them`,
      `the ledger already holds this account's trades from a later statement, and those were proven without this month's`,
    );
  }
  const late = trades.find((t) => t.tradedOn > period.end);
  if (late) {
    throw new UnprovableSection(`${who} lists a trade dated after its own period — "${late.printed}"`, `it lists a trade dated after its own period ("${late.printed}")`);
  }

  const reconstructed = new Map(before);
  for (const t of trades) {
    reconstructed.set(t.symbol, (reconstructed.get(t.symbol) ?? 0n) + (t.side === "Buy" ? t.quantityE8 : -t.quantityE8));
  }
  const printed = new Map<string, bigint>();
  for (const h of held) printed.set(h.symbol, (printed.get(h.symbol) ?? 0n) + h.quantityE8);
  const symbols = [...new Set([...reconstructed.keys(), ...printed.keys()])].sort();
  const miss = symbols.find((s) => (reconstructed.get(s) ?? 0n) !== (printed.get(s) ?? 0n));
  if (miss !== undefined) {
    const p = formatQuantityE8(printed.get(miss) ?? 0n);
    const r = formatQuantityE8(reconstructed.get(miss) ?? 0n);
    throw new UnprovableSection(
      `${who}'s printed positions are not the book's before ${period.start} plus the section's trades — ${miss}: printed ${p}, reconstructed ${r}`,
      `its positions are not what the ledger held before ${formatDayFull(period.start)} plus this month's trades ` +
        `(${miss}: it prints ${p}, the trades give ${r}) — a split, a transfer or a trade this reader cannot see`,
    );
  }
  if (opening !== 0 && !heldBefore) {
    throw new UnprovableSection(
      `${who} opens with ${formatCents(opening)} of securities and the ledger's book holds no position before ${period.start}`,
      `it opens with ${formatCents(opening)} of securities, and the ledger holds no position for it before ${formatDayFull(period.start)}`,
    );
  }
  const unknown = [...new Set([...trades.map((t) => t.symbol), ...held.map((h) => h.symbol)])].sort().find((s) => !(s in assetTypes));
  if (unknown !== undefined) {
    throw new UnprovableSection(
      `${who} holds ${unknown}, and no position in this ledger records its asset type — refusing to guess stock or ETF`,
      `it holds ${unknown}, and no position in this ledger records whether ${unknown} is a stock or an ETF`,
    );
  }

  const assetOf = (symbol: string): EquityAssetType => assetTypes[symbol] as EquityAssetType;
  const positionTrades: PositionTrade[] = trades.map((t) => ({
    symbol: t.symbol,
    assetType: assetOf(t.symbol),
    occurredOn: t.tradedOn < period.start ? period.start : t.tradedOn,
    tradedOn: t.tradedOn,
    quantityDeltaE8: toStoredQuantity(t.side === "Buy" ? t.quantityE8 : -t.quantityE8, who),
    costCents: t.side === "Buy" ? -t.amountCents : null,
    printed: t.printed,
  }));
  const positions: PrintedPosition[] = [...new Set(held.map((h) => h.symbol))].map((symbol) => ({
    symbol,
    assetType: assetOf(symbol),
    quantityE8: toStoredQuantity(printed.get(symbol) as bigint, who),
    marketValueCents: held.filter((h) => h.symbol === symbol).reduce((n, h) => n + h.marketValueCents, 0),
  }));
  return { trades: positionTrades, held: positions };
}
