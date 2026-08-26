import { describe, expect, test } from "vitest";
import type { ParsedStatement, SniffedFile } from "../types";
import { rocketMoneyCsv } from "./rocket-money-csv";

const HEADER =
  "Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags";

/** `Date,Original Date,Type,AcctName,Acct#,Institution,Name,Custom,Amount,Description,Category,…` */
function row(opts: {
  date: string;
  account: string;
  institution: string;
  amount: string;
  name: string;
  description?: string;
  category?: string;
}): string {
  return [
    opts.date,
    opts.date,
    "Cash",
    "ACCOUNT",
    opts.account,
    opts.institution,
    `"${opts.name}"`,
    "",
    opts.amount,
    `"${opts.description ?? opts.name}"`,
    opts.category ?? "",
    "",
    "",
    "",
    "",
  ].join(",");
}

function file(rows: string[], name = "2026-08-25T18_34_42.633Z-transactions.csv"): SniffedFile {
  const text = [HEADER, ...rows].join("\n");
  return { name, buffer: Buffer.from(text), format: "csv", text };
}

const WF = { account: "5481", institution: "Wells Fargo" };

describe("rocketMoneyCsv — the sign convention is inverted", () => {
  /**
   * Their `Amount` is positive for money OUT. Getting this backwards would not
   * fail anywhere downstream — it would silently invert every figure on the
   * account — so it is asserted in both directions on real row shapes.
   */
  test("a positive amount is money OUT and a negative one is money IN", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([
        row({ ...WF, date: "2026-08-03", amount: "11.85", name: "McDonald's" }),
        row({ ...WF, date: "2026-07-29", amount: "-199", name: "ZELLE FROM RAYAN KARIM CHECA" }),
      ]),
    ) as ParsedStatement[];

    expect(statement!.txns).toHaveLength(2);
    expect(statement!.txns[0]!.amountCents).toBe(-1_185);
    expect(statement!.txns[1]!.amountCents).toBe(19_900);
  });

  test("a zero amount cannot become negative zero", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([row({ ...WF, date: "2026-08-03", amount: "0", name: "ADJUSTMENT" })]),
    ) as ParsedStatement[];
    expect(Object.is(statement!.txns[0]!.amountCents, -0)).toBe(false);
    expect(statement!.txns[0]!.amountCents).toBe(0);
  });
});

describe("rocketMoneyCsv — the allowlist is load-bearing", () => {
  /**
   * ⛔ The export carries 7,065 rows across nine accounts, seven of which this
   * ledger already holds from real statements. Because Rocket Money REWRITES
   * descriptions, those rows would not dedupe against the bank's own and would
   * insert thousands of plausible duplicates. This is the test that says so.
   */
  test("accounts that have their own bank feed are not emitted at all", () => {
    const statements = rocketMoneyCsv.parse(
      file([
        row({ date: "2026-08-03", account: "3522", institution: "Chase", amount: "20", name: "CHASE ROW" }),
        row({ date: "2026-08-03", account: "9805", institution: "Chase", amount: "20", name: "SAPPHIRE ROW" }),
        row({ date: "2026-08-03", account: "4741", institution: "Capital One", amount: "20", name: "DISCOVER ROW" }),
        row({ date: "2026-08-03", account: "9067", institution: "SoFi", amount: "20", name: "SOFI ROW" }),
        row({ date: "2026-08-03", account: "4208", institution: "Capital One", amount: "20", name: "VENTURE X ROW" }),
        row({ date: "2026-08-03", account: "1048", institution: "Chime", amount: "20", name: "CHIME ROW" }),
        row({ ...WF, date: "2026-08-03", amount: "11.85", name: "THE ONLY ROW THAT LANDS" }),
      ]),
    ) as ParsedStatement[];

    expect(statements).toHaveLength(1);
    expect(statements[0]!.accountHint.last4).toBe("5481");
    expect(statements[0]!.txns).toHaveLength(1);
    expect(statements[0]!.txns[0]!.rawDescription).toBe("THE ONLY ROW THAT LANDS");
  });

  /**
   * The export holds two Capital One 360 rows — a $1,047 outflow and $0.02 of
   * interest — with no opening deposit and nothing the money came from.
   * Importing a lone outflow would leave the account reading −$1,046.98.
   */
  test("Capital One 360's two-row fragment is not emitted", () => {
    const statements = rocketMoneyCsv.parse(
      file([
        row({ date: "2026-07-16", account: "4991", institution: "Capital One", amount: "1047", name: "RAYAN CHECA" }),
        row({ date: "2026-07-31", account: "4991", institution: "Capital One", amount: "-0.02", name: "Monthly Interest Paid" }),
      ]),
    ) as ParsedStatement[];
    expect(statements).toHaveLength(0);
  });

  test("an export with no allowlisted account yields no statements, not an error", () => {
    const statements = rocketMoneyCsv.parse(
      file([row({ date: "2026-08-03", account: "3522", institution: "Chase", amount: "20", name: "CHASE ROW" })]),
    ) as ParsedStatement[];
    expect(statements).toEqual([]);
  });
});

describe("rocketMoneyCsv — what it refuses to claim", () => {
  /**
   * The sum of the real Wells Fargo rows IS arithmetically its closing balance,
   * because the first of them is the account's opening deposit. Supplying that
   * as a `ledger` anchor would be a plug: an anchor exists to PROVE no row is
   * missing, and one derived from the rows it checks proves nothing (pass 59).
   */
  test("no ledger balance is claimed — the file has no running balance", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([
        row({ ...WF, date: "2026-07-27", amount: "-25", name: "WFB OPENING DEPOSIT" }),
        row({ ...WF, date: "2026-08-03", amount: "11.85", name: "McDonald's" }),
      ]),
    ) as ParsedStatement[];
    expect(statement!.ledger).toBeUndefined();
  });

  test("coverage is declared without balances, spanning the rows it holds", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([
        row({ ...WF, date: "2026-08-24", amount: "-1999", name: "ZELLE FROM RAYAN KARIM CHECA" }),
        row({ ...WF, date: "2026-07-27", amount: "-25", name: "WFB OPENING DEPOSIT" }),
        row({ ...WF, date: "2026-08-03", amount: "11.85", name: "McDonald's" }),
      ]),
    ) as ParsedStatement[];
    expect(statement!.declaredRange).toEqual({ start: "2026-07-27", end: "2026-08-24" });
    expect(statement!.period).toBeUndefined();
  });

  /**
   * Their `Category` column calls $2,022.92 from a relative "Income" and a
   * $0.42 metro fare "Dining & Drinks". Neither travels.
   */
  test("their Category never becomes a bankCategory hint", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([
        row({ ...WF, date: "2026-07-29", amount: "-2022.92", name: "REZAUL KARIM KHA", category: "Income" }),
        row({ ...WF, date: "2026-08-03", amount: "44.5", name: "VAPE N SMOKE SHOP", category: "Weed" }),
      ]),
    ) as ParsedStatement[];
    for (const txn of statement!.txns) expect(txn.bankCategory).toBeUndefined();
  });
});

describe("rocketMoneyCsv — the raw description is the bank's, not Rocket Money's", () => {
  /**
   * `Name` is Rocket Money's edit ("McDonald's"); `Description` retains the
   * bank's own text. `dedupe_hash` keys on the raw description, so the
   * least-processed column is the one that must win.
   */
  test("Description wins over Name when they differ", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([
        row({
          ...WF,
          date: "2026-08-03",
          amount: "11.85",
          name: "McDonald's",
          description: "PURCHASE AUTHORIZED ON 07/31 MCDONALD'S F14372 MIAMI BEACH FL CARD 7158",
        }),
      ]),
    ) as ParsedStatement[];
    expect(statement!.txns[0]!.rawDescription).toBe(
      "PURCHASE AUTHORIZED ON 07/31 MCDONALD'S F14372 MIAMI BEACH FL CARD 7158",
    );
  });

  test("Name is the fallback when Description is blank", () => {
    const [statement] = rocketMoneyCsv.parse(
      file([row({ ...WF, date: "2026-08-03", amount: "11.85", name: "McDonald's", description: "" })]),
    ) as ParsedStatement[];
    expect(statement!.txns[0]!.rawDescription).toBe("McDonald's");
  });
});

describe("rocketMoneyCsv — it fails loudly rather than misparsing", () => {
  test("matches its own header and nothing else", () => {
    const csv = (text: string): SniffedFile => ({ name: "x.csv", buffer: Buffer.from(text), format: "csv", text });
    expect(rocketMoneyCsv.matches(csv(HEADER + "\n"))).toBe(true);
    expect(rocketMoneyCsv.matches(csv("Account Number,Transaction Date,\n"))).toBe(false);
    expect(rocketMoneyCsv.matches({ ...csv(HEADER), format: "pdf" })).toBe(false);
  });

  test("a drifted header is rejected, not guessed at", () => {
    const drifted = HEADER.replace(",Transaction Tags", "");
    expect(() =>
      rocketMoneyCsv.parse({
        name: "x.csv",
        buffer: Buffer.from(drifted),
        format: "csv",
        text: `${drifted}\n${row({ ...WF, date: "2026-08-03", amount: "1", name: "X" })}`,
      }),
    ).toThrow(/Unexpected header row/);
  });

  test("a bad date and a bad amount each throw", () => {
    expect(() => rocketMoneyCsv.parse(file([row({ ...WF, date: "08/03/2026", amount: "1", name: "X" })]))).toThrow(
      /Invalid date/,
    );
    expect(() => rocketMoneyCsv.parse(file([row({ ...WF, date: "2026-08-03", amount: "abc", name: "X" })]))).toThrow(
      /Bad amount/,
    );
    expect(() => rocketMoneyCsv.parse(file([row({ ...WF, date: "2026-08-03", amount: "", name: "X" })]))).toThrow(
      /Empty amount/,
    );
  });

  test("a row with neither a description nor a name throws", () => {
    expect(() =>
      rocketMoneyCsv.parse(file([row({ ...WF, date: "2026-08-03", amount: "1", name: "", description: "" })])),
    ).toThrow(/Empty description/);
  });
});
