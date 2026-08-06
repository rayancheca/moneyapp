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
 * Validates a running-balance column: sorted oldest-first, each printed
 * balance must equal the last printed balance plus every amount since — a
 * broken chain means dropped rows (e.g. Chase's reported silent truncation)
 * and fails the parse. Real Chase exports leave the balance BLANK on
 * pending/same-day rows, so blanks are carried across, never fatal.
 */
function validateRunningBalance(
  profileId: string,
  rows: { postedOn: string; amountCents: number; balanceCents: number | null }[],
): { cents: number; asOf: string } | undefined {
  if (rows.length === 0) throw new ParseError(profileId, "No rows");
  const chronological = [...rows].reverse(); // files are newest-first
  let lastPrinted: number | null = null;
  let sumSincePrinted = 0;
  let ledger: { cents: number; asOf: string } | undefined;
  for (const cur of chronological) {
    sumSincePrinted += cur.amountCents;
    if (cur.balanceCents === null) continue;
    if (lastPrinted !== null && lastPrinted + sumSincePrinted !== cur.balanceCents) {
      throw new ParseError(
        profileId,
        `Running balance breaks at ${cur.postedOn}: ${lastPrinted} + ${sumSincePrinted} != ${cur.balanceCents} — file may be truncated`,
      );
    }
    lastPrinted = cur.balanceCents;
    sumSincePrinted = 0;
    ledger = { cents: cur.balanceCents, asOf: cur.postedOn };
  }
  return ledger;
}

const CHASE_DEPOSIT_HEADER = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #";

export const chaseDepositCsv: ParserProfile = {
  id: "chase-deposit-csv",
  version: 2,
  matches: (f) =>
    f.format === "csv" && /^Chase\d{4}_Activity/i.test(f.name) && f.text.startsWith("Details,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "chase-deposit-csv", CHASE_DEPOSIT_HEADER);
    const rows = parseCsv(f, "chase-deposit-csv").map((r) => ({
      postedOn: mdyToIso("chase-deposit-csv", r["Posting Date"] ?? ""),
      amountCents: parseAmountToCents(r.Amount ?? ""),
      // pending/same-day rows print no balance — tolerated, never anchored
      balanceCents: (r.Balance ?? "").trim() === "" ? null : parseAmountToCents(r.Balance!),
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
        ...(ledger ? { ledger } : {}),
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
  // v2: posted_on takes the LATER of the two printed dates — see below
  version: 2,
  matches: (f) => f.format === "csv" && f.text.startsWith("Trans. Date,"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "discover-card-csv", DISCOVER_HEADER);
    const txns: CanonicalTxn[] = parseCsv(f, "discover-card-csv").map((r) => {
      const posted = mdyToIso("discover-card-csv", r["Post Date"] ?? "");
      const transacted = mdyToIso("discover-card-csv", r["Trans. Date"] ?? "");
      return {
        /*
         * A charge cannot post before it happens, so `Post Date` earlier than
         * `Trans. Date` means Discover printed something other than a posting
         * date. It does exactly that for dispute adjustments: the credit is
         * BACK-DATED to the charge it reverses, while the real posting date
         * lands in `Trans. Date`.
         *
         * Measured on the owner's archive: 3 rows ledger-wide are inverted, all
         * Discover. Two are $40.00 dispute refunds that really posted
         * 2024-10-29 but were filed to 2024-09-18 and 2024-10-03; that
         * displacement put three consecutive reconciliation spans out by
         * exactly ±$40.00 and left 89 days unverifiable. Taking the later date
         * lands all three spans on their anchors to the cent.
         *
         * ISO dates compare lexicographically, and for an ordinary row
         * `Post Date` is already the later one, so this is a no-op there.
         */
        postedOn: transacted > posted ? transacted : posted,
        transactedOn: transacted,
        // Discover convention is INVERTED: purchases positive, credits negative
        amountCents: -parseAmountToCents(r.Amount ?? ""),
        rawDescription: r.Description ?? "",
        bankCategory: r.Category || undefined,
      };
    });
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

type SofiSide = "checking" | "savings";

const otherSide = (side: SofiSide): SofiSide => (side === "savings" ? "checking" : "savings");

/**
 * A SoFi export names only the COUNTERPARTY of an internal transfer: the
 * checking sheet's rows read "… from Savings - 5791" and the savings sheet's
 * are the exact mirror. Measured on the two real exports — 244/244 unanimous
 * each way — and, decisively, a sheet's OWN account number appears zero times
 * in its body. So the sheet proves which side it is NOT; the own account
 * number lives only in the filename. Routing on a number read out of the body
 * would therefore misfile every single export.
 */
const SOFI_COUNTERPARTY_RE = /\b(?:to|from)\s+(?:sofi\s+)?(checking|savings)\b(?:\s*-\s*(\d{4}))?/i;

/** The counterparty side, only when every transfer row agrees — a mixed sheet is not evidence. */
function sofiCounterparty(descriptions: readonly string[]): { side: SofiSide; last4s: Set<string> } | undefined {
  const sides = new Set<SofiSide>();
  const last4s = new Set<string>();
  for (const description of descriptions) {
    const m = SOFI_COUNTERPARTY_RE.exec(description);
    if (!m) continue;
    sides.add(m[1]!.toLowerCase() as SofiSide);
    if (m[2]) last4s.add(m[2]);
  }
  if (sides.size !== 1) return undefined;
  return { side: [...sides][0]!, last4s };
}

/** real exports carry the account number in the name: "SOFI-Checking•9067-…" */
const sofiOwnLast4 = (fileName: string): string | undefined => /(?:•|%E2%80%A2)(\d{4})/.exec(fileName)?.[1];

/**
 * Which SoFi account a sheet belongs to. Both signals are checked and any
 * contradiction throws, because the two accounts are indistinguishable
 * downstream once the rows land: `resolveAccount` matches on last4 first, and
 * an account created from a wrong hint is never corrected afterwards.
 */
function sofiSide(fileName: string, descriptions: readonly string[]): SofiSide {
  const nameSide: SofiSide | undefined = /savings/i.test(fileName)
    ? "savings"
    : /checking/i.test(fileName)
      ? "checking"
      : undefined;
  const counterparty = sofiCounterparty(descriptions);
  const bodySide = counterparty ? otherSide(counterparty.side) : undefined;

  if (nameSide && bodySide && nameSide !== bodySide) {
    throw new ParseError(
      "sofi-csv",
      `Filename says "${nameSide}" but every internal transfer in the sheet moves money to/from ${counterparty!.side}, which makes this the ${bodySide} export. Re-download it without renaming.`,
    );
  }
  const last4 = sofiOwnLast4(fileName);
  if (last4 && counterparty?.last4s.has(last4)) {
    throw new ParseError(
      "sofi-csv",
      `Filename claims account ····${last4}, but the sheet names ····${last4} as the OTHER side of its transfers — the filename does not belong to this export.`,
    );
  }

  const side = bodySide ?? nameSide;
  if (!side) {
    throw new ParseError(
      "sofi-csv",
      `Cannot tell checking from savings: "${fileName}" carries neither an account number (real exports look like "SOFI-Checking•9067-….csv") nor the word "checking"/"savings", and the sheet has no internal-transfer rows to infer from. Re-download the export without renaming it.`,
    );
  }
  return side;
}

/** SoFi Type → direct taxonomy assignment where the intent is unambiguous */
function sofiCategoryPath(type: string, amountCents: number): string | undefined {
  if (type === "INTEREST_EARNED") return "Income > Interest";
  // positive ATM rows are cash deposits (the seed rule maps those to Salary)
  if (type === "ATM" && amountCents < 0) return "Cash & ATM > ATM Withdrawals";
  return undefined;
}

export const sofiCsv: ParserProfile = {
  id: "sofi-csv",
  version: 2,
  matches: (f) => f.format === "csv" && f.text.startsWith("Date,Description,Type,Amount,Current balance"),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "sofi-csv", SOFI_HEADER);
    const rows = parseCsv(f, "sofi-csv")
      // pending rows re-export as Posted later with a different shape — never import them
      .filter((r) => (r.Status ?? "Posted").trim() === "Posted")
      // "Canceled deposit from …" rows are informational: the money never
      // moved, the amount never joins the running balance, and the printed
      // balance is a meaningless 0 — real exports prove all three
      .filter((r) => !/^Canceled\b/i.test((r.Description ?? "").trim()))
      .map((r) => {
        const description = (r.Description ?? "").trim();
        const printedCents = parseAmountToCents(r.Amount ?? "");
        // "Reversal of deposit from …" prints the ORIGINAL's magnitude, but
        // the balance column proves the effect is the opposite sign
        const amountCents = /^Reversal of\b/i.test(description) ? -printedCents : printedCents;
        const type = (r.Type ?? "").trim();
        return {
          postedOn: isoDate("sofi-csv", r.Date ?? ""),
          amountCents,
          balanceCents: parseAmountToCents(r["Current balance"] ?? ""),
          rawDescription: description,
          bankCategory: type || undefined,
          categoryPath: sofiCategoryPath(type, amountCents),
        };
      });
    const ledger = validateRunningBalance("sofi-csv", rows);
    const side = sofiSide(
      f.name,
      rows.map((r) => r.rawDescription),
    );
    const last4 = sofiOwnLast4(f.name);
    return [
      {
        accountHint: {
          institution: "SoFi",
          type: side,
          name: side === "savings" ? "SoFi Savings" : "SoFi Checking",
          ...(last4 ? { last4 } : {}),
        },
        txns: rows.map(({ balanceCents: _b, ...t }) => t),
        ...(ledger ? { ledger } : {}),
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
  GOLD: "Fees > Bank Fees", // Gold subscription
  SLIP: "Income > Other Income", // stock lending
  ACH: null, // transfer detection pairs the legs
  RTP: null, // instant bank transfer — paired like ACH
  DCF: null, // external debit-card transfer — paired like ACH
  ITRF: null, // brokerage-to-brokerage transfer (counter-account may be untracked)
  FUTSWP: null, // event-contracts inter-entity sweep — cash effect real, intent unknown
  SPL: null, // stock splits carry no cash amount; kept for completeness
  // a share RECEIPT — the owner's first AAPL fraction, 12/2023 — carries a
  // quantity and an empty Amount, so like SPL it moves shares and not cash.
  // Listing it is what stops the whole file failing: the code gate runs before
  // the empty-amount skip, and it refuses to guess rather than mis-file money.
  REC: null,
  OTHER: null,
};

/** real exports don't zero-pad ("6/5/2026") — strict MM/DD silently drops 80%+ of rows */
const RH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export const robinhoodActivityCsv: ParserProfile = {
  id: "robinhood-activity-csv",
  // v3: REC (share receipt) recognised — see RH_CODE_CATEGORY
  version: 3,
  matches: (f) => f.format === "csv" && f.text.startsWith('"Activity Date"'),
  parse: (f): ParsedStatement[] => {
    requireHeader(f, "robinhood-activity-csv", RH_HEADER);
    const rows = parseCsv(f, "robinhood-activity-csv");
    const txns: CanonicalTxn[] = [];
    for (const r of rows) {
      const date = (r["Activity Date"] ?? "").trim();
      const dm = RH_DATE_RE.exec(date);
      if (!dm) {
        // trailing disclaimer rows are amount-less (text lands in whichever
        // column, varies by export) — but a bad date WITH an amount is
        // silent-data-loss territory and must fail loudly
        if ((r.Amount ?? "").trim() !== "") {
          throw new ParseError("robinhood-activity-csv", `Bad Activity Date "${date}"`);
        }
        continue;
      }
      const code = (r["Trans Code"] ?? "OTHER").trim();
      if (!(code in RH_CODE_CATEGORY)) {
        throw new ParseError("robinhood-activity-csv", `Unknown Trans Code "${code}" — refusing to guess`);
      }
      const amountRaw = (r.Amount ?? "").trim();
      if (amountRaw === "") continue; // non-cash rows (e.g. splits)
      const instrument = (r.Instrument ?? "").trim();
      // multi-line quoted descriptions ("Marvell Technology\nCUSIP: …") flatten
      const description = (r.Description ?? "").replace(/\s+/g, " ").trim();
      // transfer fee riders ("Instant bank transfer - withdrawal fee") are
      // spend, not transfer legs — categorize deterministically
      const isTransferFee = RH_CODE_CATEGORY[code] === null && /\bfee\b/i.test(description);
      txns.push({
        postedOn: mdyToIso(
          "robinhood-activity-csv",
          `${dm[1]!.padStart(2, "0")}/${dm[2]!.padStart(2, "0")}/${dm[3]}`,
        ),
        amountCents: parseAmountToCents(amountRaw),
        rawDescription: instrument !== "" ? `${description} (${instrument})` : description,
        bankCategory: code,
        categoryPath: isTransferFee ? "Fees > Bank Fees" : (RH_CODE_CATEGORY[code] ?? undefined),
      });
    }
    return [
      {
        // P0.1 (docs/inflight-dips.md): the activity CSV IS the settlement-cash
        // ledger. Once a "Robinhood Cash" account exists (the real DB after the
        // pass-19 move), its rows must land there — anchor+replay derives the
        // cash curve there, and the moved ledger's dedupe hashes live under
        // that account (targeting the brokerage would re-duplicate all of it).
        // Without one, the brokerage fallback keeps fresh installs unchanged.
        accountHint: {
          institution: "Robinhood",
          type: "investment",
          subtype: "brokerage",
          name: "Robinhood Brokerage",
          preferName: "Robinhood Cash",
        },
        txns,
      },
    ];
  },
};
