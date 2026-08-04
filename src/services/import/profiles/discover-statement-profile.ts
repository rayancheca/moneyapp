import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines, type Line } from "./pdf-profile";

/**
 * Real Discover it statement PDFs. The transaction detail is a TWO-COLUMN page
 * (transaction columns left, "Cashback Bonus Rewards" sidebar right) that
 * y-clustering interleaves onto shared lines — so this parser works on token
 * x-positions, not line text. Column bands (decoded from real PDFs): date x≈38,
 * description x≈80, merchant category x≈257, amount x≈377; the sidebar begins at
 * x≈414 and is discarded. Balances come from the title-case Account Summary
 * ("Previous Balance $104.00", "New Balance: $55.77"), never the all-caps sidebar
 * "PREVIOUS BALANCE" decoy. Printed purchases are positive and payments negative;
 * canonical form flips both (credit-card money-out is net-worth-negative).
 */

const PROFILE_ID = "discover-statement-pdf";

const SIDEBAR_X = 405;
const DESC_MIN_X = 55;
const DESC_MAX_X = 200;
const MONEY_RE = /^-?\$[\d,]+\.\d{2}$/;
const DATE_RE = /^(\d{2})\/(\d{2})$/;
const PERIOD_RE = /(\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})/;
const LAST4_RE = /ENDING IN (\d{4})/i;
const PREVIOUS_BALANCE_RE = /^Previous Balance (-?)\$([\d,]+\.\d{2})/;
const NEW_BALANCE_RE = /New Balance:\s*(-?)\$([\d,]+\.\d{2})/;

function toIso(mm: string, dd: string, yyyy: string): string {
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${mm}/${dd}/${yyyy}`);
  return iso;
}

function signedCents(minus: string | undefined, digits: string): number {
  const cents = parseAmountToCents(`$${digits}`);
  return minus === "-" && cents !== 0 ? -cents : cents;
}

export interface DiscoverParse {
  periodStart: string;
  periodEnd: string;
  /** printed convention: positive owed */
  previousBalanceCents: number;
  newBalanceCents: number;
  last4?: string;
  txns: CanonicalTxn[];
}

/** Pure core over positional lines, exported for unit tests. */
export function parseDiscoverItLines(lines: readonly Line[]): DiscoverParse {
  const periodLine = lines.find((l) => PERIOD_RE.test(l.text));
  const pm = periodLine ? PERIOD_RE.exec(periodLine.text) : null;
  if (!pm) throw new ParseError(PROFILE_ID, "No 'MM/DD/YYYY - MM/DD/YYYY' billing period found");
  const periodStart = toIso(pm[1]!, pm[2]!, pm[3]!);
  const periodEnd = toIso(pm[4]!, pm[5]!, pm[6]!);

  const prevLine = lines.find((l) => PREVIOUS_BALANCE_RE.test(l.text));
  const newLine = lines.find((l) => NEW_BALANCE_RE.test(l.text));
  const prev = prevLine ? PREVIOUS_BALANCE_RE.exec(prevLine.text) : null;
  const next = newLine ? NEW_BALANCE_RE.exec(newLine.text) : null;
  if (!prev || !next) throw new ParseError(PROFILE_ID, "Missing printed Previous/New Balance");

  const last4Line = lines.find((l) => LAST4_RE.test(l.text));
  const last4 = last4Line ? LAST4_RE.exec(last4Line.text)![1] : undefined;

  // activity dates carry no year. A listed txn transacted on or before the cycle
  // close, so its year is the one that places (month, day) at or before periodEnd
  // and closest to it — endYear normally, endYear−1 when that month overshoots
  // (e.g. a November trans date billed on a Dec→Jan statement).
  const endYear = Number(periodEnd.slice(0, 4));
  const inferYear = (mm: string, dd: string): number =>
    `${endYear}-${mm}-${dd}` <= periodEnd ? endYear : endYear - 1;

  const txns: CanonicalTxn[] = [];
  for (const line of lines) {
    const first = line.tokens[0];
    if (!first) continue;
    const dm = DATE_RE.exec(first.str);
    if (!dm) continue; // header rows, sidebar-first lines, continuation lines
    // right-hand sidebar (x ≥ SIDEBAR_X) is discarded; amount is the rightmost
    // money token in the transaction columns, description/category are the
    // non-money tokens to its left
    const amountTok = line.tokens.filter((t) => t.x < SIDEBAR_X && MONEY_RE.test(t.str)).at(-1);
    if (!amountTok) continue; // date without an amount is not an activity row
    const descTokens = line.tokens.filter(
      (t) => t.x >= DESC_MIN_X && t.x < DESC_MAX_X && !MONEY_RE.test(t.str),
    );
    const catTokens = line.tokens.filter(
      (t) => t.x >= DESC_MAX_X && t.x < SIDEBAR_X && t !== amountTok && !MONEY_RE.test(t.str),
    );
    const category = catTokens.map((t) => t.str).join(" ").trim();
    // the statement prints only the TRANS date, but its billing period is by
    // POST date; every listed txn is billed in this period, so the post date
    // provably lies within [periodStart, periodEnd]. Clamp the trans date into
    // the period for reconciliation/replay (date-range membership) and keep the
    // real trans date as transactedOn — otherwise a txn transacted just before
    // the cycle opened lands in the prior period and both periods gap.
    const transactedOn = toIso(dm[1]!, dm[2]!, String(inferYear(dm[1]!, dm[2]!)));
    const postedOn =
      transactedOn < periodStart ? periodStart : transactedOn > periodEnd ? periodEnd : transactedOn;
    txns.push({
      postedOn,
      transactedOn,
      // printed purchase +, payment − → canonical flips both
      amountCents: -parseAmountToCents(amountTok.str),
      rawDescription: descTokens.map((t) => t.str).join(" ").trim(),
      ...(category ? { bankCategory: category } : {}),
    });
  }

  return {
    periodStart,
    periodEnd,
    previousBalanceCents: signedCents(prev[1], prev[2]!),
    newBalanceCents: signedCents(next[1], next[2]!),
    ...(last4 ? { last4 } : {}),
    txns,
  };
}

/**
 * Real Discover statements lead with "DISCOVER IT CARD ENDING IN 4741". The
 * synthetic fixtures print "Account: Discover it Card ****2222" and carry no
 * "ENDING IN", so this separates the real product from the generated one; the
 * `\b.*\b` generalizes past the "it" product name. Measured over every PDF on
 * disk: 10/10 real Discover statements, 0 of the other 226.
 */
export function isDiscoverStatementText(text: string): boolean {
  return /^DISCOVER\b.*\bCARD ENDING IN \d{4}/im.test(text);
}

export const discoverItStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  // Discover's own download name is not the hand-coined one this used to
  // require — content decides, so a native download imports unrenamed
  matches: (f) => f.format === "pdf",
  matchesContent: isDiscoverStatementText,
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseDiscoverItLines(lines);
    return [
      {
        accountHint: {
          institution: "Discover",
          type: "credit",
          ...(parsed.last4 ? { last4: parsed.last4 } : {}),
        },
        txns: parsed.txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          // printed positive owed → net-worth negative
          beginCents: -parsed.previousBalanceCents,
          endCents: -parsed.newBalanceCents,
        },
      },
    ];
  },
};
