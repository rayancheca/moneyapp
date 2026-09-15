/**
 * Moves ONE imported ledger row onto the day its statement prints — the testable half of
 * `redate-sapphire-0630-payment-2026-09-15.ts`.
 *
 * A ledger row's amount, day and description are immutable (src/db/schema/transactions.ts), and
 * `editManualTransaction` refuses any row with a file. The app changes an imported row's day one way only, the
 * re-parse lifecycle: the row is superseded, the statement's line is inserted fresh under the identity
 * `storedLines` gives it, and the row's work is carried onto that successor. This does that job for one row,
 * without re-parsing the file (which would rewrite every other row it holds):
 *
 *  - the successor's IDENTITY columns — posted and transaction day, raw and normalized description, occurrence
 *    index, dedupe hash — are the printed line's, exactly as `insertTxn` writes a stored line. The hash covers the
 *    raw description, so a hash the parser produces for the line requires the line's own text;
 *  - EVERY OTHER column is the retired row's, `created_at` included, read from `PRAGMA table_info` rather than
 *    from this checkout's schema, so a column a later migration adds travels too. Unlike a re-parse nothing is
 *    re-derived: category, its source and confidence, merchant, review flag, series, transfer link, file;
 *  - the retired row keeps its day, amount and text as history, becomes `superseded`, releases its transfer link
 *    (no superseded row in the ledger holds one) and names its successor in a note.
 *
 * `classifyRedate` accepts exactly two states — the measured one, and the one `applyRedate` leaves — and refuses
 * everything else by naming what differs.
 */
import type { DbBundle } from "@/db/client";
import { uuidv7 } from "@/lib/ids";
import { normalizeDescription } from "@/lib/normalize";
import type { StoredLine } from "@/services/import/service";

export class Refusal extends Error {}

/** The row as measured, and the day its statement prints it. */
export interface RedateSpec {
  rowId: string;
  accountId: string;
  importFileId: string;
  postedOn: string;
  printedOn: string;
  amountCents: number;
  /** the group the row holds; its one other live leg must be another account's opposite amount */
  transferGroupId: string | null;
  notes: string | null;
  /** appended to the retired row's notes */
  retireNote: (successorId: string) => string;
}

export type RedateState = { kind: "pending" } | { kind: "applied"; successorId: string };

type Row = Record<string, unknown>;
type Identity = Record<(typeof IDENTITY_COLUMNS)[number], string | number | null>;

/** The columns the successor takes from the printed line. */
export const IDENTITY_COLUMNS = [
  "posted_on",
  "transacted_on",
  "raw_description",
  "normalized_description",
  "occurrence_index",
  "dedupe_hash",
] as const;

/** What a line is stored as — the columns `insertTxn` derives from a stored line. */
export function identityOf(line: StoredLine): Identity {
  return {
    posted_on: line.stored.postedOn,
    transacted_on: line.stored.transactedOn ?? null,
    raw_description: line.stored.rawDescription,
    normalized_description: normalizeDescription(line.stored.rawDescription),
    occurrence_index: line.occurrenceIndex,
    dedupe_hash: line.hash,
  };
}

/** The ONE printed line recording this money on this day, and only if the ledger stores it on that day. */
export function lineFor(lines: readonly StoredLine[], target: Pick<RedateSpec, "printedOn" | "amountCents">): StoredLine {
  const hits = lines.filter((l) => l.printed.postedOn === target.printedOn && l.printed.amountCents === target.amountCents);
  if (hits.length !== 1) {
    throw new Refusal(`${hits.length} printed lines on ${target.printedOn} for ${target.amountCents} cents — a re-date needs exactly one`);
  }
  const line = hits[0]!;
  // the owner decided the PRINTED day; a line the import places on its period's opening day is another question
  if (line.stored.postedOn !== target.printedOn) {
    throw new Refusal(`the statement prints ${target.printedOn} but the import stores it on ${line.stored.postedOn}`);
  }
  return line;
}

export function joinNote(notes: string | null, addition: string): string {
  return notes ? `${notes} · ${addition}` : addition;
}

function mismatches(row: Row, expected: Row): string[] {
  return Object.entries(expected)
    .filter(([column, value]) => row[column] !== value)
    .map(([column, value]) => `${column} is ${String(row[column])}, expected ${String(value)}`);
}

/** Rows of other tables that name this transaction by foreign key — work a supersede would strand on it. */
function referencesTo(sqlite: DbBundle["sqlite"], id: string): string[] {
  const keys = sqlite
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'transactions'`,
    )
    .all() as { tbl: string; col: string }[];
  return keys.flatMap(({ tbl, col }) => {
    const { n } = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${tbl}" WHERE "${col}" = ?`).get(id) as { n: number };
    return n === 0 ? [] : [`${tbl}.${col} holds ${n} row(s) naming ${id}`];
  });
}

/** The leg holds the group with exactly one other live leg: another account's opposite amount. */
function partnerProblems(sqlite: DbBundle["sqlite"], spec: RedateSpec, legId: string): string[] {
  if (spec.transferGroupId === null) return [];
  const others = sqlite
    .prepare("SELECT id, account_id, amount_cents FROM transactions WHERE transfer_group_id = ? AND status != 'superseded' AND id != ?")
    .all(spec.transferGroupId, legId) as { id: string; account_id: string; amount_cents: number }[];
  const [partner] = others;
  if (others.length !== 1 || partner!.account_id === spec.accountId || partner!.amount_cents !== -spec.amountCents) {
    return [`group ${spec.transferGroupId} holds ${JSON.stringify(others)} beside ${legId}, not one opposite leg in another account`];
  }
  return [];
}

/** Both days inside the one period the row's file prints for its account, so no period's membership changes. */
function periodProblems(sqlite: DbBundle["sqlite"], spec: RedateSpec): string[] {
  const periods = sqlite
    .prepare("SELECT period_start s, period_end e FROM statement_periods WHERE import_file_id = ? AND account_id = ?")
    .all(spec.importFileId, spec.accountId) as { s: string; e: string }[];
  const holds = (day: string) => periods.length === 1 && periods[0]!.s <= day && day <= periods[0]!.e;
  return holds(spec.postedOn) && holds(spec.printedOn)
    ? []
    : [`${spec.importFileId} prints ${JSON.stringify(periods)} for the account, not one period holding ${spec.postedOn} and ${spec.printedOn}`];
}

/** Every successor column: the line's identity, a new id, the measured link and note, the rest the retired row's. */
function successorProblems(retired: Row, successor: Row, identity: Identity, spec: RedateSpec): string[] {
  const expected: Row = {
    ...Object.fromEntries(Object.keys(successor).map((column) => [column, retired[column]])),
    ...identity,
    status: "active",
    transfer_group_id: spec.transferGroupId,
    notes: spec.notes,
  };
  const { id: _id, updated_at: _updatedAt, ...carried } = expected;
  return [
    ...mismatches(successor, carried).map((m) => `successor ${m}`),
    ...(successor.id === retired.id ? ["the successor is the retired row"] : []),
  ];
}

export function classifyRedate({ sqlite }: DbBundle, spec: RedateSpec, line: StoredLine): RedateState {
  const identity = identityOf(line);
  const row = sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(spec.rowId) as Row | undefined;
  if (row === undefined) throw new Refusal(`${spec.rowId}: no such transaction`);
  const refuse = (state: string, problems: string[]): never => {
    throw new Refusal(`REFUSED — ${spec.rowId} is ${state}, neither measured nor re-dated:\n  ${problems.join("\n  ")}`);
  };
  const shape = mismatches(row, {
    account_id: spec.accountId,
    import_file_id: spec.importFileId,
    posted_on: spec.postedOn,
    amount_cents: spec.amountCents,
  });
  if (shape.length > 0) refuse(String(row.status), shape);
  const holders = sqlite
    .prepare("SELECT * FROM transactions WHERE account_id = ? AND dedupe_hash = ? AND status != 'superseded'")
    .all(spec.accountId, identity.dedupe_hash) as Row[];

  if (row.status === "active") {
    const problems = [
      ...mismatches(row, { transfer_group_id: spec.transferGroupId, notes: spec.notes }),
      ...(holders.length > 0 ? [`${holders.length} live row(s) already hold the line's dedupe_hash`] : []),
      ...referencesTo(sqlite, spec.rowId),
      ...partnerProblems(sqlite, spec, spec.rowId),
      ...periodProblems(sqlite, spec),
    ];
    return problems.length > 0 ? refuse("active", problems) : { kind: "pending" };
  }
  if (row.status === "superseded" && holders.length === 1) {
    const successor = holders[0]!;
    const successorId = String(successor.id);
    const problems = [
      ...mismatches(row, { transfer_group_id: null, notes: joinNote(spec.notes, spec.retireNote(successorId)) }),
      ...successorProblems(row, successor, identity, spec),
      ...partnerProblems(sqlite, spec, successorId),
    ];
    return problems.length > 0 ? refuse("superseded", problems) : { kind: "applied", successorId };
  }
  return refuse(String(row.status), [`${holders.length} live row(s) hold the line's dedupe_hash`]);
}

/**
 * The write, in ONE transaction: refuses unless the ledger is exactly in the measured state, retires the row,
 * inserts its successor. Returns the successor's id. Rebuilding balances is the caller's — with the day it runs.
 */
export function applyRedate({ sqlite, db }: DbBundle, spec: RedateSpec, line: StoredLine, now: string = new Date().toISOString()): string {
  const successorId = uuidv7();
  sqlite.transaction(() => {
    const state = classifyRedate({ sqlite, db }, spec, line);
    if (state.kind !== "pending") throw new Refusal(`refusing to retire ${spec.rowId}: already re-dated, successor ${state.successorId}`);
    const retired = sqlite.prepare("SELECT * FROM transactions WHERE id = ?").get(spec.rowId) as Row;
    const retire = sqlite
      .prepare(
        `UPDATE transactions SET status = 'superseded', transfer_group_id = NULL, notes = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND posted_on = ? AND amount_cents = ?`,
      )
      .run(joinNote(spec.notes, spec.retireNote(successorId)), now, spec.rowId, spec.postedOn, spec.amountCents);
    if (retire.changes !== 1) throw new Error(`retire ${spec.rowId}: changed ${retire.changes} rows`);

    const columns = (sqlite.prepare("PRAGMA table_info(transactions)").all() as { name: string }[]).map((c) => c.name);
    const values: Row = { ...retired, ...identityOf(line), id: successorId, updated_at: now };
    const insert = sqlite
      .prepare(`INSERT INTO transactions (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((c) => values[c]));
    if (insert.changes !== 1) throw new Error(`insert successor of ${spec.rowId}: changed ${insert.changes} rows`);
  })();
  return successorId;
}
