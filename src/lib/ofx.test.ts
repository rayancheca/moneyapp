import { describe, expect, test } from "vitest";
import { OfxParseError, parseOfxAmount, parseOfxDate, parseOfxStatements, parseOfxTree } from "./ofx";

const SGML_BANK = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>000004321
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101120000[0:GMT]
<DTEND>20260131120000[0:GMT]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-43.64
<FITID>202601159999
<NAME>BODEGA &amp; DELI
<MEMO>BODEGA &amp; DELI NEW YORK NY
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>1234.56
<DTASOF>20260131
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const XML_CARD = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="202"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID>
<CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>552856******4444</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20260401</DTSTART><DTEND>20260430</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260415</DTPOSTED><TRNAMT>-12,50</TRNAMT><FITID>x1</FITID><MEMO>EU STYLE DECIMAL</MEMO></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>286.51</BALAMT><DTASOF>20260430</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe("parseOfxDate / parseOfxAmount", () => {
  test("dates with and without time/timezone suffixes", () => {
    expect(parseOfxDate("20260115")).toBe("2026-01-15");
    expect(parseOfxDate("20260115120000[0:GMT]")).toBe("2026-01-15");
    expect(() => parseOfxDate("Jan 15")).toThrow(OfxParseError);
  });

  test("amounts: signs, comma decimals, zero, overflow, garbage", () => {
    expect(parseOfxAmount("-43.64")).toBe(-4364);
    expect(parseOfxAmount("+12")).toBe(1200);
    expect(parseOfxAmount(".5")).toBe(50);
    expect(parseOfxAmount("12,5")).toBe(1250); // some banks emit comma decimals
    expect(Object.is(parseOfxAmount("-0.00"), 0)).toBe(true);
    expect(() => parseOfxAmount("abc")).toThrow(OfxParseError);
    expect(() => parseOfxAmount("")).toThrow(OfxParseError);
    expect(() => parseOfxAmount("99999999999999999999")).toThrow(OfxParseError);
  });
});

describe("parseOfxTree", () => {
  test("rejects content without an OFX element", () => {
    expect(() => parseOfxTree("hello world")).toThrow(OfxParseError);
  });

  test("tolerates unclosed leaf tags and pops unmatched closes", () => {
    const tree = parseOfxTree("<OFX><A><B>value<C>other</A></OFX>");
    expect(tree).toBeDefined();
  });
});

describe("parseOfxStatements", () => {
  test("parses SGML bank statements with entities, FITIDs, and ledger balance", () => {
    const [s] = parseOfxStatements(SGML_BANK);
    expect(s!.kind).toBe("bank");
    expect(s!.accountId).toBe("000004321");
    expect(s!.rangeStart).toBe("2026-01-01");
    expect(s!.rangeEnd).toBe("2026-01-31");
    expect(s!.ledgerBalanceCents).toBe(123_456);
    expect(s!.ledgerBalanceAsOf).toBe("2026-01-31");
    expect(s!.transactions).toEqual([
      {
        type: "DEBIT",
        postedOn: "2026-01-15",
        amountCents: -4_364,
        fitid: "202601159999",
        name: "BODEGA & DELI",
        memo: "BODEGA & DELI NEW YORK NY",
      },
    ]);
  });

  test("parses OFX 2.x XML credit-card statements", () => {
    const [s] = parseOfxStatements(XML_CARD);
    expect(s!.kind).toBe("creditcard");
    expect(s!.accountId).toBe("552856******4444");
    expect(s!.transactions[0]!.amountCents).toBe(-1_250);
    expect(s!.ledgerBalanceCents).toBe(28_651);
  });

  test("statement missing TRNAMT fails loudly", () => {
    const broken = SGML_BANK.replace("<TRNAMT>-43.64\n", "");
    expect(() => parseOfxStatements(broken)).toThrow(/missing TRNAMT/);
  });

  test("file with no statements fails loudly", () => {
    expect(() => parseOfxStatements("<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>")).toThrow(
      /no bank or credit-card statements/,
    );
  });

  test("statement without a ledger balance yields nulls, not lies", () => {
    const noLedger = SGML_BANK.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>\n/, "");
    const [s] = parseOfxStatements(noLedger);
    expect(s!.ledgerBalanceCents).toBeNull();
    expect(s!.ledgerBalanceAsOf).toBeNull();
  });

  test("missing DTPOSTED fails loudly", () => {
    const broken = SGML_BANK.replace("<DTPOSTED>20260115\n", "");
    expect(() => parseOfxStatements(broken)).toThrow(/missing TRNAMT or DTPOSTED/);
  });

  test("empty OFX body fails loudly", () => {
    expect(() => parseOfxStatements("<OFX></OFX>")).toThrow(OfxParseError);
  });

  test("minimal statement: no txn list, no range, no TRNTYPE/NAME defaults applied", () => {
    const minimal = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>111</ACCTID></BANKACCTFROM>
<LEDGERBAL><BALAMT>10.00</BALAMT><DTASOF>20260101</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const [s] = parseOfxStatements(minimal);
    expect(s!.transactions).toEqual([]);
    expect(s!.rangeStart).toBeNull();
    expect(s!.rangeEnd).toBeNull();
  });

  test("OFX whose body is bare text fails loudly", () => {
    expect(() => parseOfxStatements("<OFX>garbage</OFX>")).toThrow(/Empty OFX body/);
  });

  test("degenerate message sets and text-leaf BANKTRANLIST are tolerated", () => {
    const franken = `<OFX>
<BANKMSGSRSV1>oops</BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>9</ACCTID></CCACCTFROM>
<BANKTRANLIST>none</BANKTRANLIST>
<LEDGERBAL><BALAMT>1.00</BALAMT><DTASOF>20260101</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const [s] = parseOfxStatements(franken);
    expect(s!.kind).toBe("creditcard");
    expect(s!.transactions).toEqual([]);
  });

  test("message set without TRNRS children and txn list without STMTTRN children", () => {
    const sparse = `<OFX>
<BANKMSGSRSV1><FOO>x</FOO></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>9</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20260101</DTSTART><DTEND>20260131</DTEND></BANKTRANLIST>
<LEDGERBAL><BALAMT>1.00</BALAMT><DTASOF>20260131</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const [s] = parseOfxStatements(sparse);
    expect(s!.transactions).toEqual([]);
    expect(s!.rangeStart).toBe("2026-01-01");
  });

  test("TRNRS without a statement body is skipped; defaults fill sparse STMTTRN", () => {
    const sparse = `<OFX><BANKMSGSRSV1>
<STMTTRNRS><TRNUID>1</TRNUID></STMTTRNRS>
<STMTTRNRS><STMTRS>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260102</DTPOSTED><TRNAMT>5.00</TRNAMT></STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS>
</BANKMSGSRSV1></OFX>`;
    const statements = parseOfxStatements(sparse);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.accountId).toBeNull();
    expect(statements[0]!.transactions[0]).toEqual({
      type: "OTHER",
      postedOn: "2026-01-02",
      amountCents: 500,
      fitid: null,
      name: "",
      memo: null,
    });
    expect(statements[0]!.ledgerBalanceCents).toBeNull();
  });
});
