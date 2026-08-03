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
}

export interface AccountHint {
  institution: "Chase" | "Discover" | "Capital One" | "SoFi" | "Robinhood";
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
  parse(file: SniffedFile): Promise<ParsedStatement[]> | ParsedStatement[];
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
