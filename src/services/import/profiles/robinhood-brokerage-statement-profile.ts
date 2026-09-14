import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import {
  ParseError,
  type AccountHint,
  type CanonicalTxn,
  type KnownAccount,
  type ParsedStatement,
  type ParserProfile,
} from "../types";
import { RH_CODE_CATEGORY } from "./csv-profiles";
import { extractLines, type Line } from "./pdf-profile";
import {
  selectTrackedSections,
  splitAtAccountHeaders,
  type AccountSection,
  type TrackedSection,
} from "./robinhood-account-sections";
import { parseAccountActivity, parseCryptoMoneyMovements } from "./robinhood-crypto-movement";

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
 * also contains `Individual Account #:655929651` — the $26.64 he moved over on
 * 2026-06-05 for Claude to trade with — printed after #487513525 through
 * 2026-07, and BEFORE it in 2026-08. Sections are chosen by account NUMBER
 * against the accounts the ledger already tracks (`selectAccountSections`),
 * never by position, and each tracked section goes to its OWN account by what
 * the ledger tracks it as (`robinhoodBrokerageStatements`): the brokerage to
 * Robinhood Cash + Robinhood Brokerage, a cash account to itself. An untracked
 * section is skipped. Blending a second account's balances into `Robinhood Cash`
 * would corrupt the anchor, and auto-creating an account from a statement is how
 * a duplicate account gets born — so the account must exist before its section
 * is read.
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

/**
 * PASS 73 — the securities anchor, and the two traps that make it look easy.
 *
 * `Total Securities` is the printed market value of everything held, opening and
 * closing. It is what gives `Robinhood Brokerage` — the last account in the
 * ledger without one — something to be checked against.
 *
 * ⛔ **The footnote marker is one asterisk in 2025 and TWO in 2026.** A regex
 * accepting `\*?` does not fail on the 2026 line; it falls through to the next
 * line that does match, which belongs to a different table.
 *
 * ⛔ **The same label appears again under `Loaned Securities`**, where the
 * columns are value / estimated dividend / share of portfolio:
 *
 *     Total Securities * $44,521.74 $421.61 84.37%
 *
 * Measured on the real archive, reading that line printed 2026-03's closing
 * balance as **$421.61** — an annual dividend estimate — instead of
 * $44,521.74. Requiring EXACTLY two money tokens to the end of the line is what
 * excludes it, which is the same guard `BROKERAGE_CASH_RE` above already uses
 * against the allocation table, for the same reason.
 *
 * ⚠️ Era A′ (2023-12 → 2024-07) prints the value in the orphaned two-column
 * layout, and is deliberately NOT read. `findOrphanedNetAccountBalance` pairs a
 * label with the line above it, which is an inference the cash figures earn by
 * chaining across all eight statements; the securities there are $16–$19 in an
 * account that held almost nothing, and a second adjacency inference for that
 * is risk without a reader. Those eight statements simply yield no securities
 * anchor — 24 of the 32 do, which is every statement with money in it.
 */
const TOTAL_SECURITIES_RE = new RegExp(String.raw`^Total Securities ?\*{0,3} ?(N/A|${MONEY}) ${MONEY}$`);

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
 * Every account the document carries, in print order.
 *
 * Robinhood prints each account as a fresh `Individual Account #:` block, so a
 * block runs until the next account's header (or to the end). A header that
 * repeats the SAME number continues its section rather than opening another.
 */
export function accountSections(texts: readonly string[]): AccountSection[] {
  const sections = splitAtAccountHeaders(texts, ACCOUNT_RE);
  if (sections.length === 0) throw new ParseError(PROFILE_ID, "No account number found");
  return sections;
}

/**
 * The sections of every account this ledger tracks, in print order — see
 * `selectTrackedSections` for the rule and its refusals.
 *
 * 🔴 History, because both earlier rules were each right for a while. "The first
 * section" read the untracked #655929651's $26.64 as Robinhood Cash's month when
 * 2026-08 printed it first (a $679.37 gap, 60 gap days, both crypto cash legs
 * quarantined). "The one tracked section" (3902f69) then refused every
 * statement once the owner tracked #655929651 as its own account. Each tracked
 * section now goes to its own account — see `robinhoodBrokerageStatements`.
 */
export function selectAccountSections(texts: readonly string[], trackedLast4s: readonly string[]): TrackedSection[] {
  return selectTrackedSections(PROFILE_ID, accountSections(texts), trackedLast4s);
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
  /**
   * PASS 73 — the printed market value of everything held, opening and closing.
   * `null` when the statement prints no `Total Securities` line at all (era A
   * and A′) or prints `N/A` for the opening: there is then no securities period
   * to anchor, which is different from one that anchors at zero.
   */
  openingSecuritiesCents: number | null;
  closingSecuritiesCents: number | null;
  /** true when the Era-C running ledger was present and its identity held */
  ledgerVerified: boolean;
}

/**
 * Pure text-level core, exported for unit tests: the one account of a statement
 * read on a ledger that tracks nothing yet. A document carrying more than one
 * account is refused here — which of them to read is a question for the tracked
 * accounts, see `robinhoodBrokerageStatements`.
 */
export function parseRobinhoodBrokerageLines(texts: readonly string[]): RobinhoodBrokerageParse {
  const [only] = selectAccountSections(texts, []);
  return parseSection(texts, only as AccountSection);
}

function parseSection(texts: readonly string[], section: AccountSection): RobinhoodBrokerageParse {
  const { accountNumber } = section;
  const lines = texts.slice(section.start, section.end);

  // every account in a file shares one statement period, and a later account's
  // page header prints ABOVE its account line — so outside the first section
  // the period is read from the file
  const period = firstMatch(lines, PERIOD_RE) ?? firstMatch(texts, PERIOD_RE);
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

  /*
   * Both halves or neither. A closing value with no opening is an observation
   * rather than a period, and this profile already has a shape for that — the
   * cash `ledger` branch — so a half-anchor here would be a second, quieter
   * way to say the same thing.
   */
  const securities = firstMatch(lines, TOTAL_SECURITIES_RE);
  const securitiesOpen = securities && securities[1] !== "N/A" ? parseAmountToCents(securities[1] as string) : null;

  return {
    accountNumber,
    periodStart,
    periodEnd,
    openingCashCents,
    closingCashCents,
    openingSecuritiesCents: securitiesOpen,
    /*
     * ⚠️ Group 3, not 2. `MONEY` is itself a capture group, so the `(N/A|MONEY)`
     * alternation nests one inside another and index 2 is the OPENING again —
     * which reads as a securities value that never moved all month.
     * `NET_ACCOUNT_RE` above is the same shape and indexes the same way.
     */
    closingSecuritiesCents: securitiesOpen === null ? null : parseAmountToCents(securities![3] as string),
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

/** `Total Funds Paid and Received $0.00 $26.64` — the Account Activity table's Debit and Credit column totals. */
const TOTAL_FUNDS_RE = new RegExp(String.raw`^Total Funds Paid and Received ${MONEY} ${MONEY}$`);

type SectionRoute = { kind: "brokerage" } | { kind: "cash"; last4: string };

/**
 * What a tracked section becomes is decided by what the ledger tracks its
 * account AS — never by where it prints, and never by what it happens to hold.
 *
 *  - the brokerage (`investment`/`brokerage`, #487513525 ····3525): the two
 *    statements this profile has always emitted, Robinhood Cash and Robinhood
 *    Brokerage. A fresh install's lone section is read this way too.
 *  - a cash account (`checking`, #655929651 ····9651 — the owner's $26.64 for
 *    Claude to trade with): ONE statement of its own. See `cashAccountStatement`.
 *
 * Anything else is refused: a brokerage statement's section is not a card, a
 * savings account or a crypto wallet, and routing one there would be a guess.
 */
function routeOf(section: TrackedSection, tracked: readonly KnownAccount[]): SectionRoute {
  if (section.last4 === null) return { kind: "brokerage" };
  const account = tracked.find((a) => a.last4 === section.last4) as KnownAccount;
  if (account.type === "investment" && account.subtype === "brokerage") return { kind: "brokerage" };
  if (account.type === "checking") return { kind: "cash", last4: section.last4 };
  const trackedAs = account.subtype ? `${account.type}/${account.subtype}` : account.type;
  throw new ParseError(
    PROFILE_ID,
    `#${section.accountNumber} is tracked as a ${trackedAs} account (····${section.last4}) — a brokerage statement's ` +
      `section is the brokerage itself or a cash account, refusing to guess where it goes`,
  );
}

/**
 * Every statement a Robinhood brokerage PDF carries for the accounts this ledger
 * tracks, in print order. Pure — `parse` is this plus text extraction.
 */
export function robinhoodBrokerageStatements(
  lines: readonly Line[],
  tracked: readonly KnownAccount[] = [],
): ParsedStatement[] {
  const texts = lines.map((l) => l.text);
  const routed = selectAccountSections(
    texts,
    tracked.map((a) => a.last4),
  ).map((section) => ({ section, route: routeOf(section, tracked) }));

  // the brokerage's statements route to Robinhood Cash and Robinhood Brokerage BY NAME, so two would overwrite each other
  const brokerages = routed.filter((r) => r.route.kind === "brokerage");
  if (brokerages.length > 1) {
    throw new ParseError(
      PROFILE_ID,
      `Statement carries more than one section tracked as the brokerage ` +
        `(${brokerages.map((b) => `#${b.section.accountNumber}`).join(", ")}) — refusing to guess which is Robinhood Cash`,
    );
  }

  return routed.flatMap(({ section, route }) =>
    route.kind === "brokerage"
      ? brokerageStatements(lines, texts, section)
      : [cashAccountStatement(lines, texts, section, route.last4)],
  );
}

/** The brokerage's section: its settlement cash (Robinhood Cash) and its securities (Robinhood Brokerage). */
function brokerageStatements(lines: readonly Line[], texts: readonly string[], section: AccountSection): ParsedStatement[] {
  const parsed = parseSection(texts, section);
  // read from THIS section only — a second account's Account Activity is another account's money
  const txns: CanonicalTxn[] = parseCryptoMoneyMovements(lines.slice(section.start, section.end)).map((m) => ({
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

  /*
   * PASS 73 — a SECOND statement, for the securities the same document
   * prints. `Robinhood Brokerage` was the last account in the ledger with no
   * arbiter: its holdings were rebuilt from the activity CSV and nothing has
   * ever checked them against a document.
   *
   * ⛔ It carries NO transactions. The trades are in the CSV, the crypto
   * movements go to the cash account above, and a period whose movement is
   * zero is exactly right for an investment anchor — `periodVerdict` grades an
   * investment period as a `value_anchor` and records the residual as market
   * change rather than accusing it of being a gap. What this adds is the two
   * printed endpoints, which is what `pnpm ledger-check` compares the app's
   * own holdings valuation against.
   *
   * ⚠️ `preferName` routes to the account that already exists. Without it a
   * second Robinhood investment account is one import away, and this profile's
   * header already records that auto-creating an account from a statement is
   * how a duplicate gets born.
   */
  const securities: ParsedStatement[] =
    parsed.openingSecuritiesCents === null || parsed.closingSecuritiesCents === null
      ? []
      : [
          {
            accountHint: {
              institution: "Robinhood",
              type: "investment",
              subtype: "brokerage",
              name: "Robinhood Brokerage",
              preferName: "Robinhood Brokerage",
            },
            txns: [],
            period: {
              start: parsed.periodStart,
              end: parsed.periodEnd,
              // an investment portfolio value is a positive asset, not flipped
              beginCents: parsed.openingSecuritiesCents,
              endCents: parsed.closingSecuritiesCents,
            },
          },
        ];

  // no opening balance printed: an observation, not a period to reconcile
  if (parsed.openingCashCents === null) {
    return [
      {
        accountHint,
        txns,
        declaredRange: { start: parsed.periodStart, end: parsed.periodEnd },
        ledger: { cents: parsed.closingCashCents, asOf: parsed.periodEnd },
      },
      ...securities,
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
    ...securities,
  ];
}

/**
 * A section whose account the ledger tracks as a CASH account — #655929651.
 *
 * Why cash, measured on all three statements it has printed (2026-06..08):
 * `Brokerage Cash Balance $26.64 100.00%`, `Total Securities $0.00`, nothing
 * held. As a checking account the cash branch replays its one transaction
 * between printed anchors and a month that does not close is a real `gap`; as an
 * investment account with no holdings it would step-hold its anchors, ignore the
 * $26.64 credit entirely, and value to $0 against every printed ending balance.
 *
 * It yields ONE statement, and its hint names the account by last4 alone:
 *  - no `type`, so `resolveAccount` can never ADOPT Robinhood Cash (checking, no
 *    last4) — adoption needs a type match — and no `preferName`, so it can never
 *    route there by name. It resolves to the account whose last4 it is.
 *  - ⛔ never a securities statement: `statement_periods` is unique on (file,
 *    account), and a $0.00 securities anchor would overwrite the cash anchor
 *    printed for the same day.
 *
 * Its `ITRF` rows are its only transactions — the $26.64 that arrived
 * 2026-06-05, whose other leg is Robinhood Cash's activity-CSV row. The export
 * is per account: the all-time file carries only that debit, so this statement
 * is the only source of the credit. It is NOT flagged `soleSource`: if the owner
 * ever downloads this account's own CSV, that file must be free to take the row
 * over rather than count it twice.
 *
 * ⛔ Everything else is REFUSED, loudly, because nothing else has a place here:
 *  - any printed securities, including a first month whose opening is `N/A`;
 *  - any Account Activity row that is not an `ITRF` (a Buy by the agent);
 *  - rows that do not sum to the printed Total Funds Paid and Received — the
 *    bank's own arithmetic, as the sweep table's check 3 is.
 */
function cashAccountStatement(
  lines: readonly Line[],
  texts: readonly string[],
  section: AccountSection,
  last4: string,
): ParsedStatement {
  const parsed = parseSection(texts, section);
  const who = `#${parsed.accountNumber}`;
  const own = lines.slice(section.start, section.end);

  refuseSecurities(
    own.map((l) => l.text),
    who,
    last4,
  );
  const txns = transferRows(own, who);
  const accountHint: AccountHint = { institution: "Robinhood", last4 };

  // its first statement prints N/A for the opening: an observation, never a $0.00 opening it did not print
  if (parsed.openingCashCents === null) {
    return {
      accountHint,
      txns,
      declaredRange: { start: parsed.periodStart, end: parsed.periodEnd },
      ledger: { cents: parsed.closingCashCents, asOf: parsed.periodEnd },
    };
  }
  return {
    accountHint,
    txns,
    period: {
      start: parsed.periodStart,
      end: parsed.periodEnd,
      beginCents: parsed.openingCashCents,
      endCents: parsed.closingCashCents,
    },
  };
}

/**
 * A cash account holds no securities, and must SAY so. `parseSection` reports no
 * securities at all for an `N/A` opening (both halves or neither), so the
 * printed line is read here directly — a first month that bought something must
 * not pass for cash because its opening was blank.
 */
function refuseSecurities(texts: readonly string[], who: string, last4: string): void {
  const printed = firstMatch(texts, TOTAL_SECURITIES_RE);
  if (!printed) {
    throw new ParseError(
      PROFILE_ID,
      `${who} prints no Total Securities line, so nothing shows it holds only cash — refusing to import it as a cash account (····${last4})`,
    );
  }
  // group 1 is the opening (or N/A), group 3 the closing — see parseSection
  const held = [printed[1], printed[3]].find((v) => v !== undefined && v !== "N/A" && parseAmountToCents(v) !== 0);
  if (held !== undefined) {
    throw new ParseError(
      PROFILE_ID,
      `${who} prints ${held} of securities, and the ledger tracks it as a cash account (····${last4}) — refusing to drop them`,
    );
  }
}

/** The cash account's Account Activity: `ITRF` rows only, checked against the printed column totals. */
function transferRows(own: readonly Line[], who: string): CanonicalTxn[] {
  const totalsAt = own.findIndex((l) => TOTAL_FUNDS_RE.test(l.text));
  if (totalsAt === -1) {
    throw new ParseError(PROFILE_ID, `${who} prints no Total Funds Paid and Received line — refusing to import its Account Activity unchecked`);
  }
  // the table runs from its title to its totals; the Executed Trades table after it has its own columns
  const tableAt = own.findIndex((l) => l.text === "Account Activity");
  const table = tableAt === -1 || tableAt > totalsAt ? [] : own.slice(tableAt, totalsAt);
  const rows = parseAccountActivity(table, () => true);

  const stray = rows.find((r) => !r.line.tokens.some((t) => t.str === "ITRF"));
  if (stray) {
    throw new ParseError(
      PROFILE_ID,
      `${who} prints an Account Activity row a cash account cannot hold — "${stray.line.text}" — ` +
        `only ITRF transfers are read there, refusing to drop it`,
    );
  }

  const debits = rows.reduce((n, r) => (r.amountCents < 0 ? n - r.amountCents : n), 0);
  const credits = rows.reduce((n, r) => (r.amountCents > 0 ? n + r.amountCents : n), 0);
  const totals = TOTAL_FUNDS_RE.exec((own[totalsAt] as Line).text) as RegExpExecArray;
  const printedDebits = parseAmountToCents(totals[1] as string);
  const printedCredits = parseAmountToCents(totals[2] as string);
  if (debits !== printedDebits || credits !== printedCredits) {
    throw new ParseError(
      PROFILE_ID,
      `${who}'s Account Activity rows total ${debits}/${credits} against a printed Total Funds Paid and Received of ${printedDebits}/${printedCredits}`,
    );
  }

  return rows.map((r) => {
    const description = r.line.tokens[0]?.str.trim() ?? "";
    if (description === "") {
      throw new ParseError(PROFILE_ID, `${who} prints an ITRF row with no description — "${r.line.text}"`);
    }
    return {
      postedOn: r.postedOn,
      amountCents: r.amountCents,
      // the description token, which is the activity CSV's own wording for the other leg
      rawDescription: description,
      bankCategory: "ITRF",
      // filed exactly as the activity CSV files an ITRF — the one table of Robinhood trans codes
      categoryPath: RH_CODE_CATEGORY.ITRF ?? undefined,
    };
  });
}

export const robinhoodBrokerageStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  /*
   * v4: a section whose account the ledger tracks as a CASH account becomes
   * that account's own statement (#655929651, `cashAccountStatement`). The
   * brokerage's statements are unchanged for every file in the archive. The
   * bump exists for the two statements that already carry the second account:
   * 2026-06 and 2026-07 were imported at v3, `ux_import_files_sha_parser` skips
   * an unbumped re-import as a duplicate, and only a re-parse can add the
   * account they print. Files not re-imported stay at v3, which is correct.
   *
   * v3: emits a second ParsedStatement carrying the securities anchor (pass 73).
   * A parser fix never reaches an already-imported file, so the bump is what
   * makes the 32-statement archive re-importable — the same reason v2 existed.
   */
  version: 4,
  // Robinhood ships opaque UUID filenames, so content decides routing entirely
  matches: (f) => f.format === "pdf",
  matchesContent: isRobinhoodBrokerageStatementText,
  parse: async (f, context): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    // the full lines, not just their text — direction lives in the token x
    return robinhoodBrokerageStatements(lines, context?.knownAccounts.Robinhood ?? []);
  },
};
