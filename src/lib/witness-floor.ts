import { type LedgerFailure, type LedgerObservation, windowsSpanning } from "./ledger-integrity";

/**
 * A FLOOR under every kind of witness `pnpm ledger-check` counts.
 *
 * WHY THIS EXISTS. The recorded baseline lists only what DISAGREES — breaks,
 * valuations off by more than a cent, money with no document. A witness that
 * AGREES is invisible to it, so removing one changes nothing the baseline can
 * see. Measured on a copy of the owner's ledger (2026-09-15): un-importing the
 * first Robinhood Brokerage statement, whose valuation agreed to the cent, took
 * "value anchors: 43 checked" to 42 and the check exited 0.
 *
 * The owner's answer (2026-09-15): the check FAILS when its count of witnesses
 * drops, and raises the count ON ITS OWN when a new statement adds one —
 * "sessions handle this, never you". So the mark is a high-water mark per kind,
 * kept in the ledger it describes (`ledger_witness_marks`), and never in a file
 * someone has to commit after every import.
 *
 *   recorded   no mark for the kind yet — the first run records what it sees
 *   raised     more than the mark — the mark becomes what was seen, no commit
 *   held       exactly the mark — nothing is written
 *   dropped    fewer than the mark — a `witness-drop` finding, and the mark
 *              stays until `--lower-marks=<kind> --confirm` lowers it
 *
 * ⚠️ A COUNT, as he said, not a set. One statement removed and a different one
 * imported between two runs holds the count, and passes.
 *
 * ⛔ A witness is keyed by its account's ID, and named only when a message is
 * printed. A name is something the owner edits: keyed by name, renaming Chase
 * Checking held every count (so nothing rewrote the mark), and the next real
 * drop — one Robinhood statement un-imported — listed fifty Chase Checking
 * windows as gone and hid the two Robinhood Cash windows that were (measured on
 * a copy, 2026-09-15, review).
 */

export const WITNESS_KINDS = ["value-anchors", "chain-endpoints", "chain-windows", "statement-periods", "accounts"] as const;
export type WitnessKind = (typeof WITNESS_KINDS)[number];

/*
 * What each kind is, and why it needs a floor of its own:
 *
 *   value anchors      every statement day on an investment account — the
 *                      pass-73 arbiter's denominator. The baseline lists the
 *                      15 that disagree; the other 28 were unguarded.
 *   chain endpoints    every anchor a cash account's chain is measured from —
 *                      `selectEndpoints`, the derivation's own choice. A lone
 *                      one bounds no window, so windows alone never saw it:
 *                      Cash on Hand's one typed $5,000.00 (2026-08-03, kept by
 *                      the owner's decision of 2026-09-14) was deleted through
 *                      deleteAnchor on a copy, the account's whole balance
 *                      history went with it, and every mark held (review,
 *                      2026-09-15).
 *                      ⚠️ A moment-only account (no statement, no typed
 *                      balance) whose first statement arrives trades its
 *                      moments for that one endpoint, and both this count and
 *                      windows can fall; no account in the ledger is
 *                      moment-only today (measured).
 *   chain windows      every consecutive chain-grade anchor pair walked. The
 *                      break baseline is EMPTY, so every one of them was.
 *   statement periods  every stored verdict re-graded. Measured: 15 statement
 *                      files own a period and NOTHING else — no anchor, no row
 *                      (a statement imported twice keeps them on the other
 *                      copy). Un-importing one on a copy (Discover, 2024-07-19
 *                      → 2024-08-18) failed on this floor alone; main exited 0.
 *   accounts           every account read for money with no source document.
 *                      That baseline names only the accounts where it is not
 *                      zero.
 */
const LABEL: Record<WitnessKind, string> = {
  "value-anchors": "value anchors",
  "chain-endpoints": "chain endpoints",
  "chain-windows": "chain windows",
  "statement-periods": "statement periods",
  accounts: "accounts",
};

/** One witness's identity, field by field, its ACCOUNT'S ID first: [id, day] · [id, from, to] · [id]. */
export type Witness = readonly string[];

export interface WitnessMark {
  count: number;
  /** the witnesses seen when the mark was last set — what a drop is told apart against */
  witnesses: readonly Witness[];
  /**
   * id → name of every account those witnesses are on, as it was called when
   * the mark was set. Only a message reads it, and only for an account no
   * longer in the ledger: one still there is named as it is called NOW.
   */
  accountNames: Readonly<Record<string, string>>;
}

export type WitnessMarks = Partial<Record<WitnessKind, WitnessMark>>;

/** The account id behind a name the observation keys by — an account with none is refused, never keyed by its name. */
function idOf(observed: LedgerObservation, name: string): string {
  const id = observed.accountIds[name];
  if (id === undefined) {
    throw new Error(
      `witness floor: "${name}" has no account id in the observation — a witness is keyed by its account's id, ` +
        `and keyed by a name a rename would read as every witness on the account gone`,
    );
  }
  return id;
}

/**
 * Entries of `[account name, ...fields]` as witnesses keyed by account id, in
 * code-unit order of the NAMED identity — deterministic on any machine, whatever
 * its locale, and readable in the order a person would look for them.
 */
const keyed = (observed: LedgerObservation, entries: readonly string[][]): Witness[] =>
  entries
    .map((entry) => JSON.stringify(entry))
    .sort()
    .map((key) => JSON.parse(key) as string[])
    .map(([name, ...fields]) => [idOf(observed, name!), ...fields]);

/** Every witness the observation counted, per kind. */
export function witnessesOf(observed: LedgerObservation): Record<WitnessKind, Witness[]> {
  return {
    "value-anchors": keyed(observed, [
      ...Object.entries(observed.valuedAnchorDays).flatMap(([account, days]) => days.map((on) => [account, on])),
      // a statement the app could not value is still there — `unpriced-anchor` reports it, this counts it
      ...observed.unpricedAnchors.map((a) => [a.account, a.on]),
    ]),
    "chain-endpoints": keyed(
      observed,
      Object.entries(observed.chainEndpoints).flatMap(([account, days]) => days.map((on) => [account, on])),
    ),
    "chain-windows": keyed(
      observed,
      Object.entries(observed.chainWindows).flatMap(([account, windows]) => windows.map((w) => [account, w.from, w.to])),
    ),
    "statement-periods": keyed(
      observed,
      Object.entries(observed.gradedPeriods).flatMap(([account, periods]) =>
        periods.map((p) => [account, p.periodStart, p.periodEnd]),
      ),
    ),
    accounts: keyed(
      observed,
      observed.accounts.map((name) => [name]),
    ),
  };
}

/** id → name of every account the observation read, as it is called now */
const namesNow = (observed: LedgerObservation): Record<string, string> =>
  Object.fromEntries(Object.entries(observed.accountIds).map(([name, id]) => [id, name]));

/** The mark `witnesses` set: their count, and the name of every account they are on. */
function markOf(observed: LedgerObservation, witnesses: Witness[]): WitnessMark {
  const onAccounts = new Set(witnesses.map(([id]) => id));
  return {
    count: witnesses.length,
    witnesses,
    accountNames: Object.fromEntries(Object.entries(namesNow(observed)).filter(([id]) => onAccounts.has(id))),
  };
}

/** `from` less `take`, as multisets — a witness recorded twice and seen once is gone once. */
function subtract(from: readonly Witness[], take: readonly Witness[]): Witness[] {
  const remaining = new Map<string, number>();
  for (const w of take) {
    const key = JSON.stringify(w);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return from.filter((w) => {
    const key = JSON.stringify(w);
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
}

/**
 * The witnesses in the mark that are not seen now.
 *
 * ⛔ A chain window an anchor ARRIVED inside is divided, not gone: that pair is
 * never walked again, but both halves are, and together they measure it (the
 * same rule `compareToBaseline` uses for a recorded break).
 */
function goneWitnesses(
  kind: WitnessKind,
  mark: readonly Witness[],
  seen: readonly Witness[],
  observed: LedgerObservation,
): Witness[] {
  const unseen = subtract(mark, seen);
  if (kind !== "chain-windows") return unseen;
  const walked = Object.fromEntries(
    Object.entries(observed.chainWindows).map(([name, windows]) => [idOf(observed, name), windows]),
  );
  return unseen.filter(([id, from, to]) => windowsSpanning(walked[`${id}`] ?? [], `${from}`, `${to}`) === null);
}

const SHOWN = 10;

/**
 * Gone witnesses as a person reads them, in name order. An account still in the
 * ledger is named as it is called now; one that is not, as the mark knew it.
 */
function describeGone(gone: readonly Witness[], mark: WitnessMark, observed: LedgerObservation): string {
  if (gone.length === 0) {
    return "every witness the mark lists is still accounted for, so which one left cannot be told";
  }
  const names: Readonly<Record<string, string>> = { ...mark.accountNames, ...namesNow(observed) };
  const labels = gone
    .map(([id, ...fields]) => [names[`${id}`] ?? `account ${id}`, ...fields])
    .map(([name, ...fields]) => (fields.length === 0 ? `${name}` : `${name} ${fields.join(" → ")}`))
    .sort();
  const more = labels.length - SHOWN;
  return `gone since the mark was set: ${labels.slice(0, SHOWN).join(", ")}` + (more > 0 ? ` and ${more} more` : "");
}

const HOW_TO_LOWER =
  "A witness this check counted has left the ledger, and nothing it proved is being checked any more. " +
  "Find what removed it (an un-import, a deleted anchor, a removed account) before anything else; only if the " +
  "owner approved that removal, lower the mark:";

export interface FloorResult {
  /** marks to store: kinds recorded for the first time, or raised — never a lowered one */
  writes: WitnessMarks;
  failures: LedgerFailure[];
  /** one line, every kind: its count, and what happened to its mark */
  summary: string;
}

/** The observation against the stored marks. */
export function compareToMarks(observed: LedgerObservation, marks: WitnessMarks): FloorResult {
  const seen = witnessesOf(observed);
  const writes: WitnessMarks = {};
  const failures: LedgerFailure[] = [];
  const segments: string[] = [];
  for (const kind of WITNESS_KINDS) {
    const now = seen[kind];
    const mark = marks[kind];
    const counted = `${LABEL[kind]} ${now.length}`;
    if (mark === undefined) {
      writes[kind] = markOf(observed, now);
      segments.push(`${counted} (recorded)`);
      continue;
    }
    if (now.length < mark.count) {
      segments.push(`${counted} (below its mark of ${mark.count})`);
      failures.push({
        kind: "witness-drop",
        account: LABEL[kind],
        detail:
          `${now.length} seen, below the mark of ${mark.count} — ` +
          `${describeGone(goneWitnesses(kind, mark.witnesses, now, observed), mark, observed)}. ` +
          `${HOW_TO_LOWER} pnpm ledger-check --lower-marks=${kind}, then the same with --confirm`,
      });
      continue;
    }
    if (now.length > mark.count) {
      writes[kind] = markOf(observed, now);
      segments.push(`${counted} (raised from ${mark.count})`);
      continue;
    }
    segments.push(counted);
  }
  return { writes, failures, summary: `witness marks: ${segments.join(" · ")}` };
}

/**
 * What `--lower-marks=<kinds>` would do: each named kind seen BELOW its mark
 * comes down to exactly what is seen. It never raises (a plain run does that)
 * and never touches a kind it was not given.
 */
export function planLowering(
  observed: LedgerObservation,
  marks: WitnessMarks,
  kinds: readonly WitnessKind[],
): { writes: WitnessMarks; lines: string[] } {
  const seen = witnessesOf(observed);
  const writes: WitnessMarks = {};
  const lines: string[] = [];
  for (const kind of kinds) {
    const now = seen[kind];
    const mark = marks[kind];
    if (mark === undefined) {
      lines.push(`${LABEL[kind]}: no mark recorded yet — nothing to lower (a plain run records one)`);
      continue;
    }
    if (now.length >= mark.count) {
      lines.push(`${LABEL[kind]}: ${now.length} seen, mark ${mark.count} — not below it, nothing to lower`);
      continue;
    }
    writes[kind] = markOf(observed, now);
    lines.push(
      `${LABEL[kind]}: lowers its mark ${mark.count} → ${now.length} — ` +
        describeGone(goneWitnesses(kind, mark.witnesses, now, observed), mark, observed),
    );
  }
  return { writes, lines };
}

export class WitnessFlagRefusal extends Error {}

export type LedgerCheckMode = { mode: "check" } | { mode: "lower"; kinds: WitnessKind[]; confirm: boolean };

const LOWER = "--lower-marks";

const isKind = (name: string): name is WitnessKind => (WITNESS_KINDS as readonly string[]).includes(name);

/**
 * The command line. ⛔ Anything unrecognised is refused, not ignored: the check
 * reads its database from MONEYAPP_DB_PATH, so `--db=<copy>` — the import
 * scripts' spelling — would otherwise be dropped and the REAL ledger checked.
 */
export function ledgerCheckMode(argv: readonly string[]): LedgerCheckMode {
  const stray = argv.find((a) => a !== "--confirm" && a !== LOWER && !a.startsWith(`${LOWER}=`));
  if (stray !== undefined) {
    throw new WitnessFlagRefusal(
      `unknown argument ${stray} — ledger-check reads its database from MONEYAPP_DB_PATH, and takes only ` +
        `${LOWER}=<kind,...> [--confirm]`,
    );
  }
  const confirm = argv.includes("--confirm");
  const lowers = argv.filter((a) => a !== "--confirm");
  if (lowers.length === 0) {
    if (confirm) {
      throw new WitnessFlagRefusal(`--confirm confirms ${LOWER}=<kind,...>, and there is nothing else to confirm`);
    }
    return { mode: "check" };
  }
  if (lowers.length > 1) {
    throw new WitnessFlagRefusal(
      `${LOWER} given ${lowers.length} times — name every kind in one: ${LOWER}=value-anchors,chain-windows`,
    );
  }
  const names = lowers[0]!
    .slice(LOWER.length + 1)
    .split(",")
    .filter((n) => n !== "");
  if (names.length === 0) {
    throw new WitnessFlagRefusal(
      `${LOWER} needs the kinds to lower: ${LOWER}=<kind,...>, of ${WITNESS_KINDS.join(", ")}`,
    );
  }
  const unknown = names.find((n) => !isKind(n));
  if (unknown !== undefined) {
    throw new WitnessFlagRefusal(`no witness kind "${unknown}" — the kinds are ${WITNESS_KINDS.join(", ")}`);
  }
  return { mode: "lower", kinds: [...new Set(names.filter(isKind))], confirm };
}

export interface WitnessMarkRow {
  kind: string;
  mark: number;
  witnesses: unknown;
  accountNames: unknown;
}

const isWitnessList = (value: unknown): value is Witness[] =>
  Array.isArray(value) &&
  value.every((w) => Array.isArray(w) && w.length > 0 && w.every((field) => typeof field === "string"));

const isNameMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((name) => typeof name === "string");

/**
 * The stored rows as marks.
 *
 * ⛔ A row that cannot be read is an ERROR, never an absent mark: the next run
 * would record whatever it sees, and a floor that rebuilds itself from a
 * damaged row is a floor satisfied by damaging it. A kind this version does not
 * know is left to the version that wrote it.
 */
export function marksFromRows(rows: readonly WitnessMarkRow[]): WitnessMarks {
  const marks: WitnessMarks = {};
  for (const row of rows) {
    if (!isKind(row.kind)) continue;
    const label = LABEL[row.kind];
    const refuse = (why: string): never => {
      throw new Error(`ledger_witness_marks: the ${label} mark${why}`);
    };
    if (!isWitnessList(row.witnesses)) {
      return refuse(`'s witnesses are not a list of fields — refusing to read it as no mark, which the next run would record afresh`);
    }
    if (!isNameMap(row.accountNames)) {
      return refuse(`'s account names are not a map of account id to name — refusing to read it as no mark`);
    }
    const listed = row.witnesses.length;
    if (listed !== row.mark) {
      return refuse(` says ${row.mark} but lists ${listed} witness${listed === 1 ? "" : "es"} — refusing to trust either`);
    }
    const names = row.accountNames;
    const unnamed = row.witnesses.find(([id]) => typeof names[`${id}`] !== "string");
    if (unnamed !== undefined) {
      return refuse(
        ` lists a witness on account ${unnamed[0]} and names no such account — a drop could not say what left`,
      );
    }
    marks[row.kind] = { count: row.mark, witnesses: row.witnesses, accountNames: names };
  }
  return marks;
}
