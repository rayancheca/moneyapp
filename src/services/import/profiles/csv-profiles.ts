import Papa from "papaparse";
import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile, type SniffedFile } from "../types";

/**
 * Per-institution CSV parser profiles. Every profile validates its exact
 * header row and fails loudly on drift (master-plan risk #2) — a silently
 * misparsed bank file is worse than a rejected one. Sign conventions are
 * normalized here at the boundary; nothing downstream sees raw bank signs.
 */

function parseCsv(file: SniffedFile, profileId: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(file.text.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  const fatal = result.errors.find((e) => e.type !== "FieldMismatch");
  if (fatal) throw new ParseError(profileId, `CSV parse error: ${fatal.message}`);
  return result.data;
}

function requireHeader(file: SniffedFile, profileId: string, expected: string): void {
  const firstLine = file.text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine !== expected) {
    throw new ParseError(profileId, `Unexpected header row: "${firstLine}" (expected "${expected}")`);
  }
}

function mdyToIso(profileId: string, raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) throw new ParseError(profileId, `Bad date "${raw}"`);
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  if (!isValidIsoDate(iso)) throw new ParseError(profileId, `Invalid date "${raw}"`);
  return iso;
}

function isoDate(profileId: string, raw: string): string {
  if (!isValidIsoDate(raw.trim())) throw new ParseError(profileId, `Invalid date "${raw}"`);
  return raw.trim();
}

function last4FromFilename(name: string): string | undefined {
  return /(\d{4})_/.exec(name)?.[1] ?? /Chase(\d{4})/i.exec(name)?.[1];
}

/**
 * Validates a running-balance column: sorted oldest-first, each balance must
 * equal the previous plus the amount — a broken chain means dropped rows
 * (e.g. Chase's reported silent truncation) and fails the parse.
 */
function validateRunningBalance(
  profileId: string,
  rows: { postedOn: string; amountCents: number; balanceCents: number }[],
): { cents: number; asOf: string } {
  const chronological = [...rows].reverse(); // files are newest-first
  for (let i = 1; i < chronological.length; i++) {
    const prev = chronological[i - 1]!;
    const cur = chronological[i]!;
    if (prev.balanceCents + cur.amountCents !== cur.balanceCents) {
      throw new ParseError(
        profileId,
        `Running balance breaks at ${cur.postedOn}: ${prev.balanceCents} + ${cur.amountCents} != ${cur.balanceCents} — file may be truncated`,
      );
    }
  }
  const newest = chronological.at(-1);
  if (!newest) throw new ParseError(profileId, "No rows");
  return { cents: newest.balanceCents, asOf: newest.postedOn };
}

const CHASE_DEPOSIT_HEADER = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #";

export const chaseDepositCsv: ParserProfile = {
  id: "chase-deposit-csv",
  version: 1,
  matches: (f) =>
    f.format === "csv" && /^Chase\d{4}_Activity/i.test(f.name) && f.text.startsWith("Details,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "chase-deposit-csv", CHASE_DEPOSIT_HEADER);
    const rows = parseCsv(f, "chase-deposit-csv").map((r) => ({
      postedOn: mdyToIso("chase-deposit-csv", r["Posting Date"] ?? ""),
      amountCents: parseAmountToCents(r.Amount ?? ""),
      balanceCents: parseAmountToCents(r.Balance ?? ""),
      rawDescription: r.Description ?? "",
    }));
    const ledger = validateRunningBalance("chase-deposit-csv", rows);
    const txns: CanonicalTxn[] = rows.map((r) => ({
      postedOn: r.postedOn,
      amountCents: r.amountCents, // already signed correctly for deposits
      rawDescription: r.rawDescription,
    }));
    return [
      {
        accountHint: { institution: "Chase", last4: last4FromFilename(f.name) },
        txns,
        ledger,
      },
    ];
  },
};

const CHASE_CARD_HEADER = "Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo";

export const chaseCardCsv: ParserProfile = {
  id: "chase-card-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Card,Transaction Date,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "chase-card-csv", CHASE_CARD_HEADER);
    const rows = parseCsv(f, "chase-card-csv");
    const txns: CanonicalTxn[] = rows.map((r) => ({
      postedOn: mdyToIso("chase-card-csv", r["Post Date"] ?? ""),
      transactedOn: mdyToIso("chase-card-csv", r["Transaction Date"] ?? ""),
      amountCents: parseAmountToCents(r.Amount ?? ""), // Chase: sales negative — matches canonical
      rawDescription: r.Description ?? "",
      bankCategory: r.Category || undefined,
    }));
    const last4 = rows[0]?.Card ?? last4FromFilename(f.name);
    return [{ accountHint: { institution: "Chase", last4, type: "credit" }, txns }];
  },
};

const DISCOVER_HEADER = "Trans. Date,Post Date,Description,Amount,Category";

export const discoverCardCsv: ParserProfile = {
  id: "discover-card-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Trans. Date,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "discover-card-csv", DISCOVER_HEADER);
    const txns: CanonicalTxn[] = parseCsv(f, "discover-card-csv").map((r) => ({
      postedOn: mdyToIso("discover-card-csv", r["Post Date"] ?? ""),
      transactedOn: mdyToIso("discover-card-csv", r["Trans. Date"] ?? ""),
      // Discover convention is INVERTED: purchases positive, credits negative
      amountCents: -parseAmountToCents(r.Amount ?? ""),
      rawDescription: r.Description ?? "",
      bankCategory: r.Category || undefined,
    }));
    return [{ accountHint: { institution: "Discover", type: "credit" }, txns }];
  },
};

const CAPONE_CARD_HEADER = "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit";

export const capOneCardCsv: ParserProfile = {
  id: "capitalone-card-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Transaction Date,Posted Date,Card No."),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "capitalone-card-csv", CAPONE_CARD_HEADER);
    const rows = parseCsv(f, "capitalone-card-csv");
    const txns: CanonicalTxn[] = rows.map((r) => {
      const debit = (r.Debit ?? "").trim();
      const credit = (r.Credit ?? "").trim();
      if ((debit === "") === (credit === "")) {
        throw new ParseError("capitalone-card-csv", `Row must have exactly one of Debit/Credit: ${JSON.stringify(r)}`);
      }
      return {
        postedOn: isoDate("capitalone-card-csv", r["Posted Date"] ?? ""),
        transactedOn: isoDate("capitalone-card-csv", r["Transaction Date"] ?? ""),
        amountCents: debit !== "" ? -parseAmountToCents(debit) : parseAmountToCents(credit),
        rawDescription: r.Description ?? "",
        bankCategory: r.Category || undefined,
      };
    });
    const last4 = rows[0]?.["Card No."];
    return [{ accountHint: { institution: "Capital One", last4, type: "credit" }, txns }];
  },
};

const CAPONE_360_HEADER =
  "Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance";

export const capOne360Csv: ParserProfile = {
  id: "capitalone-360-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Account Number,Transaction Date,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "capitalone-360-csv", CAPONE_360_HEADER);
    const raw = parseCsv(f, "capitalone-360-csv");
    const rows = raw.map((r) => ({
      postedOn: isoDate("capitalone-360-csv", r["Transaction Date"] ?? ""),
      amountCents: parseAmountToCents(r["Transaction Amount"] ?? ""),
      balanceCents: parseAmountToCents(r.Balance ?? ""),
      rawDescription: r["Transaction Description"] ?? "",
    }));
    const ledger = validateRunningBalance("capitalone-360-csv", rows);
    return [
      {
        accountHint: { institution: "Capital One", last4: raw[0]?.["Account Number"], type: "checking" },
        txns: rows.map(({ balanceCents: _b, ...t }) => t),
        ledger,
      },
    ];
  },
};

const SOFI_HEADER = "Date,Description,Type,Amount,Current balance,Status";

export const sofiCsv: ParserProfile = {
  id: "sofi-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Date,Description,Type,Amount,Current balance"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "sofi-csv", SOFI_HEADER);
    const rows = parseCsv(f, "sofi-csv").map((r) => ({
      postedOn: isoDate("sofi-csv", r.Date ?? ""),
      amountCents: parseAmountToCents(r.Amount ?? ""),
      balanceCents: parseAmountToCents(r["Current balance"] ?? ""),
      rawDescription: r.Description ?? "",
    }));
    const ledger = validateRunningBalance("sofi-csv", rows);
    const isSavings = /savings/i.test(f.name);
    return [
      {
        accountHint: {
          institution: "SoFi",
          type: isSavings ? "savings" : "checking",
          name: isSavings ? "SoFi Savings" : "SoFi Checking",
        },
        txns: rows.map(({ balanceCents: _b, ...t }) => t),
        ledger,
      },
    ];
  },
};

const RH_HEADER =
  '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"';

const RH_CODE_CATEGORY: Record<string, string | null> = {
  Buy: "Investments > Buys",
  Sell: "Investments > Sells",
  CDIV: "Income > Dividends",
  INT: "Income > Interest",
  GOLD: "Fees > Bank Fees",
  SLIP: "Income > Other Income",
  ACH: null, // transfer detection pairs the legs
  OTHER: null,
};

export const robinhoodActivityCsv: ParserProfile = {
  id: "robinhood-activity-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith('"Activity Date"'),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "robinhood-activity-csv", RH_HEADER);
    const rows = parseCsv(f, "robinhood-activity-csv");
    const txns: CanonicalTxn[] = [];
    for (const r of rows) {
      const date = (r["Activity Date"] ?? "").trim();
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue; // trailing disclaimer row
      const code = (r["Trans Code"] ?? "OTHER").trim();
      if (!(code in RH_CODE_CATEGORY)) {
        throw new ParseError("robinhood-activity-csv", `Unknown Trans Code "${code}" — refusing to guess`);
      }
      const amountRaw = (r.Amount ?? "").trim();
      if (amountRaw === "") continue; // non-cash rows (e.g. splits)
      const instrument = (r.Instrument ?? "").trim();
      txns.push({
        postedOn: mdyToIso("robinhood-activity-csv", date),
        amountCents: parseAmountToCents(amountRaw),
        rawDescription: instrument !== "" ? `${r.Description} (${instrument})` : (r.Description ?? ""),
        bankCategory: code,
        categoryPath: RH_CODE_CATEGORY[code] ?? undefined,
      });
    }
    return [
      {
        accountHint: {
          institution: "Robinhood",
          type: "investment",
          subtype: "brokerage",
          name: "Robinhood Brokerage",
        },
        txns,
      },
    ];
  },
};
