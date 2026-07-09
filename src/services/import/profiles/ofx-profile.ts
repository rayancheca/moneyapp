import { parseOfxStatements } from "@/lib/ofx";
import { ParseError, type ParsedStatement, type ParserProfile, type SniffedFile } from "../types";

/**
 * Generic OFX/QFX profile — Chase QFX (SGML 1.x) and Capital One OFX
 * (2.0.2 XML) both flow through the tolerant parser in src/lib/ofx.ts.
 * Card LEDGERBAL is reported as positive amount-owed; net-worth sign flip
 * happens here at the boundary.
 */

function institutionFor(file: SniffedFile): "Chase" | "Capital One" {
  // ONLY structural signals (FI block, filename) — transaction descriptions
  // routinely contain other banks' names ("TRANSFER FROM CHASE ...")
  const bodyStart = file.text.search(/<BANKTRANLIST|<STMTTRN/i);
  const head = file.text.slice(0, bodyStart === -1 ? 2_000 : bodyStart);
  if (/<ORG>B1|INTU\.BID/i.test(head) || /^Chase/i.test(file.name)) return "Chase";
  return "Capital One";
}

export const ofxProfile: ParserProfile = {
  id: "ofx-generic",
  version: 1,
  matches: (f) => f.format === "ofx" || f.format === "qfx",
  parse: (f): ParsedStatement[] => {
    const institution = institutionFor(f);
    const statements = parseOfxStatements(f.text);
    return statements.map((s) => {
      const isCard = s.kind === "creditcard";
      const last4 = s.accountId ? s.accountId.replaceAll(/\D/g, "").slice(-4) : undefined;
      if (!last4) throw new ParseError("ofx-generic", "Statement missing ACCTID");
      const acctType = isCard ? "credit" : /SAVINGS/i.test(f.text) ? "savings" : "checking";
      return {
        accountHint: { institution, last4, type: acctType },
        txns: s.transactions.map((t) => ({
          postedOn: t.postedOn,
          amountCents: t.amountCents, // OFX card charges are already negative
          rawDescription: t.memo && t.memo.length >= t.name.length ? t.memo : t.name,
          fitid: t.fitid ?? undefined,
        })),
        declaredRange:
          s.rangeStart !== null && s.rangeEnd !== null
            ? { start: s.rangeStart, end: s.rangeEnd }
            : undefined,
        ledger:
          s.ledgerBalanceCents !== null && s.ledgerBalanceAsOf !== null
            ? {
                // cards report positive owed → net-worth negative
                cents: isCard ? -s.ledgerBalanceCents : s.ledgerBalanceCents,
                asOf: s.ledgerBalanceAsOf,
              }
            : undefined,
      };
    });
  },
};
