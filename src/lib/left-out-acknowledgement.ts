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
 * the acknowledgement and printed with the line wherever it is printed: "Acknowledged on <day>: <reason>", the reason
 * exactly as given. A later run never changes it: another `--reason` for a line acknowledged already is refused, and
 * so is one for a line alike one — lines alike share a mark, and one reason: an open line takes the one its lines alike
 * carry, and the dry run names it. A reason of only whitespace and invisible characters says nothing, and is refused
 * (`reasonSaysNothing`); so is one carrying a control character among its words (`reasonCarriesControl`).
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

/** how a printed step asks for what the session read on the statement */
const SAYS = "--reason='<what the statement shows>'";

/**
 * The words a run giving another `--reason` is told in — by its dry run, and by the refusal (`reasonChangeRefusal`) —
 * by how many reasons are stored: lines alike can carry two (`acknowledgementsOf`).
 *
 * 🔴 Beside two stored they said "--reason is not the reason stored, which stays" and "nor gives lines alike two", as if
 * one were stored and the lines alike did not carry two already.
 */
function anotherReason(stored: number): { notStored: string; stays: string; nor: string } {
  return stored === 1
    ? { notStored: "--reason is not the reason stored", stays: "which stays", nor: "nor gives lines alike two" }
    : { notStored: `--reason is not one of the ${stored} reasons stored`, stays: "which stay", nor: "nor gives lines alike another" };
}
const NEVER_CHANGED = "this step never changes a stored one";

/** what a mark's open lines may take when its lines alike carry several reasons — one mark's run, and several marks' */
const TAKE_ONE = "its open lines take one of them, exactly, never another";

/**
 * every character that prints as nothing: Unicode whitespace, the zero-width and other invisible ones, the format
 * characters, the C0 and C1 control characters, and U+2800 BRAILLE PATTERN BLANK
 */
const INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\u2800]/gu;

/**
 * Whether a reason says nothing: nothing is left once every Unicode whitespace character and every invisible one —
 * zero-width spaces and joiners, the byte-order mark, bidi marks, the soft hyphen (`Default_Ignorable_Code_Point`), the
 * format characters (`Cf`), the control characters (`Cc`), the braille blank — is taken out. The command line
 * (`ledgerCheckMode`) and the table's one writer (`writeLeftOutAcknowledgements`) refuse it.
 *
 * 🔴 Both trimmed as `\s` and `trim()` do — Unicode whitespace, no zero-width character — and the table's CHECK
 * (migration 0024, applied to the real ledger: never edited) trims ASCII whitespace only: a reason of one U+200B was
 * stored, and every surface printed "Acknowledged on <day>: " followed by nothing a reader can see. 🔴 Then a control
 * character (a bell, an escape, a C1 one) or U+2800 — neither whitespace nor default-ignorable — still passed. 🔴 Then
 * a format character that is no default-ignorable one: the interlinear annotation marks U+FFF9–FFFB, the Egyptian
 * hieroglyph format controls U+13430–1343F, the Arabic number signs U+0600–0605.
 */
export function reasonSaysNothing(reason: string): boolean {
  return reason.replace(INVISIBLE, "") === "";
}

/**
 * What a reason carrying a control character (`Cc`) anywhere is refused with — "carries a control character, U+001B,
 * that every surface would print raw" — or null when it carries none: ONE phrasing for the command line
 * (`ledgerCheckMode`) and the table's one writer (`writeLeftOutAcknowledgements`), which both refuse it.
 *
 * 🔴 Only a reason of NOTHING but control characters was refused (`reasonSaysNothing`): one with words beside an escape,
 * a bell or a C1 control said something, so it was stored — and printed raw with the line wherever it is printed, an
 * escape a terminal obeys and a page shows as nothing. ⛔ Refused, never taken out: a stored reason is exactly what the
 * session gave, nothing added or dropped (`acknowledgedSentence`). The command line collapses whitespace first, so a tab
 * or a line break there is a space, never this; given to the writer it is this — a stored reason is on one line.
 */
export function reasonCarriesControl(reason: string): string | null {
  const control = /\p{Cc}/u.exec(reason)?.[0];
  if (control === undefined) return null;
  const code = control.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
  return `carries a control character, U+${code}, that every surface would print raw`;
}

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
  /**
   * the marks with lines acknowledged already — all of them, or some — none with the reason given: refused, as
   * `unmatched`, and none of their lines is in `open`
   */
  readonly reasonsKept: ReasonKept[];
  /**
   * each mark with lines in `open` AND lines alike acknowledged already, by the reasons those carry — once each, in the
   * lines' order: its open lines take one of them, exactly (`confirmingStep` names each)
   */
  readonly reasonsStored: ReadonlyMap<string, readonly string[]>;
}

/**
 * A mark with lines acknowledged already — every one, or some with the rest open — given a `--reason` none of them was
 * stored with.
 */
export interface ReasonKept {
  readonly mark: string;
  /** each acknowledgement its lines carry, once each, in the lines' order — what is stored, and stays */
  readonly stored: Acknowledged[];
}

/**
 * What `--acknowledge-left-out=<marks>` would write: one acknowledgement for each line nobody acknowledged that carries
 * one of the marks — every line alike, when several do. A line acknowledged already is said, with what was read then,
 * and not written again; a mark no line carries is `unmatched`, and the command refuses the whole write for it.
 *
 * ⛔ It says what it would STORE — "Acknowledged on <day>: <reason>", the sentence printed with the line from then on —
 * or, with no reason given, that `--confirm` needs one (`ledgerCheckMode` refuses it without).
 *
 * ⛔ This step never changes a stored reason. 🔴 Another `--reason` for a line acknowledged already was dropped: "nothing
 * to acknowledge", exit 0, and the session's words stored nowhere while it believed them stored. Such a mark is
 * `reasonsKept` now, and the command refuses the whole write for it, saying the reason stored (`reasonChangeRefusal`).
 *
 * ⛔ Nor gives lines alike two: they share a mark because they read the same on the statement. 🔴 A mark only PARTLY
 * acknowledged — a line alike acknowledged in an earlier run, another left out since — took another `--reason` for its
 * open line without a word of the one stored, and `--confirm` stored it: one mark, two reasons. Its reasons stored are
 * said now, and another one makes it `reasonsKept` too — refused, exit 2, as for a mark whose every line is acknowledged.
 * 🔴 Its dry run said "acknowledged already, with another reason" beside the reason stored, as if that one were the
 * other: both say now, in the refusal's words, that `--reason` is not the one stored, which stays.
 *
 * ⛔ Another reason is one NONE of its lines carries. 🔴 It was one ANY of them did not: lines alike carrying two —
 * which the matching can give them (`acknowledgementsOf`: a line takes one keyed under another of its printers) —
 * refused every `--reason`, so a line alike left open beside them could never be acknowledged, and ledger-check failed on
 * it for good (review of 9084a9c). Their two are kept — this step never changes a stored reason — and the open line
 * takes either one, never a third; with no reason given, the dry run names them, exactly (`reasonsStored`).
 */
export function planAcknowledging(
  lines: readonly AcknowledgeableLine[],
  tokens: readonly string[],
  acknowledging: { readonly on: string; readonly reason: string | null },
): AcknowledgingPlan {
  const open: AcknowledgeableLine[] = [];
  const said: string[] = [];
  const unmatched: string[] = [];
  const reasonsKept: ReasonKept[] = [];
  const reasonsStored = new Map<string, readonly string[]>();
  const given = acknowledging.reason;
  for (const token of tokens) {
    const marked = lines.filter((line) => leftOutToken(line) === token);
    const unacknowledged = marked.filter((line) => line.acknowledged === null);
    const carried = marked.flatMap((line) => (line.acknowledged === null ? [] : [line.acknowledged]));
    const stored = storedOnce(carried);
    const reasons = [...new Set(stored.map((ack) => ack.reason))];
    const another = given !== null && reasons.length > 0 && !reasons.includes(given);
    const { notStored, stays, nor } = anotherReason(reasons.length);
    if (marked.length === 0) {
      unmatched.push(token);
      said.push(`${token}: no line left out carries this mark — the ledger moved, or it was mistyped`);
    } else if (unacknowledged.length === 0 && !another) {
      for (const ack of stored) said.push(`${token}: acknowledged already, nothing to write — ${acknowledgedSentence(ack)}`);
    } else if (unacknowledged.length === 0) {
      reasonsKept.push({ mark: token, stored });
      for (const ack of stored) {
        said.push(`${token}: acknowledged already, and ${notStored}, ${stays}: ${NEVER_CHANGED} — ${acknowledgedSentence(ack)}`);
      }
    } else {
      // some acknowledged, the rest open: what is stored is said first, with how many lines carry it
      const and = another ? `and ${notStored}, ${stays}: ${NEVER_CHANGED} ${nor}` : "and lines alike take one reason";
      for (const ack of stored) {
        const n = carried.filter((a) => sameAcknowledgement(a, ack)).length;
        said.push(`${token}: ${n} of its ${marked.length} lines alike acknowledged already, ${and} — ${acknowledgedSentence(ack)}`);
      }
      if (another) {
        reasonsKept.push({ mark: token, stored });
        continue;
      }
      if (reasons.length > 0) reasonsStored.set(token, reasons);
      said.push(...acknowledgesSaid(token, unacknowledged, acknowledging, reasons));
      open.push(...unacknowledged);
    }
  }
  return { open, lines: said, unmatched, reasonsKept, reasonsStored };
}

/**
 * What a mark's open lines would be acknowledged as: the line, and the reason it would store — or that it needs one:
 * what the statement shows, or — its lines alike acknowledged already — the reason they carry, exactly (`reasons`).
 */
function acknowledgesSaid(
  token: string,
  unacknowledged: readonly AcknowledgeableLine[],
  { on, reason }: { readonly on: string; readonly reason: string | null },
  reasons: readonly string[],
): string[] {
  const alike = unacknowledged.length === 1 ? "" : `${unacknowledged.length} lines alike — `;
  const carry = reasons.length === 1 ? "the reason its lines alike carry" : "a reason its lines alike carry";
  const needs = reasons.length === 0 ? SAYS : `${carry}, exactly: ${reasons.map(reasonArgument).join(" or ")}`;
  const stores =
    reason === null
      ? `stores no reason yet — --confirm needs ${needs}, printed with the line from then on`
      : `stores, printed with the line from now on — ${acknowledgedSentence({ on, reason })}`;
  return [`${token}: acknowledges ${alike}${lineLeftOutNotice(unacknowledged[0]!)}`, `${token}: ${stores}`];
}

/**
 * `--reason=` with a reason stored, quoted as a shell reads it back whole: single quotes keep every character but the
 * quote itself, which closes them, is escaped, and opens them again. A stored reason is on one line (`ledgerCheckMode`;
 * the writer refuses a line break, `reasonCarriesControl`).
 */
const reasonArgument = (reason: string): string => `--reason='${reason.replace(/'/g, "'\\''")}'`;

const sameAcknowledgement = (a: Acknowledged, b: Acknowledged): boolean => a.on === b.on && a.reason === b.reason;

/** each acknowledgement once — two lines alike acknowledged in one run carry the same — in the order first carried */
function storedOnce(acks: readonly Acknowledged[]): Acknowledged[] {
  return acks.filter((ack, i) => acks.findIndex((a) => sameAcknowledgement(a, ack)) === i);
}

/**
 * What ledger-check refuses a run with when it gives another `--reason` for a mark with a line acknowledged already
 * (`AcknowledgingPlan.reasonsKept`): that this step never changes a stored reason nor gives lines alike two, and each
 * reason stored, by its mark — last on its line, exactly as stored. Worded by how many reasons are stored
 * (`anotherReason`).
 */
export function reasonChangeRefusal(kept: readonly ReasonKept[]): string[] {
  const { notStored, nor } = anotherReason(new Set(kept.flatMap(({ stored }) => stored.map((ack) => ack.reason))).size);
  return [
    `REFUSED: ${notStored}, and ${NEVER_CHANGED} ${nor} — nothing was written. Stored:`,
    ...kept.flatMap(({ mark, stored }) => stored.map((ack) => `  ${mark}: ${acknowledgedSentence(ack)}`)),
  ];
}

/**
 * What a dry run ends with: the run that confirms it, once each line is read on its statement — `tokens` the marks the
 * dry run was given, `plan` what it planned, `reason` its `--reason`.
 *
 * 🔴 It said "the same command with --reason='<what the statement shows>' --confirm" whenever no reason was given, and
 * the command line refuses a reason beside two marks — a reason says what ONE line is (`ledgerCheckMode`): after a dry
 * run of two marks, the step it guided the session to was a refusal, exit 2 (probe on a scratch ledger at 266be8e). Now
 * several marks take one run each, a mark whose lines are all acknowledged already none, and each run names its own.
 * ⛔ Each is "the same command" with other arguments, never a whole command: a dry run pointed at a copy by
 * MONEYAPP_DB_PATH confirms on that copy, never on whatever ledger a pasted `pnpm ledger-check` would open.
 *
 * 🔴 Given only the open lines, it named that placeholder for a mark PARTLY acknowledged too — whose open lines take the
 * reason its lines alike carry, and the plan refuses another: the session's own words, as it invited, were refused, exit
 * 2 (review of 9084a9c). Such a mark's run names the reason stored, exactly (`reasonsStored`).
 *
 * 🔴 Lines alike carrying two reasons take either for a line left open beside them, and the run named only the first:
 * a session whose statement read as the second was never told it is taken. It names each now, exactly — the first on
 * its line, each other on a line "or …" below it, in its place — never a third. 🔴 Under several marks' header, which
 * said only "one run a mark", an "or" line came with no word of why: the header says it now, in one sentence more,
 * whenever a mark has one — in the words one mark's own step uses (`TAKE_ONE`).
 */
export function confirmingStep(
  tokens: readonly string[],
  plan: Pick<AcknowledgingPlan, "open" | "reasonsStored">,
  reason: string | null,
): string[] {
  /** each reason a mark's lines alike carry, as a run gives it — none when nothing alike is acknowledged */
  const says = (mark: string): string[] => (plan.reasonsStored.get(mark) ?? []).map(reasonArgument);
  /** a mark's runs, `run` building one from its reason — the placeholder when none is stored; each other in its place */
  const runsOf = (mark: string, run: (says: string) => string): string[] => {
    const [first = SAYS, ...others] = says(mark);
    return [`    ${run(first)}`, ...others.map((other) => `    or ${run(other)}`)];
  };
  if (tokens.length === 1) {
    const stored = says(tokens[0]!);
    if (reason !== null || stored.length < 2) {
      const adds = reason === null ? `${stored[0] ?? SAYS} ` : "";
      return [`Only once each line is read on its statement: the same command with ${adds}--confirm`];
    }
    return [
      `Only once each line is read on its statement: the same command with one of these — its lines alike carry ` +
        `${stored.length} reasons, and ${TAKE_ONE}:`,
      ...runsOf(tokens[0]!, (said) => `${said} --confirm`),
    ];
  }
  const marks = [...new Set(plan.open.map(leftOutToken))];
  const or = marks.some((mark) => says(mark).length > 1)
    ? `. Where "or" follows a run, that mark's lines alike carry more than one reason, and ${TAKE_ONE}:`
    : ":";
  return [
    "Only once each line is read on its statement, one run a mark — a reason says what ONE line is: the same command " +
      `with these arguments in place of its own${or}`,
    ...marks.flatMap((mark) => runsOf(mark, (said) => `--acknowledge-left-out=${mark} ${said} --confirm`)),
  ];
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
