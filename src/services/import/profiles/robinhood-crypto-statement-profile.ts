import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type KnownAccount, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";
import { selectTrackedSections, splitAtAccountHeaders, type TrackedSection } from "./robinhood-account-sections";

/**
 * Real Robinhood Crypto statement PDFs (single-column). The account is an
 * investment value anchor: OPENING/CLOSING BALANCE are portfolio VALUES with
 * sub-cent precision (rounded to the nearest cent). The activity table is
 * DATE TYPE DEBIT CREDIT PRICE VALUE FEE — a Crypto Purchase credits crypto for
 * $VALUE (cash into the account, +VALUE), a Crypto Sale debits crypto for $VALUE
 * (cash out, −VALUE). Reconciliation is value_anchor, so market movement lands in
 * market_change_cents; these rows are the activity ledger, priced by holding
 * events elsewhere.
 */

const PROFILE_ID = "robinhood-crypto-statement-pdf";

const PERIOD_START_RE = /^PERIOD START (\d{4}-\d{2}-\d{2})$/;
const PERIOD_END_RE = /^PERIOD END (\d{4}-\d{2}-\d{2})$/;
const OPENING_RE = /^OPENING BALANCE \$([\d.]+)$/;
const CLOSING_RE = /^CLOSING BALANCE \$([\d.]+)$/;
/** DATE TYPE DEBIT CREDIT PRICE VALUE FEE — DEBIT/CREDIT are "--" or "<qty> SYM" */
const ROW_RE =
  /^(\d{4}-\d{2}-\d{2}) (Crypto Purchase|Crypto Sale) (--|[\d.]+ [A-Z]+) (--|[\d.]+ [A-Z]+) \$[\d.]+ \$([\d.]+) (--|\$[\d.]+)$/;

function requireIso(raw: string): string {
  if (!isValidIsoDate(raw)) throw new ParseError(PROFILE_ID, `Invalid date "${raw}"`);
  return raw;
}

function findCapture(texts: readonly string[], re: RegExp): string | null {
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

export interface RobinhoodCryptoParse {
  periodStart: string;
  periodEnd: string;
  /** portfolio market values (positive assets), rounded to the nearest cent */
  openingValueCents: number;
  closingValueCents: number;
  txns: CanonicalTxn[];
}

/** `ACCOUNT NUMBER 311070628474` — never the `RHS ACCOUNT NUMBER 487513525` line under it. */
const ACCOUNT_NUMBER_RE = /^ACCOUNT NUMBER (\d+)$/;

/**
 * The lines of the ONE crypto account this ledger tracks.
 *
 * From 2026-07 the statement carries two crypto accounts: #311070628474 (the
 * owner's ETH, Robinhood Crypto ····8474) printed first, then #311407134147,
 * linked to the brokerage account #655929651. Every capture below used to be
 * "the first match anywhere in the document" and every activity row was read
 * from the whole of it, which was right only because of that print order — the
 * defect 3902f69 fixed in the brokerage statement, and it is fixed here by the
 * same rule (`selectTrackedSections`).
 *
 * ⛔ One statement imports into ONE Robinhood Crypto account (its hint carries
 * no number), so a file with two TRACKED crypto accounts is refused rather than
 * blended. A statement that prints no account number at all is one account, and
 * there is nothing to choose between.
 */
function trackedAccountLines(texts: readonly string[], trackedLast4s: readonly string[]): readonly string[] {
  const sections = splitAtAccountHeaders(texts, ACCOUNT_NUMBER_RE);
  if (sections.length === 0) return texts;
  const [only, ...more] = selectTrackedSections(PROFILE_ID, sections, trackedLast4s);
  if (more.length > 0) {
    throw new ParseError(
      PROFILE_ID,
      `Statement carries ${sections.map((s) => `#${s.accountNumber}`).join(", ")}, and more than one is a crypto ` +
        `account this ledger tracks — one crypto statement imports into one Robinhood Crypto, refusing to guess`,
    );
  }
  const section = only as TrackedSection;
  return texts.slice(section.start, section.end);
}

/**
 * The last4s a crypto statement's sections are chosen by: the accounts the
 * ledger tracks AS crypto, and no others.
 *
 * 🔴 ef16a75 offered every Robinhood last4. This profile's own hint carries no
 * number, so a Robinhood Crypto it creates never has one — while the brokerage
 * statement gives Robinhood Brokerage its ····3525. On that ledger every
 * one-account crypto statement read "none is an account this ledger tracks
 * (····3525)": measured over the 18 real crypto PDFs, all 18 refused, each of
 * which had imported before. A brokerage or cash account's number cannot name a
 * crypto account's section, so it is not offered as one.
 */
export function cryptoAccountLast4s(known: readonly KnownAccount[]): string[] {
  return known.filter((a) => a.type === "investment" && a.subtype === "crypto").map((a) => a.last4);
}

/** Pure text-level core, exported for unit tests. */
export function parseRobinhoodCryptoLines(
  allTexts: readonly string[],
  trackedLast4s: readonly string[] = [],
): RobinhoodCryptoParse {
  const texts = trackedAccountLines(allTexts, trackedLast4s);
  const start = findCapture(texts, PERIOD_START_RE);
  const end = findCapture(texts, PERIOD_END_RE);
  if (!start || !end) throw new ParseError(PROFILE_ID, "No PERIOD START/END found");

  const opening = findCapture(texts, OPENING_RE);
  const closing = findCapture(texts, CLOSING_RE);
  if (opening === null || closing === null) {
    throw new ParseError(PROFILE_ID, "Missing OPENING/CLOSING BALANCE");
  }

  const txns: CanonicalTxn[] = [];
  for (const text of texts) {
    const m = ROW_RE.exec(text);
    if (!m) continue;
    const isSale = m[2] === "Crypto Sale";
    // the non-"--" leg carries the crypto quantity + symbol
    const cryptoLeg = isSale ? m[3]! : m[4]!;
    const valueCents = parseAmountToCents(`$${m[5]}`);
    txns.push({
      postedOn: requireIso(m[1]!),
      // purchase = cash into the account (+), sale = cash out (−)
      amountCents: isSale ? -valueCents : valueCents,
      rawDescription: `${m[2]} ${cryptoLeg}`,
      categoryPath: isSale ? "Investments > Sells" : "Investments > Buys",
    });
  }

  return {
    periodStart: requireIso(start),
    periodEnd: requireIso(end),
    openingValueCents: parseAmountToCents(`$${opening}`),
    closingValueCents: parseAmountToCents(`$${closing}`),
    txns,
  };
}

/**
 * Three markers, following the isChaseCardStatementText doctrine — a single
 * marker would let one template tweak flip routing.
 *
 * The crypto statement is distinguished from the BROKERAGE statement, which
 * carries "Account Summary"/"Portfolio Value" and neither "Crypto Statement" nor
 * "PERIOD START" — see robinhood-brokerage-statement-profile.
 *
 * ⚠️ This comment previously named "Robinhood Brokerage Statement" as the
 * brokerage discriminator. Measured against the owner's 32-month archive that
 * string appears in 0 of 32 files; a gate built on it would have matched
 * nothing. Corrected 2026-08-06.
 */
export function isRobinhoodCryptoStatementText(text: string): boolean {
  return /Crypto Statement/.test(text) && /PERIOD START/.test(text) && /OPENING BALANCE/.test(text);
}

export const robinhoodCryptoStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // the hand-coined name this used to require is not what Robinhood ships —
  // content decides, so a native download imports unrenamed
  matches: (f) => f.format === "pdf",
  matchesContent: isRobinhoodCryptoStatementText,
  // no version bump: every file this profile has imported prints one account, and parses identically
  parse: async (f, context): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseRobinhoodCryptoLines(
      lines.map((l) => l.text),
      cryptoAccountLast4s(context?.knownAccounts.Robinhood ?? []),
    );
    return [
      {
        accountHint: {
          institution: "Robinhood",
          type: "investment",
          subtype: "crypto",
          name: "Robinhood Crypto",
        },
        txns: parsed.txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          // investment portfolio values are positive assets (not flipped)
          beginCents: parsed.openingValueCents,
          endCents: parsed.closingValueCents,
        },
      },
    ];
  },
};
