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
