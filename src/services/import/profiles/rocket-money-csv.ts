import Papa from "papaparse";
import { isValidIsoDate } from "@/lib/dates";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile, type SniffedFile } from "../types";

/**
 * The Rocket Money transaction export — a FALLBACK source, and the only one
 * this ledger has for the Wells Fargo account.
 *
 * ## Why a secondary export is admitted at all
 *
 * Every other importer here reads a bank's own statement. This one reads a
 * re-export of somebody else's copy of a bank's data, which is two removes from
 * a source document and would normally be refused outright. It is admitted for
 * one account and one reason: **Wells Fargo Everyday Checking ····5481 has no
 * other source.** Money transferred there leaves the tracked ledger with no
 * destination and net worth understates by the balance. An imperfect record of
 * $10,499.17 of real activity beats no record of it.
 *
 * ## ⛔ The allowlist is LOAD-BEARING — it is not a convenience filter
 *
 * `dedupe_hash` is `sha256(account_id, posted_on, amount_cents, RAW
 * description, occurrence_index)` (`@/lib/hash`), and this file's raw text is
 * NOT the bank's. Rocket Money rewrites descriptions — `SQ *YA-FIT SMOOTHI`
 * loses its `SQ *`, `CPI*CANTEEN VENDIN 800-628-8363 FL` loses the phone
 * number — so a row exported here and the same row from the bank's own
 * statement hash DIFFERENTLY and dedupe cannot see they are the same charge.
 *
 * The export carries **7,065 rows across nine accounts**, seven of which this
 * ledger already holds from real statements. Parsing it without the allowlist
 * would silently insert ~7,000 duplicate transactions, every one of them
 * plausible, and no gate in the app would catch it: reconciliation only runs on
 * periods that carry printed balances, and this file has none.
 *
 * So the profile emits ONLY the accounts in {@link FALLBACK_ACCOUNTS}. Adding
 * one means asserting that the account has no bank feed of its own.
 *
 * ## What is deliberately dropped
 *
 * - **`Amount` is sign-inverted** relative to this ledger — positive means
 *   money OUT. Normalised here at the boundary, like every other profile.
 * - **The `Category` column is NOT carried through as `bankCategory`.** Two
 *   independent reasons, both measured. Their `Income` column totals $231,963
 *   over 254 rows of which at least $65,743 is family money and his own
 *   transfers — the Wells Fargo rows alone include $2,022.92 from a relative
 *   filed as `Income`, which would have walked straight into the settled
 *   income figure. And their categoriser is a string matcher: it files
 *   `WEIXIN*subway operatio`, a $0.42 metro fare, as "Dining & Drinks".
 *   `categorizeAll` already knows PURA VIDA, YA-FIT and VAPE N SMOKE from his
 *   other cards, so the ledger's own merchant map is the better evidence;
 *   anything it cannot place lands in the review queue where he can pick.
 * - **No `ledger` balance, deliberately.** The export has no running-balance
 *   column, so nothing here can reconcile. The sum of the 39 Wells Fargo rows
 *   is $2,396.67 and the first of them is the account's opening deposit, so
 *   that figure is arithmetically the closing balance IF no row is missing —
 *   and "if no row is missing" is exactly what an anchor is supposed to PROVE.
 *   Deriving one from the rows it is meant to check would be a plug (pass 59),
 *   so the account stays honestly `derived_unverified` until a real balance is
 *   entered by hand or a statement arrives.
 * - **`Description`, not `Name`, is the raw description.** `Name` is Rocket
 *   Money's cleaned label ("McDonald's"); `Description` retains the bank's
 *   original text. The least-processed column wins.
 */

const ROCKET_MONEY_HEADER =
  "Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags";

/**
 * ⛔ Accounts with NO bank feed of their own. See the allowlist note above
 * before adding one — an account that has statements must never appear here.
 *
 * Not listed, and why:
 * - Chase ····3522 / ····9805, Discover ····4741, SoFi ····9067 / ····5791,
 *   Venture X ····4208 — all covered by real statements in `data/statements/`.
 * - Chime ····1048 — deliberately not an account; opened for a bonus, closed.
 * - Capital One 360 ····4991 — the export holds TWO rows for it, a $1,047
 *   outflow and $0.02 of interest, with no opening deposit and nothing the
 *   money came from. Importing a lone outflow would leave the account reading
 *   −$1,046.98, which is not a balance any checking account has ever had. An
 *   incomplete fragment is worse than an empty account, so it waits for a
 *   statement.
 */
const FALLBACK_ACCOUNTS: readonly {
  accountNumber: string;
  institution: "Wells Fargo";
  name: string;
  type: "checking";
}[] = [
  {
    accountNumber: "5481",
    institution: "Wells Fargo",
    name: "Wells Fargo Everyday Checking",
    type: "checking",
  },
];

interface RocketRow {
  Date: string;
  "Account Number": string;
  Amount: string;
  Description: string;
  Name: string;
}

/** Their sign convention is the opposite of this ledger's: positive = money out. */
function invertedAmountToCents(profileId: string, raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") throw new ParseError(profileId, "Empty amount");
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new ParseError(profileId, `Bad amount "${raw}"`);
  const cents = Math.round(value * 100);
  // `-0` is what negating a zero gives, and it is a real value that survives
  // into the row: `Object.is(-0, 0)` is false, so anything comparing identity
  // rather than equality would see a different number than the file printed.
  // Caught by the test below, which was written before this branch existed.
  return cents === 0 ? 0 : -cents;
}

export const rocketMoneyCsv: ParserProfile = {
  id: "rocket-money-csv",
  version: 1,
  matches: (f) => f.format === "csv" && f.text.startsWith("Date,Original Date,Account Type,Account Name,"),
  parse: (f: SniffedFile): ParsedStatement[] => {
    const firstLine = f.text.trim().split("\n")[0]?.trim() ?? "";
    if (firstLine !== ROCKET_MONEY_HEADER) {
      throw new ParseError("rocket-money-csv", `Unexpected header row: "${firstLine}"`);
    }
    const result = Papa.parse<RocketRow>(f.text.trim(), { header: true, skipEmptyLines: true });
    const fatal = result.errors.find((e) => e.type !== "FieldMismatch");
    if (fatal) throw new ParseError("rocket-money-csv", `CSV parse error: ${fatal.message}`);

    const statements: ParsedStatement[] = [];
    for (const account of FALLBACK_ACCOUNTS) {
      const rows = result.data.filter((r) => r["Account Number"]?.trim() === account.accountNumber);
      if (rows.length === 0) continue;

      const txns: CanonicalTxn[] = rows.map((r) => {
        const postedOn = r.Date?.trim() ?? "";
        if (!isValidIsoDate(postedOn)) throw new ParseError("rocket-money-csv", `Invalid date "${r.Date}"`);
        // `Description` keeps the bank's own text; `Name` is Rocket Money's edit
        const rawDescription = (r.Description?.trim() || r.Name?.trim()) ?? "";
        if (rawDescription === "") throw new ParseError("rocket-money-csv", `Empty description on ${postedOn}`);
        return {
          postedOn,
          amountCents: invertedAmountToCents("rocket-money-csv", r.Amount ?? ""),
          rawDescription,
        };
      });

      const days = txns.map((t) => t.postedOn).sort();
      statements.push({
        accountHint: {
          institution: account.institution,
          last4: account.accountNumber,
          name: account.name,
          type: account.type,
        },
        txns,
        // Coverage without balances — the honest shape for a file that has no
        // running balance. Recorded as `not_applicable`, never `reconciled`.
        declaredRange: { start: days[0]!, end: days[days.length - 1]! },
      });
    }
    return statements;
  },
};
