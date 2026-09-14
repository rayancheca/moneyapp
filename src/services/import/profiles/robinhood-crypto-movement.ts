import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError } from "../types";
import type { Line } from "./pdf-profile";

/**
 * `Crypto Money Movement` rows from a Robinhood brokerage statement's
 * Account Activity table.
 *
 * WHY THIS EXISTS, and why it is the one exception to "statements add proof,
 * not money". The Robinhood activity CSV is the source for every other row on
 * `Robinhood Cash`, and its own footer says:
 *
 *   "This data does not include Robinhood Crypto or Robinhood Spending activity."
 *
 * It means it — there is not a single `COIN` trans code in any of the three
 * exported CSVs. So these rows have exactly one source, the statement PDF, and
 * emitting them cannot double-count the CSV because the CSV provably has none.
 *
 * Until now they were reconstructed by `pnpm rh-mirror-crypto-cash` from the
 * *crypto* ledger, using the printed sweep row where one could be matched and
 * the trade's own amount where the bank had batched the sweep. That fallback is
 * an approximation, and every reconciliation break on the account was exactly
 * (what the statement printed) − (what the mirror guessed): ±1c in two months,
 * ±$100 in another, and the whole $3,811.52 of 2026-07, which was never
 * mirrored at all.
 *
 * ⚠️ DIRECTION COMES FROM THE COLUMN, and nowhere else. Account Activity has no
 * running-balance column — only Debit and Credit — so unlike the sweep table
 * there is no arithmetic to recover the sign from. The amount's x-position
 * against the printed `Debit`/`Credit` header stops is the only carrier of
 * direction in the document. A row whose amount lands near neither stop is
 * REFUSED rather than guessed, and a statement with no header at all yields
 * nothing: an unsigned amount placed by assumption is the failure mode this
 * repo has already paid for twice.
 */

const PROFILE_ID = "robinhood-brokerage-statement-pdf";

const CRYPTO_RE = /Crypto Money Movement/;
const US_DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
/** `$1,234.56` or `($1,234.56)` — the account can genuinely go cash-negative. */
const MONEY_TOKEN_RE = /^\(?\$[\d,]+\.\d{2}\)?$/;

/**
 * How far from a column stop an amount may sit and still be read as being in
 * it. The two stops are ~53pt apart on the real statements, and amounts are
 * right-aligned within a few points of their header, so 30 is comfortably
 * inside the gap while still rejecting a token stranded between columns.
 */
const COLUMN_TOLERANCE = 30;

export interface CryptoMovement {
  postedOn: string;
  amountCents: number;
}

function toIso(usDate: string): string {
  const [mm, dd, yyyy] = usDate.split("/") as [string, string, string];
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date "${usDate}"`);
  return iso;
}

/** The Debit/Credit column stops, or null when this era prints no such header. */
function columnStops(lines: readonly Line[]): { debitX: number; creditX: number } | null {
  for (const line of lines) {
    const debit = line.tokens.find((t) => t.str === "Debit");
    const credit = line.tokens.find((t) => t.str === "Credit");
    if (debit && credit) return { debitX: debit.x, creditX: credit.x };
  }
  return null;
}

/** One Account Activity row, signed by its column, with the line it was read from. */
export interface ActivityRow extends CryptoMovement {
  line: Line;
}

/**
 * Every row the caller `accept`s from an Account Activity table: a line with a
 * date token and a money token, signed by which column the amount sits in.
 *
 * `Crypto Money Movement` was the first row type this repo had to read, and the
 * reason the column reader exists. The second is `ITRF` — the $26.64 transfer
 * #655929651's June 2026 statement prints as a Credit — and it needs exactly the
 * same rule, so the rule is here once rather than copied.
 */
export function parseAccountActivity(lines: readonly Line[], accept: (line: Line) => boolean): ActivityRow[] {
  const stops = columnStops(lines);
  if (!stops) return [];

  const rows: ActivityRow[] = [];
  for (const line of lines) {
    if (!accept(line)) continue;

    const amountTok = line.tokens.filter((t) => MONEY_TOKEN_RE.test(t.str)).at(-1);
    const dateTok = line.tokens.find((t) => US_DATE_RE.test(t.str));
    if (!amountTok || !dateTok) continue;

    const toDebit = Math.abs(amountTok.x - stops.debitX);
    const toCredit = Math.abs(amountTok.x - stops.creditX);
    if (Math.min(toDebit, toCredit) > COLUMN_TOLERANCE) {
      throw new ParseError(
        PROFILE_ID,
        `Account Activity row "${line.text}" sits in neither column ` +
          `(x=${amountTok.x}, Debit=${stops.debitX}, Credit=${stops.creditX}) — refusing to guess its direction`,
      );
    }

    // the paren form is already negative from parseAmountToCents; the column is
    // the authority on direction, so take the magnitude and let it decide
    const magnitude = Math.abs(parseAmountToCents(amountTok.str));
    rows.push({
      postedOn: toIso(dateTok.str),
      amountCents: toCredit < toDebit ? magnitude : -magnitude,
      line,
    });
  }
  return rows;
}

export function parseCryptoMoneyMovements(lines: readonly Line[]): CryptoMovement[] {
  return parseAccountActivity(lines, (line) => CRYPTO_RE.test(line.text)).map(({ postedOn, amountCents }) => ({
    postedOn,
    amountCents,
  }));
}
