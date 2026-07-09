import { getDocumentProxy } from "unpdf";
import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { ParseError, type CanonicalTxn, type ParsedStatement, type ParserProfile, type SniffedFile } from "../types";

/**
 * Deterministic PDF statement parser: unpdf positional text → y-clustered
 * lines → labeled balances + date-anchored activity rows. Institution
 * semantics (credit statements print charges positive; deposit statements
 * carry a balance column) are normalized here. Statement listings are NOT
 * checksummed against printed totals on purpose — reconciliation is the
 * trust layer, and a statement whose rows don't sum must surface as a
 * quarantined gap, not a parse failure.
 */

interface Line {
  y: number;
  text: string;
  tokens: { str: string; x: number }[];
}

async function extractLines(buffer: Buffer): Promise<Line[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const lines: Line[] = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const byY = new Map<number, { str: string; x: number }[]>();
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const y = Math.round(item.transform[5] as number);
      const x = item.transform[4] as number;
      const bucket = byY.get(y) ?? byY.set(y, []).get(y)!;
      bucket.push({ str: item.str.trim(), x });
    }
    const pageLines = [...byY.entries()]
      .sort(([a], [b]) => b - a) // top of page first
      .map(([y, tokens]) => {
        const sorted = [...tokens].sort((a, b) => a.x - b.x);
        return { y: pageNo * 10_000 - y, text: sorted.map((t) => t.str).join(" "), tokens: sorted };
      });
    lines.push(...pageLines);
  }
  return lines;
}

const PERIOD_RE = /Statement Period:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/;
const DATE_TOKEN_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function mdyToIso(profileId: string, mm: string, dd: string, yyyy: string): string {
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!isValidIsoDate(iso)) throw new ParseError(profileId, `Invalid date ${mm}/${dd}/${yyyy}`);
  return iso;
}

function labeledAmount(lines: Line[], label: string): number | null {
  for (const line of lines) {
    if (!line.text.startsWith(label)) continue;
    const amountToken = line.tokens.at(-1)?.str ?? "";
    if (/^-?\$[\d,]+\.\d{2}$/.test(amountToken)) return parseAmountToCents(amountToken);
  }
  return null;
}

interface Section {
  hintName?: string;
  hintLast4?: string;
  lines: Line[];
}

/** Activity rows: date-anchored lines; trailing money tokens are amount (+ balance). */
function parseActivityRows(profileId: string, lines: Line[], flipSign: boolean): CanonicalTxn[] {
  const txns: CanonicalTxn[] = [];
  for (const line of lines) {
    const first = line.tokens[0]?.str ?? "";
    const dateMatch = DATE_TOKEN_RE.exec(first);
    if (!dateMatch) continue;
    // amounts live in the right-hand columns — a $-amount INSIDE a
    // description (x < 350) must never be mistaken for the row amount
    const moneyTokens = line.tokens.filter((t) => /^-?\$[\d,]+\.\d{2}$/.test(t.str) && t.x >= 350);
    if (moneyTokens.length === 0) continue;
    // deposit tables have [amount, balance]; credit/investment just [amount]
    const amountToken = moneyTokens.length >= 2 ? moneyTokens.at(-2)! : moneyTokens.at(-1)!;
    const descTokens = line.tokens.filter(
      (t) => t !== line.tokens[0] && !moneyTokens.includes(t),
    );
    const amount = parseAmountToCents(amountToken.str);
    txns.push({
      postedOn: mdyToIso(profileId, dateMatch[1]!, dateMatch[2]!, dateMatch[3]!),
      amountCents: flipSign ? -amount : amount,
      rawDescription: descTokens.map((t) => t.str).join(" "),
    });
  }
  return txns;
}

export const statementPdf: ParserProfile = {
  id: "statement-pdf",
  version: 1,
  matches: (f) => f.format === "pdf",
  parse: async (f: SniffedFile): Promise<ParsedStatement[]> => {
    const id = "statement-pdf";
    const lines = await extractLines(f.buffer);
    if (lines.length === 0) throw new ParseError(id, "No extractable text — scanned PDF?");
    const headText = lines
      .slice(0, 6)
      .map((l) => l.text)
      .join(" ");

    const institution = /CHASE/i.test(headText)
      ? ("Chase" as const)
      : /DISCOVER/i.test(headText)
        ? ("Discover" as const)
        : /CAPITAL ONE/i.test(headText)
          ? ("Capital One" as const)
          : /SOFI/i.test(headText)
            ? ("SoFi" as const)
            : /ROBINHOOD/i.test(headText)
              ? ("Robinhood" as const)
              : null;
    if (!institution) throw new ParseError(id, `Unknown institution in header: "${headText}"`);

    const periodLine = lines.find((l) => PERIOD_RE.test(l.text));
    const pm = periodLine ? PERIOD_RE.exec(periodLine.text) : null;
    if (!pm) throw new ParseError(id, "No statement period found");
    const periodStart = mdyToIso(id, pm[1]!, pm[2]!, pm[3]!);
    const periodEnd = mdyToIso(id, pm[4]!, pm[5]!, pm[6]!);

    // SoFi combined statements carry one section per account
    const isSofiCombined = institution === "SoFi" && /Checking & Savings/i.test(headText);
    const sections: Section[] = [];
    if (isSofiCombined) {
      let current: Section | null = null;
      for (const line of lines) {
        const m = /^(SoFi (?:Checking|Savings)) \*{4}(\d{4})$/.exec(line.text);
        if (m) {
          current = { hintName: m[1], hintLast4: m[2], lines: [] };
          sections.push(current);
        } else if (current) {
          current.lines.push(line);
        }
      }
      if (sections.length === 0) throw new ParseError(id, "SoFi combined statement had no sections");
    } else {
      const acctLine = lines.find((l) => /^Account: .+ \*{4}\d{4}$/.test(l.text));
      const am = acctLine ? /^Account: (.+) \*{4}(\d{4})$/.exec(acctLine.text) : null;
      sections.push({ hintName: am?.[1], hintLast4: am?.[2], lines });
    }

    return sections.map((section) => {
      const isInvestment = institution === "Robinhood";
      const isCredit =
        labeledAmount(section.lines, "Previous Balance") !== null ||
        labeledAmount(section.lines, "New Balance") !== null;

      const begin = isInvestment
        ? labeledAmount(section.lines, "Beginning Portfolio Value")
        : isCredit
          ? labeledAmount(section.lines, "Previous Balance")
          : labeledAmount(section.lines, "Beginning Balance");
      const end = isInvestment
        ? labeledAmount(section.lines, "Ending Portfolio Value")
        : isCredit
          ? labeledAmount(section.lines, "New Balance")
          : labeledAmount(section.lines, "Ending Balance");
      if (begin === null || end === null) {
        throw new ParseError(id, `Missing printed balances (${institution})`);
      }

      // holdings rows in Robinhood statements are not activity — cut everything
      // between the Holdings header and Account Activity
      let activityLines = section.lines;
      if (isInvestment) {
        const activityStart = section.lines.findIndex((l) => l.text === "Account Activity");
        activityLines = activityStart === -1 ? [] : section.lines.slice(activityStart);
      }

      const txns = parseActivityRows(id, activityLines, isCredit);
      const type = isInvestment
        ? ("investment" as const)
        : isCredit
          ? ("credit" as const)
          : /savings/i.test(section.hintName ?? "")
            ? ("savings" as const)
            : ("checking" as const);

      return {
        accountHint: {
          institution,
          last4: section.hintLast4,
          type,
          subtype: isInvestment ? ("brokerage" as const) : undefined,
          name: section.hintName,
        },
        txns,
        period: {
          start: periodStart,
          end: periodEnd,
          // credit statements print positive owed → net-worth negative
          beginCents: isCredit ? -begin : begin,
          endCents: isCredit ? -end : end,
        },
      };
    });
  },
};
