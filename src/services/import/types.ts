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
  /** why, in plain words — "it shows $26.22 of securities, and this account is read as cash only" */
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
  parse(file: SniffedFile, context?: ParseContext): Promise<ParsedStatement[] | ParsedFile> | ParsedStatement[] | ParsedFile;
}

/** An account the ledger tracks, as a statement section can be matched and routed to it. */
export interface KnownAccount {
  readonly last4: string;
  readonly type: AccountType;
  readonly subtype: AccountSubtype | null;
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
