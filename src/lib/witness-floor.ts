import { type LedgerFailure, type LedgerObservation, windowsSpanning } from "./ledger-integrity";
import { LEFT_OUT_TOKEN, reasonCarriesControl, reasonSaysNothing } from "./left-out-acknowledgement";

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
 *   raised     more than the mark, every witness it lists still seen — the
 *              mark becomes what was seen, no commit
 *   held       as many as the mark, every witness it lists still seen —
 *              nothing is written
 *   dropped    fewer than the mark, OR any witness it lists no longer seen,
 *              whatever the count — a `witness-drop` finding. What left stays
 *              in the mark until `--lower-marks=<kind> --confirm` lowers it,
 *              and what arrived meanwhile joins it, so an arrival that leaves
 *              before the lowering is named too (`arrivalsJoining`)
 *
 * ⛔ The SET, not only the count. Compared by count alone, a witness could leave
 * unseen two ways (the one-caller sweep, 2026-09-22): one statement un-imported
 * and another imported between two runs held the count and passed; and with a
 * second one imported, the RAISE rewrote the mark from what was seen, so the
 * one that left was erased from it for good and no later run could name it.
 * His rule is that a removal fails until someone looks, and that a mark comes
 * down only by the guarded step. A departure that arrivals hide from the count
 * is still a removal.
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
 *                      moments for that one endpoint: the moments leave this
 *                      kind and windows, and the floor fails on them, whatever
 *                      the counts, until `--lower-marks` approves the trade.
 *                      No account in the ledger is moment-only today
 *                      (measured).
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

/**
 * The mark `witnesses` set: their count, and the name of every account they are on. An account no longer in the
 * ledger keeps the name `known` gave it: a joined mark still lists what left, and a row listing a witness on an
 * account it names nowhere cannot be read back (`marksFromRows`).
 */
function markOf(
  observed: LedgerObservation,
  witnesses: Witness[],
  known: Readonly<Record<string, string>> = {},
): WitnessMark {
  const onAccounts = new Set(witnesses.map(([id]) => id));
  return {
    count: witnesses.length,
    witnesses,
    accountNames: Object.fromEntries(
      Object.entries({ ...known, ...namesNow(observed) }).filter(([id]) => onAccounts.has(id)),
    ),
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

interface Standing {
  /** the witnesses the mark lists that are gone now */
  gone: Witness[];
  /** fewer seen than the mark, or any witness it lists gone: a plain run fails it, `--lower-marks` approves it */
  dropped: boolean;
}

/**
 * How a kind stands against its mark. The one rule both a plain run and
 * `--lower-marks` ask, so the check never fails a kind the lowering will not
 * lower, or lowers one the check would pass.
 */
function standingOf(
  kind: WitnessKind,
  mark: WitnessMark,
  now: readonly Witness[],
  observed: LedgerObservation,
): Standing {
  const gone = goneWitnesses(kind, mark.witnesses, now, observed);
  return { gone, dropped: now.length < mark.count || gone.length > 0 };
}

/** two windows on one account that share any stretch of days — meeting at an end is not sharing */
const overlap = ([id, from, to]: Witness, [otherId, otherFrom, otherTo]: Witness): boolean =>
  id === otherId && `${from}` < `${otherTo}` && `${otherFrom}` < `${to}`;

/**
 * What joins the mark of a kind that DROPPED: every witness seen that the mark does not list. The mark keeps
 * what left — named until `--lower-marks` approves it — and takes these in beside it. When a drop wrote nothing,
 * a witness that arrived while its kind was failing and left before the lowering was named by no run, and the
 * lowering, approved for the removal it did name, set the mark to what was seen and erased it without a word
 * (review, 2026-09-28).
 *
 * ⛔ Never a chain window over days the mark already covers: one mark never holds two windows over the same
 * days. Such a window is walked only because an anchor within those days left (it merges the mark's windows) or
 * arrived (it divides one); with both in one mark, undoing the removal — a statement un-imported and imported
 * again — walks fewer windows than the mark lists, and fails on the count with nothing gone. The mark's own
 * windows measure those days, and the window's ends are chain endpoints, which that kind takes in and names like
 * any other witness.
 */
function arrivalsJoining(kind: WitnessKind, mark: WitnessMark, now: readonly Witness[]): Witness[] {
  const arrived = subtract(now, mark.witnesses);
  if (kind !== "chain-windows") return arrived;
  return arrived.filter((window) => !mark.witnesses.some((marked) => overlap(marked, window)));
}

const SHOWN = 10;

/**
 * Gone witnesses as a person reads them, in name order. An account still in the
 * ledger is named as it is called now; one that is not, as the mark knew it.
 *
 * ⛔ Said without a WHEN. A failing kind's mark is written again when something
 * joins it (`arrivalsJoining`), with what had already left kept in it, so "gone
 * since the mark was set" would date a departure after a write it came before —
 * and whoever looked for what removed it since that write would find nothing.
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
  return (
    `listed in the mark, no longer seen: ${labels.slice(0, SHOWN).join(", ")}` + (more > 0 ? ` and ${more} more` : "")
  );
}

const HOW_TO_LOWER =
  "A witness this check counted has left the ledger, and nothing it proved is being checked any more. " +
  "Find what removed it (an un-import, a deleted anchor, a removed account) before anything else; only if the " +
  "owner approved that removal, lower the mark:";

export interface FloorResult {
  /**
   * marks to store: kinds recorded for the first time, raised, or — a kind that dropped — joined by what arrived,
   * what left kept in them. Never a lowered one.
   */
  writes: WitnessMarks;
  failures: LedgerFailure[];
  /** one line, every kind: its count, and what happened to its mark */
  summary: string;
}

/**
 * How the count of a kind that dropped stands against its mark. Level with it or
 * above it is said in so many words: a count that held reads as nothing wrong,
 * and the kind failed only because others arrived in the place of what left.
 */
function against(seen: number, mark: number): string {
  if (seen < mark) return `below the mark of ${mark}`;
  return seen === mark
    ? `as many as the mark of ${mark} but not the same ones`
    : `above the mark of ${mark} but not every one it lists`;
}

/**
 * A dropped kind's part of the summary line. When anything joined its mark the new size is said, so the next
 * run's "mark of N" is not a number that came from nowhere. It counts what JOINED — "N arrivals join it", never
 * "the N that arrived": a chain window over days the mark covers arrives without joining (`arrivalsJoining`).
 */
function droppedSegment(seen: number, gone: number, mark: number, joining: number): string {
  const standing = seen < mark ? `below its mark of ${mark}` : `${gone} gone from its mark of ${mark}`;
  if (joining === 0) return standing;
  const join = joining === 1 ? "arrival joins" : "arrivals join";
  return `${standing}; ${joining} ${join} it: ${mark} → ${mark + joining}`;
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
    // ⛔ asked before any raise: a raise writes the mark afresh from what is seen, which would erase what left
    const { gone, dropped } = standingOf(kind, mark, now, observed);
    if (dropped) {
      // what left stays in the mark until it is lowered, and what arrived joins it (`arrivalsJoining`)
      const joining = arrivalsJoining(kind, mark, now);
      if (joining.length > 0) writes[kind] = markOf(observed, [...mark.witnesses, ...joining], mark.accountNames);
      segments.push(`${counted} (${droppedSegment(now.length, gone.length, mark.count, joining.length)})`);
      failures.push({
        kind: "witness-drop",
        account: LABEL[kind],
        detail:
          `${now.length} seen, ${against(now.length, mark.count)} — ${describeGone(gone, mark, observed)}. ` +
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
 * What `--lower-marks=<kinds>` would do: each named kind that DROPPED — seen
 * below its mark, or missing any witness it lists — comes down to exactly what
 * is seen. It never touches a kind that did not drop (a plain run raises that)
 * or a kind it was not given. What it names as gone is everything the mark
 * lists and the ledger no longer shows — an arrival a plain run took in while
 * the kind was failing, and that has left since, among them.
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
    const { gone, dropped } = standingOf(kind, mark, now, observed);
    if (!dropped) {
      lines.push(
        `${LABEL[kind]}: ${now.length} seen, mark ${mark.count} — ` +
          "not below it and nothing it lists gone, nothing to lower",
      );
      continue;
    }
    writes[kind] = markOf(observed, now);
    const change =
      now.length < mark.count
        ? `lowers its mark ${mark.count} → ${now.length}`
        : `sets its mark ${mark.count} → ${now.length}, forgetting what left`;
    lines.push(`${LABEL[kind]}: ${change} — ${describeGone(gone, mark, observed)}`);
  }
  return { writes, lines };
}

export class WitnessFlagRefusal extends Error {}

export type LedgerCheckMode =
  | { mode: "check" }
  | { mode: "lower"; kinds: WitnessKind[]; confirm: boolean }
  // ⛔ `--confirm` only WITH a reason — the type says so, so the write is never reached without one
  | { mode: "acknowledge"; tokens: string[]; confirm: false; reason: string | null }
  | { mode: "acknowledge"; tokens: string[]; confirm: true; reason: string };

const LOWER = "--lower-marks";
/** ⚖️ Owner, 2026-10-02 (§6A 30): a line left out, acknowledged after a session read it on the statement */
const ACKNOWLEDGE = "--acknowledge-left-out";
/**
 * What the session read on the statement, stored with the acknowledgement and printed with the line. ⛔ Required by
 * `--confirm`: "an entry without a reason is a check that has been quieted rather than passed" (ledger-check's BASELINE).
 */
const REASON = "--reason";
const SAYS = `${REASON}='<what the statement shows>'`;
const WRITES = `${LOWER}=<kind,...> or ${ACKNOWLEDGE}=<mark> ${SAYS}`;

const isKind = (name: string): name is WitnessKind => (WITNESS_KINDS as readonly string[]).includes(name);
const isFlag = (arg: string, flag: string): boolean => arg === flag || arg.startsWith(`${flag}=`);
/** a flag's comma-separated values, the empty ones dropped */
const valuesOf = (arg: string, flag: string): string[] =>
  arg
    .slice(flag.length + 1)
    .split(",")
    .filter((v) => v !== "");

/**
 * The command line. ⛔ Anything unrecognised is refused, not ignored: the check
 * reads its database from MONEYAPP_DB_PATH, so `--db=<copy>` — the import
 * scripts' spelling — would otherwise be dropped and the REAL ledger checked.
 * And one guarded write a run: `--confirm` must never confirm one the session
 * did not dry-run on its own. A `--reason` with no acknowledgement to store it
 * is refused too, never dropped.
 */
export function ledgerCheckMode(argv: readonly string[]): LedgerCheckMode {
  const stray = argv.find((a) => a !== "--confirm" && !isFlag(a, LOWER) && !isFlag(a, ACKNOWLEDGE) && !isFlag(a, REASON));
  if (stray !== undefined) {
    throw new WitnessFlagRefusal(
      `unknown argument ${stray} — ledger-check reads its database from MONEYAPP_DB_PATH, and takes only ` +
        `${WRITES} [--confirm]`,
    );
  }
  const confirm = argv.includes("--confirm");
  const lowers = argv.filter((a) => isFlag(a, LOWER));
  const acknowledges = argv.filter((a) => isFlag(a, ACKNOWLEDGE));
  const reasons = argv.filter((a) => isFlag(a, REASON));
  if (reasons.length > 0 && acknowledges.length === 0) {
    throw new WitnessFlagRefusal(`${REASON} is stored by ${ACKNOWLEDGE} with the line it acknowledges, and there is no ${ACKNOWLEDGE} here`);
  }
  if (lowers.length === 0 && acknowledges.length === 0) {
    if (confirm) {
      throw new WitnessFlagRefusal(`--confirm confirms ${WRITES}, and there is nothing else to confirm`);
    }
    return { mode: "check" };
  }
  if (lowers.length > 0 && acknowledges.length > 0) {
    throw new WitnessFlagRefusal(`${LOWER} and ${ACKNOWLEDGE} are two guarded writes — run each on its own, so --confirm confirms one`);
  }
  return acknowledges.length > 0 ? acknowledgeMode(acknowledges, reasons, confirm) : lowerMode(lowers, confirm);
}

/**
 * `--reason='<what the statement shows>'`, kept whole — commas, colons and equals signs are the session's words — on
 * one line, every run of whitespace one space: it is printed inside a sentence. Null when none is given. ⛔ One of
 * only whitespace, zero-width, format and control characters, or the braille blank, says nothing, and is refused
 * (`reasonSaysNothing`). ⛔ So is one carrying a control character among its words, dry run or not: stored, it would
 * be printed raw wherever the line is (`reasonCarriesControl`).
 */
function reasonOf(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length > 1) {
    throw new WitnessFlagRefusal(`${REASON} given ${args.length} times — one acknowledgement, one reason: ${SAYS}`);
  }
  const reason = args[0]!.slice(REASON.length + 1).replace(/\s+/g, " ").trim();
  if (reasonSaysNothing(reason)) {
    throw new WitnessFlagRefusal(`${REASON} needs what the session read on the statement: ${SAYS}`);
  }
  const carries = reasonCarriesControl(reason);
  if (carries !== null) {
    throw new WitnessFlagRefusal(`${REASON} ${carries} — nothing was written: ${SAYS}, in characters a reader sees`);
  }
  return reason;
}

/**
 * `--acknowledge-left-out=<marks>`: each mark the ten hex digits ledger-check prints beside a line (`leftOutToken`).
 *
 * ⛔ `--confirm` needs `--reason`, and a reason names ONE line: given beside two marks it would be stored with a line it
 * does not describe. Two lines alike share one mark, and so one reason: they read the same on the statement.
 */
function acknowledgeMode(args: readonly string[], reasons: readonly string[], confirm: boolean): LedgerCheckMode {
  if (args.length > 1) {
    throw new WitnessFlagRefusal(`${ACKNOWLEDGE} given ${args.length} times — name every line's mark in one: ${ACKNOWLEDGE}=<mark,mark>`);
  }
  const tokens = valuesOf(args[0]!, ACKNOWLEDGE);
  if (tokens.length === 0) {
    throw new WitnessFlagRefusal(
      `${ACKNOWLEDGE} needs the marks of the lines to acknowledge: ${ACKNOWLEDGE}=<mark,...>, each the ten hex digits ` +
        "ledger-check prints beside a line left out",
    );
  }
  const unknown = tokens.find((t) => !LEFT_OUT_TOKEN.test(t));
  if (unknown !== undefined) {
    throw new WitnessFlagRefusal(
      `"${unknown}" is not a line's mark — ledger-check prints each line left out with its own: [line-left-out <ten hex digits>]`,
    );
  }
  const marks = [...new Set(tokens)];
  const reason = reasonOf(reasons);
  if (reason !== null && marks.length > 1) {
    throw new WitnessFlagRefusal(
      `${REASON} says what ONE line is on its statement — ${marks.length} marks given: acknowledge each in its own run, ` +
        `with its own ${REASON}`,
    );
  }
  if (!confirm) return { mode: "acknowledge", tokens: marks, confirm, reason };
  if (reason === null) {
    throw new WitnessFlagRefusal(
      `--confirm records an acknowledgement, and one needs ${SAYS} — what the session read on the statement, stored ` +
        "and printed with the line: an acknowledgement without a reason is a check quieted, not passed. Nothing was written",
    );
  }
  return { mode: "acknowledge", tokens: marks, confirm, reason };
}

function lowerMode(lowers: readonly string[], confirm: boolean): LedgerCheckMode {
  if (lowers.length > 1) {
    throw new WitnessFlagRefusal(
      `${LOWER} given ${lowers.length} times — name every kind in one: ${LOWER}=value-anchors,chain-windows`,
    );
  }
  const names = valuesOf(lowers[0]!, LOWER);
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
