/**
 * Tolerant OFX/QFX parser, modeled on Actual Budget's production approach
 * (master-plan §1): handle both OFX 1.x SGML (unclosed leaf tags) and 2.x
 * XML, bare ampersands, INTU.* tags, and the plaintext header block.
 * Deterministic and dependency-free — bank files are untrusted input.
 */

export interface OfxTransaction {
  type: string;
  postedOn: string; // YYYY-MM-DD
  amountCents: number;
  fitid: string | null;
  name: string;
  memo: string | null;
}

export interface OfxStatement {
  kind: "bank" | "creditcard";
  accountId: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  transactions: OfxTransaction[];
  ledgerBalanceCents: number | null;
  ledgerBalanceAsOf: string | null;
}

export class OfxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfxParseError";
  }
}

type OfxNode = { [tag: string]: OfxNode[] | string[] };

/** OFX datetime (YYYYMMDD[HHMMSS[.XXX]][TZ]) → YYYY-MM-DD. */
export function parseOfxDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (!m) throw new OfxParseError(`Bad OFX date: "${raw}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** OFX amount ("-43.64", "1234.5", "+12") → integer cents. */
export function parseOfxAmount(raw: string): number {
  const s = raw.trim().replace(",", "."); // some European exports use comma decimals
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) throw new OfxParseError(`Bad OFX amount: "${raw}"`);
  const cents = Number(m[2] || "0") * 100 + Number(((m[3] ?? "") + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new OfxParseError(`Amount overflow: "${raw}"`);
  return m[1] === "-" ? (cents === 0 ? 0 : -cents) : cents;
}

function decodeEntities(s: string): string {
  return s
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&nbsp;/gi, " ");
}

/** Strips the plaintext OFX 1.x header (`KEY:VALUE` lines) or the 2.x XML prolog. */
function bodyOf(content: string): string {
  const ofxStart = content.search(/<OFX>/i);
  if (ofxStart === -1) throw new OfxParseError("No <OFX> element found");
  return content.slice(ofxStart);
}

/**
 * Parses SGML/XML tag soup into a tree. Leaf tags (text before the next '<')
 * self-close per OFX 1.x; explicit close tags pop to their matching open,
 * synthesizing any missing closes in between.
 */
export function parseOfxTree(content: string): OfxNode {
  const body = bodyOf(content);
  const tagRe = /<(\/?)([A-Za-z0-9._-]+)>([^<]*)/g;
  const root: OfxNode = {};
  const stack: { tag: string; node: OfxNode }[] = [{ tag: "", node: root }];

  const append = (parent: OfxNode, tag: string, value: OfxNode | string) => {
    const list = (parent[tag] ??= []);
    (list as (OfxNode | string)[]).push(value);
  };

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body)) !== null) {
    const isClose = m[1] === "/";
    const tag = m[2]!.toUpperCase();
    // group 3 is [^<]* — it always participates, possibly as ""
    const text = decodeEntities((m[3] as string).trim());

    if (isClose) {
      // pop to the matching open tag, tolerating unclosed intermediates
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (text !== "") {
      append(stack.at(-1)!.node, tag, text); // leaf
    } else {
      const child: OfxNode = {};
      append(stack.at(-1)!.node, tag, child); // aggregate
      stack.push({ tag, node: child });
    }
  }
  /* v8 ignore next 2 — bodyOf guarantees an <OFX> tag reaches the tokenizer */
  if (!root.OFX) throw new OfxParseError("Malformed OFX: no parseable OFX body");
  return root;
}

function first(node: OfxNode | undefined, path: string[]): OfxNode | string | undefined {
  let current: OfxNode | string | undefined = node;
  for (const tag of path) {
    if (current === undefined || typeof current === "string") return undefined;
    current = (current[tag] as (OfxNode | string)[] | undefined)?.[0];
  }
  return current;
}

function firstString(node: OfxNode | undefined, path: string[]): string | null {
  const v = first(node, path);
  return typeof v === "string" ? v : null;
}

/** Extracts every bank/credit-card statement in the file. */
export function parseOfxStatements(content: string): OfxStatement[] {
  const tree = parseOfxTree(content);
  const ofx = first(tree, ["OFX"]);
  if (ofx === undefined || typeof ofx === "string") throw new OfxParseError("Empty OFX body");

  const statements: OfxStatement[] = [];
  const specs = [
    { kind: "bank" as const, msg: "BANKMSGSRSV1", trnrs: "STMTTRNRS", rs: "STMTRS", acct: "BANKACCTFROM" },
    { kind: "creditcard" as const, msg: "CREDITCARDMSGSRSV1", trnrs: "CCSTMTTRNRS", rs: "CCSTMTRS", acct: "CCACCTFROM" },
  ];

  for (const spec of specs) {
    const msgSet = first(ofx, [spec.msg]);
    if (msgSet === undefined || typeof msgSet === "string") continue;
    const trnList = (msgSet[spec.trnrs] as OfxNode[] | undefined) ?? [];
    for (const trn of trnList) {
      const rs = first(trn, [spec.rs]);
      if (rs === undefined || typeof rs === "string") continue;

      const tranList = first(rs, ["BANKTRANLIST"]);
      const stmtTxns =
        tranList !== undefined && typeof tranList !== "string"
          ? ((tranList.STMTTRN as OfxNode[] | undefined) ?? [])
          : [];

      const transactions: OfxTransaction[] = stmtTxns.map((t) => {
        const amountRaw = firstString(t, ["TRNAMT"]);
        const dateRaw = firstString(t, ["DTPOSTED"]);
        if (amountRaw === null || dateRaw === null) {
          throw new OfxParseError("STMTTRN missing TRNAMT or DTPOSTED");
        }
        return {
          type: firstString(t, ["TRNTYPE"]) ?? "OTHER",
          postedOn: parseOfxDate(dateRaw),
          amountCents: parseOfxAmount(amountRaw),
          fitid: firstString(t, ["FITID"]),
          name: firstString(t, ["NAME"]) ?? "",
          memo: firstString(t, ["MEMO"]),
        };
      });

      const ledgerAmt = firstString(rs, ["LEDGERBAL", "BALAMT"]);
      const ledgerAsOf = firstString(rs, ["LEDGERBAL", "DTASOF"]);
      const rangeStart = firstString(rs, ["BANKTRANLIST", "DTSTART"]);
      const rangeEnd = firstString(rs, ["BANKTRANLIST", "DTEND"]);

      statements.push({
        kind: spec.kind,
        accountId: firstString(rs, [spec.acct, "ACCTID"]),
        rangeStart: rangeStart ? parseOfxDate(rangeStart) : null,
        rangeEnd: rangeEnd ? parseOfxDate(rangeEnd) : null,
        transactions,
        ledgerBalanceCents: ledgerAmt !== null ? parseOfxAmount(ledgerAmt) : null,
        ledgerBalanceAsOf: ledgerAsOf ? parseOfxDate(ledgerAsOf) : null,
      });
    }
  }

  if (statements.length === 0) {
    throw new OfxParseError("OFX contained no bank or credit-card statements");
  }
  return statements;
}
