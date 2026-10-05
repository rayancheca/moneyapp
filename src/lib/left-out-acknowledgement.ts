import { createHash } from "node:crypto";
import { augment, type Matching } from "@/services/import/printed-lines";
import { acknowledgedSentence, lineLeftOutNotice, type Acknowledged, type LineLeftOutFacts } from "./import-file-label";
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
 * ⛔ Never without a reason — "an entry without a reason is a check that has been quieted rather than passed" (ledger-
 * check's BASELINE). `--confirm` is refused without `--reason='<what the statement shows>'`; the reason is stored with
 * the acknowledgement and printed with the line wherever it is printed: "Acknowledged on <day>: <reason>."
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
  /** what the session read on the statement — never empty */
  readonly reason: string;
  readonly createdAt: string;
}

export type LeftOutAcknowledgementWrite = Omit<LeftOutAcknowledgement, "id" | "createdAt">;

/** An acknowledgement as its line carries it (`LineLeftOutFacts.acknowledged`): the day, and what the session read. */
export function acknowledgedOf(ack: LeftOutAcknowledgement): Acknowledged {
  return { on: ack.acknowledgedOn, reason: ack.reason };
}

/** The mark ledger-check prints beside a line, and `--acknowledge-left-out=<mark>` takes. */
export const LEFT_OUT_TOKEN = /^[0-9a-f]{10}$/;

/** What an acknowledgement of `line` is keyed by: its first printer's printing of it. */
function keyOf(line: KeyedLine): Omit<LeftOutAcknowledgementWrite, "description" | "acknowledgedOn" | "reason"> {
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

/** Whether `ack` is keyed as `line`'s own mark keys it — the acknowledgement `acknowledgementWrites` writes for it. */
function isOwn(ack: LeftOutAcknowledgement, line: KeyedLine): boolean {
  const key = keyOf(line);
  return ack.printedOn === key.printedOn && ack.printedWords === key.printedWords && ack.printerSha256 === key.printerSha256;
}

/**
 * Which acknowledgement covers each line, by its row (`rowId`) — each one line at most — and the acknowledgements no
 * line left out matches now: they hide nothing, and ledger-check names them.
 *
 * 🔴 Each line took the oldest acknowledgement covering it. An acknowledgement covers a line any of its printers prints
 * alike, so a line printed by two files took the one given for a line only the second prints: that line failed, though
 * acknowledged, and the first's own was named as matching nothing (probe at ec80c93). Now as many lines as can be are
 * covered (Kuhn, `augment`), each by its OWN acknowledgement first — the one its mark wrote — and only then by one
 * keyed under another of its printers: the line a session read and acknowledged is the line that stops failing. A line
 * takes the oldest free one it can, and moves another line's only when none is free.
 */
export function acknowledgementsOf(
  lines: readonly KeyedLine[],
  acks: readonly LeftOutAcknowledgement[],
): { byRow: Map<string, LeftOutAcknowledgement>; unmatched: LeftOutAcknowledgement[] } {
  const oldestFirst = [...acks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const all = lines.map((line) => oldestFirst.filter((ack) => covers(ack, line)));
  const own = lines.map((line, i) => all[i]!.filter((ack) => isOwn(ack, line)));
  const m: Matching = { lineOf: new Map(), rowOf: new Map() };
  const place = (i: number, candidates: readonly LeftOutAcknowledgement[][]): void => {
    const free = candidates[i]!.find((ack) => !m.lineOf.has(ack.id));
    if (free === undefined) {
      augment(i, candidates, () => true, m, new Set());
      return;
    }
    m.lineOf.set(free.id, i);
    m.rowOf.set(i, free.id);
  };
  for (let i = 0; i < lines.length; i++) place(i, own);
  // a line keeps an acknowledgement once it has one: moving it to another never leaves it uncovered
  for (let i = 0; i < lines.length; i++) if (!m.rowOf.has(i)) place(i, all);
  const byId = new Map(acks.map((ack) => [ack.id, ack] as const));
  const inLineOrder = [...m.rowOf].sort(([a], [b]) => a - b);
  const byRow = new Map(inLineOrder.map(([i, id]) => [lines[i]!.rowId, byId.get(id)!] as const));
  return { byRow, unmatched: oldestFirst.filter((ack) => !m.lineOf.has(ack.id)) };
}

/** What `--acknowledge-left-out=<marks>` would do — the dry run's answer, and what `--confirm` writes. */
export interface AcknowledgingPlan {
  /** each line nobody acknowledged that carries one of the marks — every line alike, when several do: one write each */
  readonly open: AcknowledgeableLine[];
  /** what the run says, mark by mark */
  readonly lines: string[];
  /** the marks no line left out carries: the command refuses the whole write for any */
  readonly unmatched: string[];
}

/**
 * What `--acknowledge-left-out=<marks>` would write: one acknowledgement for each line nobody acknowledged that carries
 * one of the marks — every line alike, when several do. A line acknowledged already is said, with what was read then,
 * and not written again; a mark no line carries is `unmatched`, and the command refuses the whole write for it.
 *
 * ⛔ It says what it would STORE — "Acknowledged on <day>: <reason>.", the sentence printed with the line from then on —
 * or, with no reason given, that `--confirm` needs one (`ledgerCheckMode` refuses it without).
 */
export function planAcknowledging(
  lines: readonly AcknowledgeableLine[],
  tokens: readonly string[],
  acknowledging: { readonly on: string; readonly reason: string | null },
): AcknowledgingPlan {
  const open: AcknowledgeableLine[] = [];
  const said: string[] = [];
  const unmatched: string[] = [];
  for (const token of tokens) {
    const marked = lines.filter((line) => leftOutToken(line) === token);
    const unacknowledged = marked.filter((line) => line.acknowledged === null);
    if (marked.length === 0) {
      unmatched.push(token);
      said.push(`${token}: no line left out carries this mark — the ledger moved, or it was mistyped`);
    } else if (unacknowledged.length === 0) {
      said.push(`${token}: acknowledged already, nothing to write — ${acknowledgedSentence(marked[0]!.acknowledged!)}`);
    } else {
      const alike = unacknowledged.length === 1 ? "" : `${unacknowledged.length} lines alike — `;
      const { on, reason } = acknowledging;
      const stores =
        reason === null
          ? "stores no reason yet — --confirm needs --reason='<what the statement shows>', printed with the line from then on"
          : `stores, printed with the line from now on — ${acknowledgedSentence({ on, reason })}`;
      said.push(`${token}: acknowledges ${alike}${lineLeftOutNotice(unacknowledged[0]!)}`, `${token}: ${stores}`);
      open.push(...unacknowledged);
    }
  }
  return { open, lines: said, unmatched };
}

/** The rows `--confirm` writes for a plan's `open` lines: each keyed by its first printer, with the day and the reason. */
export function acknowledgementWrites(open: readonly AcknowledgeableLine[], { on, reason }: Acknowledged): LeftOutAcknowledgementWrite[] {
  return open.map((line) => ({ ...keyOf(line), description: line.description, acknowledgedOn: on, reason }));
}

/** The sentence ledger-check names an acknowledgement matching no line left out by — with what the session read. */
export function unmatchedAcknowledgementNotice(ack: LeftOutAcknowledgement, accountName: string): string {
  return (
    `${formatCentsSigned(ack.amountCents)} on ${ack.printedOn}, ${ack.description}, on ${accountName} — no line left out ` +
    `matches it now, so it hides nothing. ${acknowledgedSentence(acknowledgedOf(ack))}`
  );
}
