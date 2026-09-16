import type { AccountSubtype, AccountType } from "@/db/schema/accounts";
import type { FileFormat } from "@/db/schema/imports";

/** One transaction in canonical form — already net-worth-signed. */
export interface CanonicalTxn {
  postedOn: string;
  transactedOn?: string;
  amountCents: number;
  rawDescription: string;
  fitid?: string;
  bankCategory?: string;
  /** direct taxonomy assignment for investment rows ("Investments > Buys") */
  categoryPath?: string;
  /**
   * This row type exists in NO other feed for the account, so a
   * higher-fidelity source covering the same day must not suppress it.
   *
   * The coverage rule it opts out of is otherwise correct: a CSV is more
   * itemised than a PDF, so PDF rows on CSV-owned days are duplicates and get
   * skipped. But "the CSV covers this day" is not the same claim as "the CSV
   * covers this row", and for Robinhood they come apart — the activity CSV's
   * own footer says it excludes crypto activity, and it does (zero `COIN`
   * codes in any export). Without this flag every `Crypto Money Movement` row
   * is skipped as owned by a file that provably cannot contain it, which is
   * exactly what happened on the first attempt at this import.
   *
   * Set it only where the excluded-by-the-other-source claim is documented and
   * verified, never to force a row past a duplicate check.
   */
  soleSource?: boolean;
}

export interface AccountHint {
  institution: "Chase" | "Discover" | "Capital One" | "SoFi" | "Robinhood" | "Wells Fargo";
  last4?: string;
  type?: AccountType;
  subtype?: AccountSubtype;
  /** proper display name when the file carries one (PDF statements do) */
  name?: string;
  /**
   * Route to this named account when it exists at the institution, before any
   * type matching — P0.1 (docs/inflight-dips.md): the Robinhood activity CSV is
   * the settlement-cash LEDGER, so once a "Robinhood Cash" account exists its
   * rows must land there (anchor+replay derives the cash curve, and dedupe
   * hashes live under that account). Without it the hint's type match applies —
   * a fresh install keeps the pre-P0.1 inert-ledger behavior instead of
   * inventing an anchor-less account that degrades every day to partial.
   */
  preferName?: string;
  /**
   * The brokerage book of the cash account with this last4 — the investment account whose `cash_account_id` names it
   * (⚖️ owner, 2026-09-15: Robinhood Agentic keeps the cash, its book holds what the agent bought). Resolved by the
   * stored link, never by a name; the import creates the book the first time a section proves positions for it.
   */
  bookOf?: string;
}

/** A stock or fund's asset type — never a coin's, which no brokerage statement section holds. */
export type EquityAssetType = "stock" | "etf";

/** One Buy or Sell a statement section's Account Activity lists, as its brokerage book stores it. */
export interface PositionTrade {
  readonly symbol: string;
  readonly assetType: EquityAssetType;
  /** the trade date, or the period's first day for a trade that settled into this period from the one before */
  readonly occurredOn: string;
  /** the trade date as printed */
  readonly tradedOn: string;
  /** signed 1e-8 shares: a Buy positive, a Sell negative */
  readonly quantityDeltaE8: number;
  /** a Buy's printed amount; null for a Sell, whose proceeds are not what the shares cost */
  readonly costCents: number | null;
  /** the printed line */
  readonly printed: string;
}

/** A position the section's Securities Held (or Loaned Securities) prints at the period's end. */
export interface PrintedPosition {
  readonly symbol: string;
  readonly assetType: EquityAssetType;
  readonly quantityE8: number;
  readonly marketValueCents: number;
}

/**
 * What a section's positions statement carries: its trades, and the printed positions they were proven against —
 * what the book held before the period plus these trades equals `held`, exactly.
 */
export interface StatementPositions {
  readonly trades: readonly PositionTrade[];
  readonly held: readonly PrintedPosition[];
}

/** A trade executed but not settled by the period's end — read, checked against its table's total, never posted. */
export interface PendingTrade {
  readonly side: "Buy" | "Sell";
  readonly description: string;
  readonly tradedOn: string;
  readonly settlesOn: string;
  readonly quantityE8: number;
  /** signed by its column: a Buy negative (cash out when it settles), a Sell positive */
  readonly amountCents: number;
  readonly printed: string;
}

/** A quantity change a brokerage book already holds, as the positions reader sums it. */
export interface BookEvent {
  readonly symbol: string;
  readonly occurredOn: string;
  readonly quantityDeltaE8: number;
}

/** A statement the ledger holds for a cash account and read as cash only: its file wrote nothing on the account's book. */
export interface CashOnlyStatement {
  readonly fileName: string;
  readonly start: string;
  readonly end: string;
}

export interface StatementPeriodInfo {
  start: string;
  end: string;
  /** net-worth-signed */
  beginCents: number;
  endCents: number;
}

/** A single account's worth of parsed content (files can carry several). */
export interface ParsedStatement {
  accountHint: AccountHint;
  txns: CanonicalTxn[];
  /** full statement period with printed balances (PDFs) */
  period?: StatementPeriodInfo;
  /** declared coverage without balances (OFX DTSTART/DTEND) */
  declaredRange?: { start: string; end: string };
  /** point-in-time ledger observation (OFX LEDGERBAL, CSV running balance) */
  ledger?: { cents: number; asOf: string };
  /** a brokerage book's trades and printed positions (`AccountHint.bookOf`); the import stores them as holding events */
  positions?: StatementPositions;
  /** trades pending settlement at the period's end: noted, never posted — next period's activity lists them */
  pending?: readonly PendingTrade[];
}

/**
 * A section of a multi-account file its parser could not PROVE, and so did not import — named, dated and
 * explained, so the rest of the file imports without that section passing for read.
 *
 * 🔴 Why it exists: the Robinhood brokerage PDF is ONE file for two accounts. While a refusal about #655929651's
 * section threw, it failed the whole file — measured on August 2026's figures with a constructed agent buy,
 * Robinhood Cash lost the $2,500.10 of Crypto Money Movement credits no other source carries, and `pnpm
 * ledger-check` went red. A refusal about one account's section must not erase another account's provable money.
 */
export interface WithheldSection {
  /** the hint the section's statement would have carried — used to NAME its account, never to create or adopt one */
  readonly accountHint: AccountHint;
  /** the account number the section prints */
  readonly accountNumber: string;
  /** the statement window the section covers */
  readonly period: { readonly start: string; readonly end: string };
  /** why, in plain words — "it holds WMT, and no position in this ledger records whether WMT is a stock or an ETF" */
  readonly reason: string;
}

/** A file's parse when part of it was withheld. A profile that never withholds returns its statements alone. */
export interface ParsedFile {
  readonly statements: ParsedStatement[];
  readonly withheld: readonly WithheldSection[];
}

export interface SniffedFile {
  name: string;
  buffer: Buffer;
  format: FileFormat;
  /** decoded text for text formats */
  text: string;
}

export interface ParserProfile {
  id: string;
  version: number;
  matches(file: SniffedFile): boolean;
  /**
   * Optional second gate for formats whose `matches` cannot see inside the
   * file. A PDF's `SniffedFile.text` is empty (sniff.ts only decodes text
   * formats, and these streams are compressed and encrypted anyway), so two
   * products that share a download filename — Chase checking and Chase card
   * statements are both `<YYYYMMDD>-statements-<last4>-.pdf` — are
   * indistinguishable until the text is extracted. When a profile declares
   * this, selection extracts the document text ONCE and offers it here; the
   * profile is chosen only if it also returns true.
   */
  matchesContent?(text: string): boolean;
  /**
   * For a profile whose files depend on each other month over month: a key that sorts its files OLDEST first
   * (an ISO statement start), read from the same extracted text `matchesContent` sees. The Robinhood brokerage
   * statement's brokerage-book positions are proven by what the book held before the period — read in file-name order
   * (Robinhood's names are UUIDs), a later month would have nothing to be proven by and be withheld, and a withheld
   * month is read again only by a version bump. Files of other profiles keep their order.
   */
  orderKey?(text: string): string | null;
  parse(file: SniffedFile, context?: ParseContext): Promise<ParsedStatement[] | ParsedFile> | ParsedStatement[] | ParsedFile;
}

/** An account the ledger tracks, as a statement section can be matched and routed to it. */
export interface KnownAccount {
  readonly last4: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype | null;
  /** a cash account's brokerage book (`accounts.cash_account_id`) and every quantity change it holds; absent when it has none */
  readonly book?: { readonly events: readonly BookEvent[] };
  /**
   * A checking account's statements the ledger read as cash only, oldest first; absent when there is none. A section
   * that proves positions BEFORE one of them is withheld: that later month was never checked against those shares.
   */
  readonly cashOnlyStatements?: readonly CashOnlyStatement[];
}

/**
 * What the ledger already knows, offered to `parse` for a file that can carry
 * several accounts. A profile that has to choose between them chooses by an
 * account the ledger TRACKS — never by where an account happens to print — and
 * routes each one by what the ledger tracks it AS: the Robinhood brokerage
 * statement's second account (#655929651) is a cash account, its first is the
 * brokerage.
 */
export interface ParseContext {
  /** every account that has a last4, keyed by institution name; an account without one cannot be matched by number */
  knownAccounts: Readonly<Partial<Record<AccountHint["institution"], readonly KnownAccount[]>>>;
  /**
   * The asset type each stock or fund symbol already has in this ledger's holdings — a symbol with none, or with
   * both, is absent. A statement names a ticker, never whether it is a stock or an ETF, and a guess prices it wrong.
   */
  equityAssetTypes?: Readonly<Record<string, EquityAssetType>>;
}

export class ParseError extends Error {
  constructor(
    public readonly profileId: string,
    message: string,
  ) {
    super(`[${profileId}] ${message}`);
    this.name = "ParseError";
  }
}
