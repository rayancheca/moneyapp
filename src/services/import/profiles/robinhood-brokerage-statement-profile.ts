import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";
import { parseCryptoMoneyMovements } from "./robinhood-crypto-movement";

/**
 * Real Robinhood *securities* statement PDFs — the arbiter `Robinhood Cash` has
 * never had.
 *
 * This profile emits almost NO transactions. The activity CSV already carries
 * the itemised settlement-cash rows (2,181 of them); the statement's job is to
 * say what the balance actually was, so the existing cash reconciliation can
 * grade the walk between two printed anchors. Emitting rows here would
 * double-count the CSV — statements add proof, not money.
 *
 * ⚠️ ONE EXCEPTION, added in pass 59: `Crypto Money Movement` rows. The CSV's
 * own footer says "This data does not include Robinhood Crypto or Robinhood
 * Spending activity", and it means it — there is not one `COIN` trans code in
 * any of the three exported CSVs. Those flows therefore have exactly one
 * source, this PDF, and emitting them cannot double-count the CSV because the
 * CSV provably has none. See ./robinhood-crypto-movement.ts; that single
 * dropped row type accounted for every reconciliation break on the account and
 * all 264 gap days in the ledger.
 *
 * `Robinhood Cash` is an `AccountType` of "checking", so `reconcileAccounts`
 * takes the CASH branch and a period that does not close to the cent reports a
 * real `gap`. No reconciliation change is needed: the gate already existed, it
 * simply had nothing to gate against.
 *
 * THREE LAYOUT ERAS, all present in the owner's 32-month archive:
 *   A. 2023-12 → 2025-01  `Net Account Balance <open> <close>`, no sweep line.
 *      The oldest statement prints `N/A` for the opening balance, so it yields a
 *      point-in-time ledger observation instead of a period.
 *   B. 2025-02 → 2026-01  `Brokerage Cash Balance` + `Deposit Sweep Balance`.
 *      Cash lives almost entirely in the SWEEP here — $41,532.16 against a
 *      $35.00 brokerage-cash line in 2025-07. Reading only the first line is
 *      what led a previous pass to conclude Robinhood's cash "sits near $0" and
 *      that this account could never reconcile. Total cash is the sum.
 *   C. 2026-02 → 2026-07  adds a `Brokerage-held Cash Activity` running ledger
 *      whose debit/credit totals close on the printed closing balance. When it
 *      is present we verify that identity and refuse the file if it fails —
 *      a parser that silently mis-reads a column is the failure mode this repo
 *      has already paid for twice.
 *
 * Amounts may be parenthesised negatives (`($9.90)`, 2025-11) — the account can
 * genuinely go cash-negative, so a regex that only accepts `$n.nn` would drop
 * the row and quietly shift every downstream balance.
 *
 * A statement can carry MORE THAN ONE account: from 2026-06 the owner's file
 * also contains `Individual Account #:655929651` ($26.64), which the app does
 * not track. Only the FIRST account section is parsed. Blending a second
 * account's balances into `Robinhood Cash` would corrupt the anchor, and
 * auto-creating an account from a statement is how a duplicate account gets
 * born.
 */

const PROFILE_ID = "robinhood-brokerage-statement-pdf";

/** `MM/DD/YYYY to MM/DD/YYYY`, printed in the page header of every era. */
const PERIOD_RE = /\b(\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})\b/;
/** `Individual Account #:487513525` — the per-account section boundary. */
const ACCOUNT_RE = /Account #:?\s*(\d+)/;

/**
 * A money token: `$1,234.56`, or the same wrapped in parens for a negative.
 * `parseAmountToCents` understands both, so the capture keeps the parens.
 */
const MONEY = String.raw`(\(?\$[\d,]+\.\d\d\)?)`;

/** Era A. `N/A` is a real printed value on the first statement. */
const NET_ACCOUNT_RE = new RegExp(String.raw`^Net Account Balance (N/A|${MONEY}) ${MONEY}$`);
/**
 * Era A′ (2023-12 → 2024-07) — the same figures, but the Account Summary is a
 * two-column layout whose amounts extract onto their OWN line, immediately
 * BEFORE the label:
 *
 *   "$0.04 $0.04"
 *   "Net Account Balance"
 *
 * Verified across all 8 statements of this era, and the values chain (each
 * closing equals the next opening), which is what distinguishes a real column
 * pairing from a coincidence of adjacency. The shape is required to be exactly
 * two money tokens (or `N/A` + one), so an unexpected layout declines the file
 * rather than pairing the label with whatever line happened to precede it.
 */
const BARE_NET_ACCOUNT_LABEL = "Net Account Balance";
const ORPHAN_PAIR_RE = new RegExp(String.raw`^(N/A|${MONEY}) ${MONEY}$`);
/**
 * Era B/C. The trailing `*` footnote marker is optional.
 *
 * Both labels appear a SECOND time in the portfolio-allocation table as
 * `Brokerage Cash Balance $1,679.93 2.42%` — one amount and a percentage.
 * Requiring two money tokens is what keeps the allocation row from being read
 * as an opening/closing pair.
 */
const BROKERAGE_CASH_RE = new RegExp(String.raw`^Brokerage Cash Balance \*? ?${MONEY} ${MONEY}$`);
const DEPOSIT_SWEEP_RE = new RegExp(String.raw`^Deposit Sweep Balance \*? ?${MONEY} ${MONEY}$`);

/** Era C only — the running cash ledger's own opening/closing and column totals. */
const LEDGER_OPEN_RE = new RegExp(String.raw`^Opening Brokerage-held Cash Balance \d{2}/\d{2}/\d{4} ${MONEY}$`);
const LEDGER_CLOSE_RE = new RegExp(String.raw`^Closing Brokerage-held Cash Balance \d{2}/\d{2}/\d{4} ${MONEY}$`);
const LEDGER_TOTAL_RE = new RegExp(String.raw`^Total Brokerage-held Cash ${MONEY} ${MONEY}$`);

function toIso(usDate: string): string {
  const [mm, dd, yyyy] = usDate.split("/") as [string, string, string];
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date "${usDate}"`);
  return iso;
}

function firstMatch(texts: readonly string[], re: RegExp): RegExpExecArray | null {
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return m;
  }
  return null;
}

/**
 * The lines belonging to the first account in the document.
 *
 * Robinhood appends each additional account as a fresh `Individual Account #:`
 * block, so the first block runs until the next account header (or to the end).
 */
export function firstAccountSection(texts: readonly string[]): { accountNumber: string; lines: string[] } {
  const starts: number[] = [];
  texts.forEach((t, i) => {
    if (ACCOUNT_RE.test(t)) starts.push(i);
  });
  if (starts.length === 0) throw new ParseError(PROFILE_ID, "No account number found");

  const first = starts[0] as number;
  const next = starts.find((i) => i > first);
  const accountNumber = (ACCOUNT_RE.exec(texts[first] as string) as RegExpExecArray)[1] as string;
  // the period header precedes the account line on page 1, so the section keeps
  // everything from the top of the document down to the next account block
  return { accountNumber, lines: texts.slice(0, next ?? texts.length) };
}

/**
 * Era A′ fallback: pair the bare `Net Account Balance` label with the amounts
 * line directly above it.
 *
 * ORPHAN_PAIR_RE is NET_ACCOUNT_RE without its label prefix, so the two share a
 * capture-group layout — group 1 is the opening (or `N/A`), group 3 the closing
 * — and the caller reads either match the same way.
 */
function findOrphanedNetAccountBalance(lines: readonly string[]): RegExpExecArray | null {
  const idx = lines.findIndex((t) => t.trim() === BARE_NET_ACCOUNT_LABEL);
  if (idx <= 0) return null;
  return ORPHAN_PAIR_RE.exec((lines[idx - 1] as string).trim());
}

/**
 * One printed line of the Deposit Sweep Activity ledger — a running balance
 * the bank states on a specific DAY.
 */
export interface SweepObservation {
  readonly day: string;
  /** the printed sweep balance AFTER this movement */
  readonly balanceCents: number;
  /** the printed movement amount, signed by the direction the balance moved */
  readonly amountCents: number;
}

/**
 * The `Deposit Sweep Activity` table: a DAY-level arbiter, where the rest of
 * this profile only yields a month-level one.
 *
 * Robinhood prints, for most statements, every movement of uninvested cash to
 * and from the program banks with a running balance beside it. 286 such lines
 * sit across 18 of the owner's 32 archived statements and nothing has ever read
 * them: this profile keeps only the month's opening and closing cash, so a
 * month that fails to reconcile reports one lump sum and cannot say WHICH DAY
 * the ledger parted company with the bank.
 *
 * Measured on 2025-10 — the worst month in the archive, $1,419.78 short — the
 * printed running balance tracks the replayed ledger to the cent through
 * 2025-10-16 and then diverges, which localises the fault to a handful of days
 * instead of a month. That is the entire point.
 *
 * `null` when the statement prints no such table (era A, and any month with no
 * sweep movement at all). Absence is not an error: 14 of the 32 archived
 * statements have none.
 */
export interface SweepLedger {
  readonly openingOn: string;
  readonly openingCents: number;
  readonly closingOn: string;
  readonly closingCents: number;
  /** every movement line, in printed order */
  readonly movements: readonly SweepObservation[];
}

const SWEEP_OPEN_RE = new RegExp(String.raw`^Opening Sweep Balance (\d{2}/\d{2}/\d{4}) ${MONEY}$`);
const SWEEP_CLOSE_RE = new RegExp(String.raw`^Closing Sweep Balance (\d{2}/\d{2}/\d{4}) ${MONEY}$`);
/**
 * A movement row: `<description> MM/DD/YYYY <amount> <running balance>`.
 *
 * The description is NOT pinned to "FDIC Sweep". Writing it that way is the
 * first thing tried and it is wrong: the table also carries `Interest Payment`
 * rows (`Interest Payment 03/26/2025 $0.50 $201.16`), and skipping them breaks
 * the running-balance chain on 5 of the 18 statements that have this table —
 * which is exactly how it announced itself.
 */
const SWEEP_MOVE_RE = new RegExp(String.raw`^(.+?) (\d{2}/\d{2}/\d{4}) ${MONEY} ${MONEY}$`);
/** `Total Swept Funds $1,813.26 $1,713.76` — the debit and credit column totals. */
const SWEPT_TOTAL_RE = new RegExp(String.raw`^Total Swept Funds ${MONEY} ${MONEY}$`);

/**
 * Parse the Deposit Sweep Activity table, or null when it is not printed.
 *
 * ⚠️ The printed movement amount is UNSIGNED — the PDF puts it in a Debit or a
 * Credit column. The sign is taken from the RUNNING BALANCE, and the unsigned
 * amount is then used to CHECK that reading: `|balance − previous| === printed
 * amount` on every row. A parser that infers a sign it cannot see is the
 * failure mode this repo has paid for twice.
 *
 * This docstring used to justify that by saying column position "does not
 * survive text extraction". That is FALSE and the correction matters: `Line`
 * carries `tokens: { str, x }[]`, and `pdf-profile.ts` already filters on
 * `t.x >= 350`. Column position survives perfectly well — this function simply
 * takes `readonly string[]` and never sees it. The running balance is still the
 * better source HERE, because it supports the three independent cross-checks
 * below; but the claim that x is unavailable is wrong, and believing it makes a
 * whole class of fix look impossible.
 *
 * It is not academic. The `Account Activity` table has NO balance column —
 * only Debit and Credit — so a text-only reader cannot sign its rows at all,
 * which is why every `Crypto Money Movement` row in the archive is silently
 * dropped. Reading their x against the Debit/Credit header stops is the only
 * way to recover them, and it is available today. See docs/future-ideas.md:
 * that single dropped row type accounts for all 264 remaining gap days.
 *
 * ⚠️ Rows are read ONLY between the opening and closing lines. A generic
 * `<desc> <date> <money> <money>` pattern applied to the whole document also
 * matches `Closing Collateral Balance 10/31/2025 $969.77 $0.00` from the
 * securities-lending collateral table, which is a different ledger entirely.
 * The table repeats its own `Deposit Sweep Activity` / `Description Date Debit
 * Credit Balance` headers at every page break; those carry no date and so fall
 * out of the pattern rather than needing to be listed.
 *
 * THREE independent checks have to agree before a ledger is returned, and each
 * one caught something the others did not while this was being written:
 *
 *   1. every row's printed amount equals its own balance step (finds a skipped
 *      row type — this is what exposed `Interest Payment`);
 *   2. the last row's balance equals the printed closing balance (finds a row
 *      dropped at the very end, which check 1 cannot see);
 *   3. the signed rows sum to the printed `Total Swept Funds` debit and credit
 *      columns (the bank's own arithmetic, independent of the running balance).
 *
 * Measured on the owner's archive: 18 of 32 statements print this table, 309
 * rows in total, and all three checks hold on every one of them. Before
 * `Interest Payment` rows were read, check 1 failed on 5 statements and check 2
 * failed on 12 of the 13 that got past check 1 — which is the whole argument
 * for keeping all three rather than whichever one is cheapest.
 */
export function parseSweepActivity(texts: readonly string[]): SweepLedger | null {
  const openIdx = texts.findIndex((t) => SWEEP_OPEN_RE.test(t));
  const closeIdx = texts.findIndex((t) => SWEEP_CLOSE_RE.test(t));
  if (openIdx === -1 || closeIdx === -1) return null;

  const open = SWEEP_OPEN_RE.exec(texts[openIdx] as string) as RegExpExecArray;
  const close = SWEEP_CLOSE_RE.exec(texts[closeIdx] as string) as RegExpExecArray;
  const openingCents = parseAmountToCents(open[2] as string);

  let previous = openingCents;
  let debits = 0;
  let credits = 0;
  const movements: SweepObservation[] = [];

  for (const text of texts.slice(openIdx + 1, closeIdx)) {
    const m = SWEEP_MOVE_RE.exec(text);
    if (!m) continue;
    const printed = parseAmountToCents(m[3] as string);
    const balanceCents = parseAmountToCents(m[4] as string);
    const delta = balanceCents - previous;
    if (Math.abs(delta) !== printed) {
      throw new ParseError(
        PROFILE_ID,
        `Sweep row "${text}" moves ${delta} but prints ${printed} — running balance and amount disagree`,
      );
    }
    if (delta < 0) debits -= delta;
    else credits += delta;
    movements.push({ day: toIso(m[2] as string), balanceCents, amountCents: delta });
    previous = balanceCents;
  }

  const closingCents = parseAmountToCents(close[2] as string);
  const lastCents = movements.at(-1)?.balanceCents ?? openingCents;
  if (lastCents !== closingCents) {
    throw new ParseError(
      PROFILE_ID,
      `Sweep table ends at ${lastCents} but prints a closing balance of ${closingCents} — a row is missing`,
    );
  }

  const totals = firstMatch(texts.slice(openIdx), SWEPT_TOTAL_RE);
  if (totals) {
    const printedDebits = parseAmountToCents(totals[1] as string);
    const printedCredits = parseAmountToCents(totals[2] as string);
    if (printedDebits !== debits || printedCredits !== credits) {
      throw new ParseError(
        PROFILE_ID,
        `Sweep rows total ${debits}/${credits} against a printed Total Swept Funds of ${printedDebits}/${printedCredits}`,
      );
    }
  }

  return {
    openingOn: toIso(open[1] as string),
    openingCents,
    closingOn: toIso(close[1] as string),
    closingCents,
    movements,
  };
}

export interface RobinhoodBrokerageParse {
  accountNumber: string;
  periodStart: string;
  periodEnd: string;
  /**
   * Total cash = brokerage-held cash + deposit sweep. `null` opening means the
   * statement printed `N/A` and there is no period to reconcile — only an
   * observation of the closing balance.
   */
  openingCashCents: number | null;
  closingCashCents: number;
  /** true when the Era-C running ledger was present and its identity held */
  ledgerVerified: boolean;
}

/** Pure text-level core, exported for unit tests. */
export function parseRobinhoodBrokerageLines(texts: readonly string[]): RobinhoodBrokerageParse {
  const { accountNumber, lines } = firstAccountSection(texts);

  const period = firstMatch(lines, PERIOD_RE);
  if (!period) throw new ParseError(PROFILE_ID, "No statement period found");
  const periodStart = toIso(period[1] as string);
  const periodEnd = toIso(period[2] as string);

  const net = firstMatch(lines, NET_ACCOUNT_RE) ?? findOrphanedNetAccountBalance(lines);
  const cash = firstMatch(lines, BROKERAGE_CASH_RE);
  if (!net && !cash) {
    throw new ParseError(PROFILE_ID, "No Net Account Balance or Brokerage Cash Balance line");
  }

  let openingCashCents: number | null;
  let closingCashCents: number;

  if (net) {
    // Era A — a single cash figure, and the oldest statement has no opening
    const rawOpen = net[1] as string;
    openingCashCents = rawOpen === "N/A" ? null : parseAmountToCents(rawOpen);
    closingCashCents = parseAmountToCents(net[3] as string);
  } else {
    const m = cash as RegExpExecArray;
    const sweep = firstMatch(lines, DEPOSIT_SWEEP_RE);
    // the sweep line is where the money actually sits in era B; its absence is
    // meaningful only as "no sweep balance", so a missing line reads as zero
    const sweepOpen = sweep ? parseAmountToCents(sweep[1] as string) : 0;
    const sweepClose = sweep ? parseAmountToCents(sweep[2] as string) : 0;
    openingCashCents = parseAmountToCents(m[1] as string) + sweepOpen;
    closingCashCents = parseAmountToCents(m[2] as string) + sweepClose;
  }

  return {
    accountNumber,
    periodStart,
    periodEnd,
    openingCashCents,
    closingCashCents,
    ledgerVerified: verifyLedgerIdentity(lines),
  };
}

/**
 * Era C prints a running cash ledger. `opening − debits + credits = closing` is
 * an arithmetic identity over Robinhood's own figures, so a mismatch means this
 * parser read a column wrong, not that the owner's data is off. Failing loudly
 * here is cheaper than importing a wrong anchor: a bad anchor silently rewrites
 * every derived balance after it.
 *
 * Returns false (not an error) when the section is simply absent, which is the
 * normal case for eras A and B.
 */
function verifyLedgerIdentity(lines: readonly string[]): boolean {
  const open = firstMatch(lines, LEDGER_OPEN_RE);
  const close = firstMatch(lines, LEDGER_CLOSE_RE);
  const totals = firstMatch(lines, LEDGER_TOTAL_RE);
  if (!open || !close || !totals) return false;

  const opening = parseAmountToCents(open[1] as string);
  const closing = parseAmountToCents(close[1] as string);
  const debits = parseAmountToCents(totals[1] as string);
  const credits = parseAmountToCents(totals[2] as string);

  const computed = opening - debits + credits;
  if (computed !== closing) {
    throw new ParseError(
      PROFILE_ID,
      `Cash ledger does not close: ${opening} − ${debits} + ${credits} = ${computed}, printed ${closing}`,
    );
  }
  return true;
}

/**
 * Three markers, following the isChaseCardStatementText doctrine — a single
 * marker would let one template tweak flip routing.
 *
 * The negative gates matter as much as the positive ones: the Robinhood CRYPTO
 * statement is also a Robinhood PDF, and `selectProfile` takes the first profile
 * whose gate passes, so an over-broad gate here would swallow it.
 *
 * ⚠️ Do NOT gate on the literal string "Robinhood Brokerage Statement". A
 * comment in the crypto profile long claimed that was the discriminator;
 * measured against the real archive it appears in 0 of 32 files, so a gate built
 * on it would match nothing at all.
 */
export function isRobinhoodBrokerageStatementText(text: string): boolean {
  return (
    /Account Summary/.test(text) &&
    /Portfolio Value/.test(text) &&
    PERIOD_RE.test(text) &&
    !/Crypto Statement/.test(text) &&
    !/PERIOD START/.test(text)
  );
}

export const robinhoodBrokerageStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  // v2: emits Crypto Money Movement rows. A parser fix never reaches an
  // already-imported file, so the bump is what makes the archive re-importable.
  version: 2,
  // Robinhood ships opaque UUID filenames, so content decides routing entirely
  matches: (f) => f.format === "pdf",
  matchesContent: isRobinhoodBrokerageStatementText,
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const parsed = parseRobinhoodBrokerageLines(lines.map((l) => l.text));
    // the full lines, not just their text — direction lives in the token x
    const txns: CanonicalTxn[] = parseCryptoMoneyMovements(lines).map((m) => ({
      postedOn: m.postedOn,
      amountCents: m.amountCents,
      rawDescription: "Crypto Money Movement",
      categoryPath: "Transfers",
      // the activity CSV documents that it excludes crypto activity, and does
      // (zero COIN codes); without this the CSV's day-coverage suppresses these
      soleSource: true,
    }));

    const accountHint = {
      institution: "Robinhood",
      type: "checking",
      name: "Robinhood Cash",
      // P0.1 (docs/inflight-dips.md): the settlement-cash ledger already exists
      // under this name and owns the dedupe hashes — route to it rather than
      // matching on type and risking a second Robinhood cash account
      preferName: "Robinhood Cash",
    } as const;

    // no opening balance printed: an observation, not a period to reconcile
    if (parsed.openingCashCents === null) {
      return [
        {
          accountHint,
          txns,
          declaredRange: { start: parsed.periodStart, end: parsed.periodEnd },
          ledger: { cents: parsed.closingCashCents, asOf: parsed.periodEnd },
        },
      ];
    }

    return [
      {
        accountHint,
        txns,
        period: {
          start: parsed.periodStart,
          end: parsed.periodEnd,
          beginCents: parsed.openingCashCents,
          endCents: parsed.closingCashCents,
        },
      },
    ];
  },
};
