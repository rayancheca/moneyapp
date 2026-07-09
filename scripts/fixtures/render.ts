import { compareDates } from "../../src/lib/dates";
import { hashString } from "../../src/lib/prng";
import type { AccountKey, SimAccount, SimTxn, Simulation } from "./simulate";

/**
 * Institution-exact structured renderers. Each is the inverse of the real
 * bank's export quirks (research digest): Discover flips purchase signs,
 * Capital One cards split Debit/Credit columns, Chase checking carries a
 * running balance, Robinhood quotes everything and wraps negatives in ($).
 */

const centsToPlain = (cents: number): string => (cents / 100).toFixed(2);
const mdy = (day: string): string => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const csvQuote = (s: string): string => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

function chronological(txns: readonly SimTxn[]): SimTxn[] {
  return [...txns].sort((a, b) => compareDates(a.postedOn, b.postedOn));
}

/** running balance AFTER each txn, keyed by array index (chronological). */
function runningBalances(txns: readonly SimTxn[], startCents: number): number[] {
  let balance = startCents;
  return txns.map((t) => (balance += t.amountCents));
}

export function inRange(txns: readonly SimTxn[], from: string, to: string): SimTxn[] {
  return chronological(txns).filter(
    (t) => compareDates(t.postedOn, from) >= 0 && compareDates(t.postedOn, to) <= 0,
  );
}

/** Chase deposit CSV: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip # (newest first). */
export function renderChaseDepositCsv(allTxns: readonly SimTxn[], startCents: number, from: string, to: string): string {
  const chrono = chronological(allTxns);
  const balances = runningBalances(chrono, startCents);
  const rows = chrono
    .map((t, i) => ({ t, balance: balances[i]! }))
    .filter(({ t }) => compareDates(t.postedOn, from) >= 0 && compareDates(t.postedOn, to) <= 0)
    .reverse()
    .map(({ t, balance }) =>
      [
        t.amountCents < 0 ? "DEBIT" : "CREDIT",
        mdy(t.postedOn),
        csvQuote(t.rawDescription),
        centsToPlain(t.amountCents),
        t.rawDescription.includes("PAYROLL") ? "ACH_CREDIT" : t.amountCents < 0 ? "ACH_DEBIT" : "MISC_CREDIT",
        centsToPlain(balance),
        "",
      ].join(","),
    );
  return ["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #", ...rows].join("\n") + "\n";
}

const CHASE_BANK_CATEGORY: [RegExp, string][] = [
  [/TRADER JOE|WHOLEFDS/, "Groceries"],
  [/STARBUCKS|CHIPOTLE|PIZZA|SWEETGREEN/, "Food & Drink"],
  [/NETFLIX|APPLE/, "Bills & Utilities"],
  [/AMAZON/, "Shopping"],
  [/CVS/, "Health & Wellness"],
];

/** Chase card CSV: Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo (sales negative). */
export function renderChaseCardCsv(txns: readonly SimTxn[], last4: string, from: string, to: string): string {
  const rows = inRange(txns, from, to)
    .reverse()
    .map((t) => {
      const category = t.amountCents > 0 ? "" : (CHASE_BANK_CATEGORY.find(([re]) => re.test(t.rawDescription))?.[1] ?? "Shopping");
      const type = t.amountCents > 0 ? (t.rawDescription.includes("Payment") ? "Payment" : "Return") : "Sale";
      return [last4, mdy(t.postedOn), mdy(t.postedOn), csvQuote(t.rawDescription), category, type, centsToPlain(t.amountCents), ""].join(",");
    });
  return ["Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo", ...rows].join("\n") + "\n";
}

const DISCOVER_CATEGORY: [RegExp, string][] = [
  [/MCDONALD|CHIPOTLE/, "Restaurants"],
  [/SPOTIFY|STEAM/, "Services"],
  [/UBER/, "Travel/ Entertainment"],
  [/PAYMENT|CASHBACK/, "Payments and Credits"],
];

/** Discover CSV: Trans. Date,Post Date,Description,Amount,Category — PURCHASES POSITIVE (sign flip). */
export function renderDiscoverCsv(txns: readonly SimTxn[], from: string, to: string): string {
  const rows = inRange(txns, from, to)
    .reverse()
    .map((t) =>
      [
        mdy(t.postedOn),
        mdy(t.postedOn),
        csvQuote(t.rawDescription),
        centsToPlain(-t.amountCents), // Discover convention: charges positive, credits negative
        DISCOVER_CATEGORY.find(([re]) => re.test(t.rawDescription))?.[1] ?? "Merchandise",
      ].join(","),
    );
  return ["Trans. Date,Post Date,Description,Amount,Category", ...rows].join("\n") + "\n";
}

/** Capital One card CSV: Debit/Credit split columns, YYYY-MM-DD dates. */
export function renderCapOneCardCsv(txns: readonly SimTxn[], last4: string, from: string, to: string): string {
  const rows = inRange(txns, from, to)
    .reverse()
    .map((t) => {
      const category = /SHELL|CHEVRON/.test(t.rawDescription)
        ? "Gas/Automotive"
        : /AIRLINES|MARRIOTT|AIRBNB|DELTA/.test(t.rawDescription)
          ? "Airfare"
          : /DOORDASH/.test(t.rawDescription)
            ? "Dining"
            : /FEE/.test(t.rawDescription)
              ? "Fee/Interest Charge"
              : "Other Services";
      const debit = t.amountCents < 0 ? centsToPlain(-t.amountCents) : "";
      const credit = t.amountCents > 0 ? centsToPlain(t.amountCents) : "";
      return [t.postedOn, t.postedOn, last4, csvQuote(t.rawDescription), category, debit, credit].join(",");
    });
  return ["Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit", ...rows].join("\n") + "\n";
}

/** Capital One 360 CSV: signed amount + running balance. */
export function renderCapOne360Csv(allTxns: readonly SimTxn[], startCents: number, last4: string, from: string, to: string): string {
  const chrono = chronological(allTxns);
  const balances = runningBalances(chrono, startCents);
  const rows = chrono
    .map((t, i) => ({ t, balance: balances[i]! }))
    .filter(({ t }) => compareDates(t.postedOn, from) >= 0 && compareDates(t.postedOn, to) <= 0)
    .reverse()
    .map(({ t, balance }) =>
      [last4, t.postedOn, centsToPlain(t.amountCents), t.amountCents < 0 ? "Debit" : "Credit", csvQuote(t.rawDescription), centsToPlain(balance)].join(","),
    );
  return ["Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance", ...rows].join("\n") + "\n";
}

/** SoFi CSV: Date,Description,Type,Amount,Current balance,Status. */
export function renderSofiCsv(allTxns: readonly SimTxn[], startCents: number, from: string, to: string): string {
  const chrono = chronological(allTxns);
  const balances = runningBalances(chrono, startCents);
  const rows = chrono
    .map((t, i) => ({ t, balance: balances[i]! }))
    .filter(({ t }) => compareDates(t.postedOn, from) >= 0 && compareDates(t.postedOn, to) <= 0)
    .reverse()
    .map(({ t, balance }) => {
      const type = t.rawDescription.includes("INTEREST") ? "Interest" : t.amountCents < 0 ? "Withdrawal" : "Deposit";
      return [t.postedOn, csvQuote(t.rawDescription), type, centsToPlain(t.amountCents), centsToPlain(balance), "Posted"].join(",");
    });
  return ["Date,Description,Type,Amount,Current balance,Status", ...rows].join("\n") + "\n";
}

/** Robinhood activity CSV: all fields quoted, ($x.xx) negatives, trailing disclaimer. */
export function renderRobinhoodActivityCsv(txns: readonly SimTxn[], from: string, to: string): string {
  const money = (cents: number): string =>
    cents < 0 ? `($${centsToPlain(-cents)})` : `$${centsToPlain(cents)}`;
  const rows = inRange(txns, from, to)
    .reverse()
    .map((t) => {
      const q = t.rh?.quantityE8 != null ? (t.rh.quantityE8 / 1e8).toFixed(8) : "";
      const price = t.rh?.price != null ? `$${t.rh.price.toFixed(2)}` : "";
      return [mdy(t.postedOn), mdy(t.postedOn), mdy(t.postedOn), t.rh?.instrument ?? "", t.rawDescription, t.rh?.transCode ?? "OTHER", q, price, money(t.amountCents)]
        .map((f) => `"${f}"`)
        .join(",");
    });
  return (
    [
      '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"',
      ...rows,
      '"The data provided is for informational purposes only. Robinhood Securities, LLC."',
    ].join("\n") + "\n"
  );
}

/** Deterministic FITID: stable across re-exports of the same range (same acquisition channel). */
function fitidFor(t: SimTxn, last4: string): string {
  return `${t.postedOn.replaceAll("-", "")}${(hashString(`${last4}|${t.rawDescription}|${t.amountCents}`) % 1_000_000_000).toString().padStart(9, "0")}`;
}

/** Chase QFX — OFX 1.x SGML (unclosed leaf tags, plaintext header). */
export function renderChaseQfx(account: SimAccount, txns: readonly SimTxn[], from: string, to: string, ledgerCents: number): string {
  const list = inRange(txns, from, to);
  const isCard = account.type === "credit";
  const d = (day: string) => day.replaceAll("-", "");
  const stmtTrn = list
    .map(
      (t) => `<STMTTRN>
<TRNTYPE>${t.amountCents < 0 ? "DEBIT" : "CREDIT"}
<DTPOSTED>${d(t.postedOn)}120000[0:GMT]
<TRNAMT>${centsToPlain(t.amountCents)}
<FITID>${fitidFor(t, account.last4)}
<NAME>${t.rawDescription.slice(0, 32).replaceAll("&", "&amp;")}
<MEMO>${t.rawDescription.replaceAll("&", "&amp;")}
</STMTTRN>`,
    )
    .join("\n");
  const inner = `<${isCard ? "CC" : ""}STMTRS>
<CURDEF>USD
<${isCard ? "CCACCTFROM" : "BANKACCTFROM"}>
${isCard ? "" : "<BANKID>021000021\n"}<ACCTID>00000000000${account.last4}
${isCard ? "" : `<ACCTTYPE>${account.type === "savings" ? "SAVINGS" : "CHECKING"}\n`}</${isCard ? "CCACCTFROM" : "BANKACCTFROM"}>
<BANKTRANLIST>
<DTSTART>${d(from)}120000[0:GMT]
<DTEND>${d(to)}120000[0:GMT]
${stmtTrn}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${centsToPlain(isCard ? -ledgerCents : ledgerCents)}
<DTASOF>${d(to)}120000[0:GMT]
</LEDGERBAL>
</${isCard ? "CC" : ""}STMTRS>`;
  const msgSet = isCard
    ? `<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n${inner}\n</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n${inner}\n</STMTTRNRS>\n</BANKMSGSRSV1>`;
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>${d(to)}120000[0:GMT]
<LANGUAGE>ENG
<FI>
<ORG>B1
<FID>10898
</FI>
<INTU.BID>10898
</SONRS>
</SIGNONMSGSRSV1>
${msgSet}
</OFX>
`;
}

/** Capital One OFX — OFX 2.0.2 XML with explicit close tags. */
export function renderCapOneOfx(account: SimAccount, txns: readonly SimTxn[], from: string, to: string, ledgerCents: number): string {
  const list = inRange(txns, from, to);
  const isCard = account.type === "credit";
  const d = (day: string) => day.replaceAll("-", "");
  const stmtTrn = list
    .map(
      (t) => `<STMTTRN><TRNTYPE>${t.amountCents < 0 ? "DEBIT" : "CREDIT"}</TRNTYPE><DTPOSTED>${d(t.postedOn)}</DTPOSTED><TRNAMT>${centsToPlain(t.amountCents)}</TRNAMT><FITID>${fitidFor(t, account.last4)}</FITID><MEMO>${t.rawDescription.replaceAll("&", "&amp;")}</MEMO></STMTTRN>`,
    )
    .join("\n");
  const acct = isCard
    ? `<CCACCTFROM><ACCTID>552856******${account.last4}</ACCTID></CCACCTFROM>`
    : `<BANKACCTFROM><BANKID>031176110</BANKID><ACCTID>36100${account.last4}</ACCTID><ACCTTYPE>${account.type === "savings" ? "SAVINGS" : "CHECKING"}</ACCTTYPE></BANKACCTFROM>`;
  const inner = `<${isCard ? "CC" : ""}STMTRS><CURDEF>USD</CURDEF>${acct}<BANKTRANLIST><DTSTART>${d(from)}</DTSTART><DTEND>${d(to)}</DTEND>
${stmtTrn}
</BANKTRANLIST><LEDGERBAL><BALAMT>${centsToPlain(isCard ? -ledgerCents : ledgerCents)}</BALAMT><DTASOF>${d(to)}</DTASOF></LEDGERBAL></${isCard ? "CC" : ""}STMTRS>`;
  const msgSet = isCard
    ? `<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>${inner}</CCSTMTTRNRS></CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>${inner}</STMTTRNRS></BANKMSGSRSV1>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="202" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>${d(to)}</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>
${msgSet}
</OFX>
`;
}

/** Balance of an account at end of a given day (chronological replay). */
export function balanceAt(sim: Simulation, key: AccountKey, day: string): number {
  const chrono = chronological(sim.txns.get(key) ?? []);
  let balance = sim.startBalances[key];
  for (const t of chrono) {
    if (compareDates(t.postedOn, day) > 0) break;
    balance += t.amountCents;
  }
  return balance;
}
