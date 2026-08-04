import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile } from "../types";
import { extractLines } from "./pdf-profile";

/**
 * Real SoFi combined monthly statement PDFs (data/inbox/sofi/combined/
 * sofi-combined-YYYY-MM.pdf). Each PDF carries a Checking section then a
 * Savings section, each possibly spanning pages. Unlike the synthetic
 * "SoFi Checking ****1234" fixtures the generic statement parser knows, the
 * real layout anchors every section on a "Primary Account Holder Address
 * Account Number" block, prints the period inline on the address line
 * ("… 10458 Apr 1, 2026 - Apr 30, 2026"), and lists transactions NEWEST-FIRST
 * with a per-row running balance. Amounts are already net-worth-signed for a
 * deposit account (deposits +, withdrawals/payments −). Each activity row is
 * trailed by a "Transaction ID:" line captured as the fitid.
 *
 * Reconciliation is LAW: per section, beginning + Σ(amounts) must equal the
 * printed Current Balance, and each consecutive printed running balance must
 * be internally consistent, or the section throws (quarantined gap) — a
 * statement that doesn't sum is never silently trusted.
 */

const PROFILE_ID = "sofi-combined-statement-pdf";

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/** "Apr 1, 2026 - Apr 30, 2026" anywhere in a line (it trails the address). */
const PERIOD_RE = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) - ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/;
/** "Checking Account - 9067" / "Savings Account - 5791" (type + last4). */
const SECTION_HEADER_RE = /^(Checking|Savings) Account - (\d{4})$/;
/** "Mon D, YYYY <TYPE + DESCRIPTION> <±$AMOUNT> <$RUNNING_BALANCE>" */
const ROW_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (.+?) (-?\$[\d,]+\.\d{2}) (-?\$[\d,]+\.\d{2})$/;
const MONEY_TOKEN_RE = /^-?\$[\d,]+\.\d{2}$/;
const TXN_ID_RE = /^Transaction ID:\s*(\S+)/;
/** the once-per-section top-of-section anchor */
const SECTION_ANCHOR = "Primary Account Holder";

type SectionType = "checking" | "savings";

export interface SectionParse {
  last4: string;
  type: SectionType;
  periodStart: string;
  periodEnd: string;
  /** net-worth-signed (positive asset balance) */
  beginningBalanceCents: number;
  endingBalanceCents: number;
  txns: CanonicalTxn[];
}

function toIso(monthAbbr: string, day: number, year: number): string {
  const monthNum = MONTHS[monthAbbr];
  if (!monthNum) throw new ParseError(PROFILE_ID, `Unknown month "${monthAbbr}"`);
  const iso = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) throw new ParseError(PROFILE_ID, `Invalid date ${iso}`);
  return iso;
}

/** First "$…"/"-$…" money token on a line → cents (balances/amounts sit first). */
function firstMoneyToken(line: string): number | null {
  const token = line.split(/\s+/).find((t) => MONEY_TOKEN_RE.test(t));
  return token === undefined ? null : parseAmountToCents(token);
}

interface RunningRow {
  txn: CanonicalTxn;
  balanceCents: number;
}

/** Reconcile a section's newest-first rows against its printed balances. */
function reconcile(section: SectionParse, rows: readonly RunningRow[]): void {
  const label = `${section.type} ${section.last4} (${section.periodStart}…${section.periodEnd})`;
  if (rows.length === 0) {
    if (section.beginningBalanceCents !== section.endingBalanceCents) {
      throw new ParseError(
        PROFILE_ID,
        `${label}: no rows but Beginning ${section.beginningBalanceCents} ≠ Current ${section.endingBalanceCents}`,
      );
    }
    return;
  }

  // newest printed balance == Current Balance
  if (rows[0]!.balanceCents !== section.endingBalanceCents) {
    throw new ParseError(
      PROFILE_ID,
      `${label}: newest row balance ${rows[0]!.balanceCents} ≠ Current Balance ${section.endingBalanceCents}`,
    );
  }
  // each row's post-balance minus its own amount == the next-older row's post-balance
  for (let i = 0; i < rows.length - 1; i++) {
    const expectedOlder = rows[i]!.balanceCents - rows[i]!.txn.amountCents;
    if (expectedOlder !== rows[i + 1]!.balanceCents) {
      throw new ParseError(
        PROFILE_ID,
        `${label}: running balance break at row ${i} — ${rows[i]!.balanceCents} − ${rows[i]!.txn.amountCents} ≠ ${rows[i + 1]!.balanceCents}`,
      );
    }
  }
  // oldest row's pre-balance == Beginning Balance
  const oldest = rows[rows.length - 1]!;
  if (oldest.balanceCents - oldest.txn.amountCents !== section.beginningBalanceCents) {
    throw new ParseError(
      PROFILE_ID,
      `${label}: oldest pre-balance ${oldest.balanceCents - oldest.txn.amountCents} ≠ Beginning Balance ${section.beginningBalanceCents}`,
    );
  }
  // explicit sum identity: beginning + Σ(amounts) == ending
  const sum = rows.reduce((acc, r) => acc + r.txn.amountCents, 0);
  if (section.beginningBalanceCents + sum !== section.endingBalanceCents) {
    throw new ParseError(
      PROFILE_ID,
      `${label}: Beginning ${section.beginningBalanceCents} + Σ ${sum} ≠ Current ${section.endingBalanceCents}`,
    );
  }
}

/** Parse one account section (already sliced to its own line span). */
function parseSection(texts: readonly string[]): SectionParse {
  const headerLine = texts.find((t) => SECTION_HEADER_RE.test(t));
  const hm = headerLine ? SECTION_HEADER_RE.exec(headerLine) : null;
  if (!hm) throw new ParseError(PROFILE_ID, "Section missing 'Checking/Savings Account - NNNN' header");
  const type = hm[1] === "Savings" ? ("savings" as const) : ("checking" as const);
  const last4 = hm[2]!;

  const periodLine = texts.find((t) => PERIOD_RE.test(t));
  const pm = periodLine ? PERIOD_RE.exec(periodLine) : null;
  if (!pm) throw new ParseError(PROFILE_ID, `${type} ${last4}: no 'Mon D, YYYY - Mon D, YYYY' period`);
  const periodStart = toIso(pm[1]!, Number(pm[2]), Number(pm[3]));
  const periodEnd = toIso(pm[4]!, Number(pm[5]), Number(pm[6]));

  // "Current Balance" / "Beginning Balance" label lines; the FIRST money token
  // on the immediately following line is the balance (trailing columns are
  // interest/APY and vary across statement eras — always the first token).
  const currentIdx = texts.findIndex((t) => t.startsWith("Current Balance"));
  const beginIdx = texts.findIndex((t) => t.startsWith("Beginning Balance"));
  if (currentIdx === -1 || beginIdx === -1) {
    throw new ParseError(PROFILE_ID, `${type} ${last4}: missing Current/Beginning Balance labels`);
  }
  const endingBalanceCents = firstMoneyToken(texts[currentIdx + 1] ?? "");
  const beginningBalanceCents = firstMoneyToken(texts[beginIdx + 1] ?? "");
  if (endingBalanceCents === null || beginningBalanceCents === null) {
    throw new ParseError(PROFILE_ID, `${type} ${last4}: could not read printed balance amount`);
  }

  const rows: RunningRow[] = [];
  for (const text of texts) {
    const row = ROW_RE.exec(text);
    if (row) {
      const postedOn = toIso(row[1]!, Number(row[2]), Number(row[3]));
      rows.push({
        txn: {
          postedOn,
          amountCents: parseAmountToCents(row[5]!),
          rawDescription: row[4]!.trim(),
        },
        balanceCents: parseAmountToCents(row[6]!),
      });
      continue;
    }
    // a Transaction ID line trails its row — attach as fitid
    const idMatch = TXN_ID_RE.exec(text);
    if (idMatch && rows.length > 0 && rows[rows.length - 1]!.txn.fitid === undefined) {
      const last = rows[rows.length - 1]!;
      rows[rows.length - 1] = { ...last, txn: { ...last.txn, fitid: idMatch[1]! } };
    }
  }

  const section: SectionParse = {
    last4,
    type,
    periodStart,
    periodEnd,
    beginningBalanceCents,
    endingBalanceCents,
    txns: rows.map((r) => r.txn),
  };
  reconcile(section, rows);
  return section;
}

/** Pure text-level core, exported for unit tests. */
export function parseSofiCombinedLines(texts: readonly string[]): {
  checking?: SectionParse;
  savings?: SectionParse;
} {
  const anchorIdxs = texts.reduce<number[]>((acc, t, i) => {
    if (t.startsWith(SECTION_ANCHOR)) acc.push(i);
    return acc;
  }, []);
  if (anchorIdxs.length === 0) {
    throw new ParseError(PROFILE_ID, "No 'Primary Account Holder' section anchor — not a SoFi combined statement");
  }

  const result: { checking?: SectionParse; savings?: SectionParse } = {};
  for (let i = 0; i < anchorIdxs.length; i++) {
    const start = anchorIdxs[i]!;
    const end = i + 1 < anchorIdxs.length ? anchorIdxs[i + 1]! : texts.length;
    const parsed = parseSection(texts.slice(start, end));
    result[parsed.type] = parsed;
  }
  if (!result.checking && !result.savings) {
    throw new ParseError(PROFILE_ID, "SoFi combined statement produced no sections");
  }
  return result;
}

function toStatement(section: SectionParse): ParsedStatement {
  return {
    accountHint: {
      institution: "SoFi",
      last4: section.last4,
      type: section.type,
      name: section.type === "savings" ? "SoFi Savings" : "SoFi Checking",
    },
    txns: section.txns,
    period: {
      start: section.periodStart,
      end: section.periodEnd,
      beginCents: section.beginningBalanceCents,
      endCents: section.endingBalanceCents,
    },
  };
}

/**
 * Real SoFi downloads are opaque UUIDs, so the old sofi-statement-YYYY-MM name
 * gate only ever matched files a human had renamed. These three markers are
 * what the real statements print; the synthetic sofi-combined-*.pdf fixtures
 * say "Statement Period:" (not "Monthly Statement Period") and "SoFi Checking
 * ****5555" (not "Checking Account - 9067"), so they still route to the generic
 * parser. Measured: 33/33 real SoFi statements, 0 of the other 203.
 * Do NOT swap in /Transaction ID: \d/ — it misses sofi-statement-2026-06.
 */
export function isSofiCombinedStatementText(text: string): boolean {
  return (
    /Primary Account Holder/.test(text) &&
    /Monthly Statement Period/.test(text) &&
    /(Checking|Savings) Account - \d{4}/.test(text)
  );
}

export const sofiCombinedStatementPdf: ParserProfile = {
  id: PROFILE_ID,
  version: 1,
  matches: (f) => f.format === "pdf",
  matchesContent: isSofiCombinedStatementText,
  parse: async (f): Promise<ParsedStatement[]> => {
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(PROFILE_ID, "No extractable text — scanned PDF?");
    const { checking, savings } = parseSofiCombinedLines(lines.map((l) => l.text));
    const statements: ParsedStatement[] = [];
    if (checking) statements.push(toStatement(checking));
    if (savings) statements.push(toStatement(savings));
    return statements;
  },
};
