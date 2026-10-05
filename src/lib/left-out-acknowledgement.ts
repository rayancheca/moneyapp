import { createHash } from "node:crypto";
import { lineLeftOutNotice, type LineLeftOutFacts } from "./import-file-label";
import { formatCentsSigned } from "./money";

/**
 * ACKNOWLEDGING a line left out — the rule every reader asks: which acknowledgement covers which line.
 *
 * ⚖️ Owner, 2026-10-02 (§6A 30): a line a re-read leaves out (`linesLeftOut`) failed `pnpm ledger-check`, so the
 * pre-commit hook blocked every commit until a parser fix or a re-upload. He chose to allow an acknowledgement: after a
 * session reads the line on the statement, it records it acknowledged — the witness floor's guarded step, a dry run
 * then `--confirm` — kept in the ledger (`left_out_acknowledgements`), never a committed file. The check keeps NAMING an
 * acknowledged line, with the day, and stops failing on it; /imports and the upload outcome say the day too, since they
 * read the same `LineLeftOut`. A line nobody acknowledged still fails.
 *
 * ⛔ An acknowledgement must never hide a line it was not given for:
 *
 *  - it is keyed by what the line IS — its account, day, money, printed words and the printing file's sha256 — never by
 *    the retired row's id, which a later re-read replaces, nor by the printing file's id, which a re-read of it does;
 *  - it covers ONE line: two lines alike take one acknowledgement each, so acknowledging one of a statement's two
 *    identical charges leaves the other failing;
 *  - it covers only a leaving that was there when it was recorded: a line whose row was written after it — written
 *    again by a version, then left out again by a later one — is a new leaving, and fails until it is read again.
 */

/** How one file prints a line left out: what an acknowledgement is keyed by. */
export interface Printing {
  /** the sha256 of the file's bytes */
  readonly sha256: string;
  readonly printedOn: string;
  /** the words it prints, as `printed_lines` keeps them */
  readonly words: string;
}

/** A line left out as this rule reads it — `LineLeftOut` (services/import/lines-left-out.ts) is one. */
export interface AcknowledgeableLine extends LineLeftOutFacts {
  readonly accountId: string;
  /** the retired row that recorded it — how a reader is told which line an acknowledgement covers, never a key */
  readonly rowId: string;
  /** the moment that row was written */
  readonly rowWrittenAt: string;
  /** how each file in `printedBy` prints it, in its order: the first is the one whose day the notice shows */
  readonly printings: readonly Printing[];
}

/** What of a line this rule matches an acknowledgement by — a line before anyone asked whether it is acknowledged. */
export type KeyedLine = Pick<AcknowledgeableLine, "accountId" | "amountCents" | "rowId" | "rowWrittenAt" | "printings">;

/** An acknowledgement as the ledger keeps it (`left_out_acknowledgements`). */
export interface LeftOutAcknowledgement {
  readonly id: string;
  readonly accountId: string;
  readonly printedOn: string;
  readonly amountCents: number;
  readonly printedWords: string;
  readonly printerSha256: string;
  readonly description: string;
  readonly acknowledgedOn: string;
  readonly createdAt: string;
}

export type LeftOutAcknowledgementWrite = Omit<LeftOutAcknowledgement, "id" | "createdAt">;

/** The mark ledger-check prints beside a line, and `--acknowledge-left-out=<mark>` takes. */
export const LEFT_OUT_TOKEN = /^[0-9a-f]{10}$/;

/** What an acknowledgement of `line` is keyed by: its first printer's printing of it. */
function keyOf(line: KeyedLine): Omit<LeftOutAcknowledgementWrite, "description" | "acknowledgedOn"> {
  const first = line.printings[0]!;
  return {
    accountId: line.accountId,
    printedOn: first.printedOn,
    amountCents: line.amountCents,
    printedWords: first.words,
    printerSha256: first.sha256,
  };
}

/**
 * The line's mark: ten hex digits of the sha256 of what an acknowledgement is keyed by — the same every run for the
 * same line, and the same for two lines alike. Length-prefixed, like `dedupeHash`: words cannot forge a field boundary.
 */
export function leftOutToken(line: KeyedLine): string {
  const key = keyOf(line);
  const fields = [key.accountId, key.printedOn, String(key.amountCents), key.printedWords, key.printerSha256];
  return createHash("sha256")
    .update(fields.map((f) => `${f.length}:${f}`).join("\x1f"))
    .digest("hex")
    .slice(0, 10);
}

/** Whether `ack` was given for `line`: the same line, printed so by a file it is printed by, and left out before it. */
function covers(ack: LeftOutAcknowledgement, line: KeyedLine): boolean {
  return (
    ack.accountId === line.accountId &&
    ack.amountCents === line.amountCents &&
    line.printings.some((p) => p.sha256 === ack.printerSha256 && p.printedOn === ack.printedOn && p.words === ack.printedWords) &&
    // a row written in the same millisecond is a later leaving: when in doubt, the line fails
    line.rowWrittenAt < ack.createdAt
  );
}

/**
 * Which acknowledgement covers each line, by its row (`rowId`) — each one line at most, the oldest first — and the
 * acknowledgements no line left out matches now: they hide nothing, and ledger-check names them.
 */
export function acknowledgementsOf(
  lines: readonly KeyedLine[],
  acks: readonly LeftOutAcknowledgement[],
): { byRow: Map<string, LeftOutAcknowledgement>; unmatched: LeftOutAcknowledgement[] } {
  const free = [...acks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byRow = new Map<string, LeftOutAcknowledgement>();
  for (const line of lines) {
    const i = free.findIndex((ack) => covers(ack, line));
    if (i === -1) continue;
    byRow.set(line.rowId, free[i]!);
    free.splice(i, 1);
  }
  return { byRow, unmatched: free };
}

/**
 * What `--acknowledge-left-out=<marks>` would write: one acknowledgement for each line nobody acknowledged that carries
 * one of the marks — every line alike, when several do. A line acknowledged already is said and not written again; a
 * mark no line carries is `unmatched`, and the command refuses the whole write for it.
 */
export function planAcknowledging(
  lines: readonly AcknowledgeableLine[],
  tokens: readonly string[],
  today: string,
): { writes: LeftOutAcknowledgementWrite[]; lines: string[]; unmatched: string[] } {
  const writes: LeftOutAcknowledgementWrite[] = [];
  const said: string[] = [];
  const unmatched: string[] = [];
  for (const token of tokens) {
    const marked = lines.filter((line) => leftOutToken(line) === token);
    const open = marked.filter((line) => line.acknowledgedOn === null);
    if (marked.length === 0) {
      unmatched.push(token);
      said.push(`${token}: no line left out carries this mark — the ledger moved, or it was mistyped`);
    } else if (open.length === 0) {
      said.push(`${token}: acknowledged on ${marked[0]!.acknowledgedOn} already — nothing to write`);
    } else {
      const alike = open.length === 1 ? "" : `${open.length} lines alike — `;
      said.push(`${token}: acknowledges ${alike}${lineLeftOutNotice(open[0]!)}`);
      writes.push(...open.map((line) => ({ ...keyOf(line), description: line.description, acknowledgedOn: today })));
    }
  }
  return { writes, lines: said, unmatched };
}

/** The sentence ledger-check names an acknowledgement matching no line left out by. */
export function unmatchedAcknowledgementNotice(ack: LeftOutAcknowledgement, accountName: string): string {
  return (
    `Acknowledged on ${ack.acknowledgedOn}: ${formatCentsSigned(ack.amountCents)} on ${ack.printedOn}, ${ack.description}, ` +
    `on ${accountName} — no line left out matches it now, so it hides nothing.`
  );
}
