import { describe, expect, test } from "vitest";
import { lineLeftOutNotice } from "./import-file-label";
import {
  acknowledgedOf,
  acknowledgementWrites,
  acknowledgementsOf,
  confirmingStep,
  leftOutToken,
  planAcknowledging,
  reasonChangeRefusal,
  unmatchedAcknowledgementNotice,
  type AcknowledgeableLine,
  type LeftOutAcknowledgement,
} from "./left-out-acknowledgement";
import { ledgerCheckMode } from "./witness-floor";

/**
 * ⚖️ Owner, 2026-10-02 (§6A 30): a line left out may be ACKNOWLEDGED once a session has read it on the statement —
 * `pnpm ledger-check` keeps naming it, says on what day it was acknowledged, and stops failing on it. These pin the
 * rule every reader asks: which acknowledgement covers which line, and never one it does not.
 */

// the owner's Wells Fargo Everyday Checking, by the id his ledger gives it
const WF = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
const CHASE = "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722";
const RE_DOWNLOAD = "1f".repeat(32);
const THIRD = "2e".repeat(32);
const STATEMENT = "3d".repeat(32);

/** what the session read on the statement (`--reason`) */
const READ_IT = "July statement, page 1: the bank's opening deposit, reversed the same day by the card it came from";

/** the rehearsal of 2026-09-28: a re-read of the export drops the account's +$25.00 opening deposit */
const line = (over: Partial<AcknowledgeableLine> = {}): AcknowledgeableLine => ({
  accountId: WF,
  accountName: "Wells Fargo Everyday Checking",
  printedOn: "2026-07-27",
  amountCents: 2500,
  description: "WFB Opening Deposit From Card",
  printedBy: ["wf-export (1).csv"],
  readBy: "wf-export.csv",
  acknowledged: null,
  rowId: "row-opening",
  rowWrittenAt: "2026-09-20T14:00:00.000Z",
  printings: [{ sha256: RE_DOWNLOAD, printedOn: "2026-07-27", words: "WFB OPENING DEPOSIT FROM CARD" }],
  ...over,
});

const ack = (over: Partial<LeftOutAcknowledgement> = {}): LeftOutAcknowledgement => ({
  id: "ack-1",
  accountId: WF,
  printedOn: "2026-07-27",
  amountCents: 2500,
  printedWords: "WFB OPENING DEPOSIT FROM CARD",
  printerSha256: RE_DOWNLOAD,
  description: "WFB Opening Deposit From Card",
  acknowledgedOn: "2026-10-05",
  reason: READ_IT,
  createdAt: "2026-10-05T16:00:00.000Z",
  ...over,
});

describe("leftOutToken — the mark a line is acknowledged by", () => {
  test("ten hex digits, the same every run for the same line", () => {
    expect(leftOutToken(line())).toMatch(/^[0-9a-f]{10}$/);
    expect(leftOutToken(line())).toBe(leftOutToken(line({ rowId: "a-later-row", readBy: null, description: "other words" })));
  });

  test("any field of what identifies the line moves it", () => {
    const first = line().printings[0]!;
    const marks = [
      line(),
      line({ accountId: CHASE }),
      line({ amountCents: -2500 }),
      line({ printings: [{ ...first, printedOn: "2026-07-28" }] }),
      line({ printings: [{ ...first, words: "WFB OPENING DEPOSIT" }] }),
      line({ printings: [{ ...first, sha256: THIRD }] }),
    ].map(leftOutToken);
    expect(new Set(marks).size).toBe(marks.length);
  });

  test("it is the first printer's — the file whose day and words the notice shows", () => {
    const second = { sha256: THIRD, printedOn: "2026-07-27", words: "WFB OPENING DEPOSIT FROM CARD" };
    expect(leftOutToken(line({ printings: [...line().printings, second] }))).toBe(leftOutToken(line()));
  });
});

describe("acknowledgementsOf — which acknowledgement covers which line", () => {
  test("an acknowledgement of the line covers it", () => {
    const { byRow, unmatched } = acknowledgementsOf([line()], [ack()]);
    expect(byRow.get("row-opening")).toEqual(ack());
    expect(unmatched).toEqual([]);
  });

  test("⛔ a line that differs in any field it is keyed by is not covered, and the acknowledgement matches nothing", () => {
    const first = line().printings[0]!;
    for (const other of [
      line({ accountId: CHASE }),
      line({ amountCents: 2501 }),
      line({ printings: [{ ...first, printedOn: "2026-07-28" }] }),
      line({ printings: [{ ...first, words: "WFB OPENING DEPOSIT" }] }),
      line({ printings: [{ ...first, sha256: STATEMENT }] }),
    ]) {
      const { byRow, unmatched } = acknowledgementsOf([other], [ack()]);
      expect(byRow.size).toBe(0);
      expect(unmatched).toEqual([ack()]);
    }
  });

  test("not by the retired row: a line a later re-read names by another row is still the line acknowledged", () => {
    expect(acknowledgementsOf([line({ rowId: "row-of-version-3" })], [ack()]).byRow.get("row-of-version-3")).toEqual(ack());
  });

  test("the file acknowledged among its printers, wherever it sorts: a re-read of it gives it a new id, not new bytes", () => {
    const first = { sha256: STATEMENT, printedOn: "2026-07-27", words: "WFB OPENING DEPOSIT FROM CARD" };
    const printed = line({ printings: [first, ...line().printings] });
    expect(acknowledgementsOf([printed], [ack()]).byRow.get("row-opening")).toEqual(ack());
  });

  test("⛔ the file acknowledged no longer printing it: not covered", () => {
    const only = line({ printings: [{ sha256: THIRD, printedOn: "2026-07-27", words: "WFB OPENING DEPOSIT FROM CARD" }] });
    expect(acknowledgementsOf([only], [ack()]).byRow.size).toBe(0);
  });

  test("⛔ two lines alike take one acknowledgement each: one acknowledgement covers one of them, never both", () => {
    const twins = [line(), line({ rowId: "row-twin" })];
    const one = acknowledgementsOf(twins, [ack()]);
    expect([...one.byRow.keys()]).toEqual(["row-opening"]);

    const two = acknowledgementsOf(twins, [ack(), ack({ id: "ack-2" })]);
    expect([...two.byRow.entries()].map(([row, a]) => [row, a.id])).toEqual([
      ["row-opening", "ack-1"],
      ["row-twin", "ack-2"],
    ]);
  });

  /**
   * 🔴 Each line took the oldest acknowledgement covering it, and an acknowledgement covers a line any of its printers
   * prints alike. Probe at ec80c93: P printed by one file on 07-25 and by another on 07-26, Q only by the second, alike
   * there; Q's acknowledgement recorded first. P took Q's, Q failed, and P's was named "no line left out matches it now".
   */
  test("⛔ every line acknowledged is covered, though one of them could take the other's acknowledgement", () => {
    const words = "WFB OPENING DEPOSIT FROM CARD";
    const p = line({
      rowId: "row-p",
      printedOn: "2026-07-25",
      printings: [
        { sha256: STATEMENT, printedOn: "2026-07-25", words },
        { sha256: RE_DOWNLOAD, printedOn: "2026-07-26", words },
      ],
    });
    const q = line({ rowId: "row-q", printedOn: "2026-07-26", printings: [{ sha256: RE_DOWNLOAD, printedOn: "2026-07-26", words }] });
    const ackQ = ack({ id: "ack-q", printedOn: "2026-07-26", printerSha256: RE_DOWNLOAD, createdAt: "2026-10-05T16:00:00.000Z" });
    const ackP = ack({ id: "ack-p", printedOn: "2026-07-25", printerSha256: STATEMENT, createdAt: "2026-10-05T17:00:00.000Z" });
    for (const lines of [[p, q], [q, p]]) {
      const { byRow, unmatched } = acknowledgementsOf(lines, [ackP, ackQ]);
      expect(Object.fromEntries([...byRow].map(([row, a]) => [row, a.id]))).toEqual({ "row-p": "ack-p", "row-q": "ack-q" });
      expect(unmatched).toEqual([]);
    }
  });

  /**
   * ⛔ A line takes the acknowledgement given for it — the one its own mark wrote — before another line alike under one
   * of its printers does: else the line a session read and acknowledged still fails, and one nobody read is hidden.
   */
  test("⛔ the line a mark acknowledged keeps it: a line alike only under another printer does not take it", () => {
    const words = "WFB OPENING DEPOSIT FROM CARD";
    const read = line();
    const unread = line({
      rowId: "row-unread",
      printings: [
        { sha256: STATEMENT, printedOn: "2026-07-27", words },
        { sha256: RE_DOWNLOAD, printedOn: "2026-07-27", words },
      ],
    });
    expect(leftOutToken(unread)).not.toBe(leftOutToken(read));
    for (const lines of [[unread, read], [read, unread]]) {
      const { byRow, unmatched } = acknowledgementsOf(lines, [ack()]);
      expect([...byRow].map(([row, a]) => [row, a.id])).toEqual([["row-opening", "ack-1"]]);
      expect(unmatched).toEqual([]);
    }
  });

  /**
   * The probe's case again where neither line has its own acknowledgement any more — a file uploaded since sorts first
   * among each one's printers — so each is covered only by one keyed under another printer, and the older of the two
   * covers both: A must leave it to B and take the one only A is printed by.
   */
  test("⛔ every line acknowledged is covered, when none of them is covered by its own mark's acknowledgement", () => {
    const words = "WFB OPENING DEPOSIT FROM CARD";
    const later = "4c".repeat(32);
    const printing = (sha256: string) => ({ sha256, printedOn: "2026-07-27", words });
    const a = line({ rowId: "row-a", printings: [printing(STATEMENT), printing(RE_DOWNLOAD), printing(THIRD)] });
    const b = line({ rowId: "row-b", printings: [printing(later), printing(RE_DOWNLOAD)] });
    const both = ack({ id: "ack-both", printerSha256: RE_DOWNLOAD, createdAt: "2026-10-05T16:00:00.000Z" });
    const onlyA = ack({ id: "ack-only-a", printerSha256: THIRD, createdAt: "2026-10-05T17:00:00.000Z" });
    for (const lines of [[a, b], [b, a]]) {
      const { byRow, unmatched } = acknowledgementsOf(lines, [both, onlyA]);
      expect(Object.fromEntries([...byRow].map(([row, x]) => [row, x.id]))).toEqual({ "row-a": "ack-only-a", "row-b": "ack-both" });
      expect(unmatched).toEqual([]);
    }
  });

  /**
   * 🔴 The leaving it acknowledged ended — a re-read wrote the line again — and a later one left it out again: the same
   * day, money, words and file, a new row. Keyed by those alone, the old acknowledgement hid a regression nobody read.
   */
  test("⛔ a line whose row was written after the acknowledgement is a later leaving: not covered", () => {
    const later = line({ rowId: "row-of-version-4", rowWrittenAt: "2026-10-06T09:00:00.000Z" });
    const { byRow, unmatched } = acknowledgementsOf([later], [ack()]);
    expect(byRow.size).toBe(0);
    expect(unmatched).toEqual([ack()]);
  });
});

describe("planAcknowledging — the guarded write, a dry run first", () => {
  const TODAY = { on: "2026-10-05", reason: READ_IT };
  const REFUSED =
    "REFUSED: --reason is not the reason stored, and this step never changes a stored one nor gives lines alike two — " +
    "nothing was written. Stored:";

  test("a line's mark acknowledges it: the write keys it by its first printer, and stores what the session read", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line())], TODAY);
    expect(plan.open).toEqual([line()]);
    expect(acknowledgementWrites(plan.open, TODAY)).toEqual([
      {
        accountId: WF,
        printedOn: "2026-07-27",
        amountCents: 2500,
        printedWords: "WFB OPENING DEPOSIT FROM CARD",
        printerSha256: RE_DOWNLOAD,
        description: "WFB Opening Deposit From Card",
        acknowledgedOn: "2026-10-05",
        reason: READ_IT,
      },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  /* ⛔ the dry run shows what would be stored — the very sentence every surface prints with the line from then on */
  test("says the line it is, and the reason it stores, as the line will read once acknowledged", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line())], TODAY);
    const stored = `Acknowledged on 2026-10-05: ${READ_IT}`;
    expect(plan.lines).toEqual([
      `${leftOutToken(line())}: acknowledges ${lineLeftOutNotice(line())}`,
      `${leftOutToken(line())}: stores, printed with the line from now on — ${stored}`,
    ]);
    expect(lineLeftOutNotice({ ...line(), acknowledged: TODAY }).endsWith(` ${stored}`)).toBe(true);
  });

  test("a dry run with no reason says the line, and that --confirm needs what the session read", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line())], { on: "2026-10-05", reason: null });
    expect(plan.open).toEqual([line()]);
    expect(plan.lines).toEqual([
      `${leftOutToken(line())}: acknowledges ${lineLeftOutNotice(line())}`,
      `${leftOutToken(line())}: stores no reason yet — --confirm needs --reason='<what the statement shows>', printed with the line from then on`,
    ]);
  });

  test("two lines alike share a mark, and it acknowledges both — one write each, each with the reason", () => {
    const twins = [line(), line({ rowId: "row-twin" })];
    const plan = planAcknowledging(twins, [leftOutToken(line())], TODAY);
    expect(acknowledgementWrites(plan.open, TODAY).map((w) => w.reason)).toEqual([READ_IT, READ_IT]);
    expect(plan.lines[0]).toMatch(/: acknowledges 2 lines alike — /);
  });

  test("a line acknowledged already is said, with what was read then, and written again never", () => {
    const done = line({ acknowledged: { on: "2026-10-04", reason: "Printed on the July statement." } });
    // a dry run with no reason, and a run giving the very reason stored
    for (const reason of [null, "Printed on the July statement."]) {
      const plan = planAcknowledging([done], [leftOutToken(done)], { on: "2026-10-05", reason });
      expect(plan.open).toEqual([]);
      expect(plan.unmatched).toEqual([]);
      expect(plan.reasonsKept).toEqual([]);
      expect(plan.lines).toEqual([
        `${leftOutToken(done)}: acknowledged already, nothing to write — Acknowledged on 2026-10-04: Printed on the July statement.`,
      ]);
    }
  });

  /*
   * 🔴 Another --reason for a line acknowledged already was dropped: the run said "nothing to acknowledge" and exited 0,
   * and the session's words were stored nowhere — while it believed them stored. This step never changes a stored
   * reason, so the run is refused, and says the reason that is stored.
   */
  test("⛔ another reason for a line acknowledged already is refused — this step never changes a stored one", () => {
    const stored = { on: "2026-10-04", reason: "Printed on the July statement." };
    const done = line({ acknowledged: stored });
    const mark = leftOutToken(done);
    const plan = planAcknowledging([done], [mark], TODAY);
    expect(plan.open).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.reasonsKept).toEqual([{ mark, stored: [stored] }]);
    expect(plan.lines).toEqual([
      `${mark}: acknowledged already, and --reason is not the reason stored, which stays: this step never changes a ` +
        "stored one — Acknowledged on 2026-10-04: Printed on the July statement.",
    ]);
    expect(reasonChangeRefusal(plan.reasonsKept)).toEqual([
      REFUSED,
      `  ${mark}: Acknowledged on 2026-10-04: Printed on the July statement.`,
    ]);
  });

  /* two lines alike acknowledged in one run carry one acknowledgement, the same day and words: said once, never twice */
  test("⛔ two lines alike acknowledged in one run: a run giving another reason says the one stored, once", () => {
    const stored = { on: "2026-10-04", reason: "Printed on the July statement." };
    const twins = [line({ acknowledged: stored }), line({ rowId: "row-twin", acknowledged: { ...stored } })];
    const mark = leftOutToken(line());
    const plan = planAcknowledging(twins, [mark], TODAY);
    expect(plan.reasonsKept).toEqual([{ mark, stored: [stored] }]);
    expect(plan.lines).toEqual([
      `${mark}: acknowledged already, and --reason is not the reason stored, which stays: this step never changes a ` +
        "stored one — Acknowledged on 2026-10-04: Printed on the July statement.",
    ]);
    expect(reasonChangeRefusal(plan.reasonsKept)).toEqual([
      REFUSED,
      `  ${mark}: Acknowledged on 2026-10-04: Printed on the July statement.`,
    ]);
  });

  /*
   * 🔴 A mark PARTLY acknowledged — a line alike acknowledged in an earlier run, another left out since — took another
   * --reason for its open line without a word of the one stored: --confirm stored it, and lines alike, which read the same
   * on the statement, carried two reasons. Its reasons stored are said now, and another one is refused, exit 2, as for a
   * mark whose every line is acknowledged. 🔴 It said "acknowledged already, with another reason" beside the reason
   * stored, as if that one were the other: it says now, in the refusal's words, that --reason is not the one stored,
   * and the one stored stays.
   */
  test("⛔ a mark partly acknowledged: another reason for its open line is refused, saying the reason stored", () => {
    const stored = { on: "2026-10-04", reason: "Printed on the July statement." };
    const twins = [line({ acknowledged: stored }), line({ rowId: "row-twin" })];
    const mark = leftOutToken(line());
    const plan = planAcknowledging(twins, [mark], TODAY);
    expect(plan.open).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.reasonsKept).toEqual([{ mark, stored: [stored] }]);
    expect(plan.lines).toEqual([
      `${mark}: 1 of its 2 lines alike acknowledged already, and --reason is not the reason stored, which stays: this ` +
        "step never changes a stored one nor gives lines alike two — Acknowledged on 2026-10-04: Printed on the July statement.",
    ]);
    expect(reasonChangeRefusal(plan.reasonsKept)).toEqual([
      REFUSED,
      `  ${mark}: Acknowledged on 2026-10-04: Printed on the July statement.`,
    ]);
  });

  test("a mark partly acknowledged, given the reason stored or none: its open lines are planned, the reason stored said", () => {
    const stored = { on: "2026-10-04", reason: READ_IT };
    // two acknowledged in one run, one left out since: the reason they carry is said once, with how many carry it
    const lines = [
      line({ acknowledged: stored }),
      line({ rowId: "row-twin", acknowledged: { ...stored } }),
      line({ rowId: "row-third" }),
    ];
    const mark = leftOutToken(line());
    for (const reason of [READ_IT, null]) {
      const plan = planAcknowledging(lines, [mark], { on: "2026-10-05", reason });
      expect(plan.open).toEqual([lines[2]]);
      expect(plan.reasonsKept).toEqual([]);
      expect(plan.lines[0]).toBe(
        `${mark}: 2 of its 3 lines alike acknowledged already, and lines alike take one reason — ` +
          `Acknowledged on 2026-10-04: ${READ_IT}`,
      );
      expect(plan.lines[1]).toBe(`${mark}: acknowledges ${lineLeftOutNotice(lines[2]!)}`);
    }
    expect(planAcknowledging(lines, [mark], TODAY).lines.slice(1)).toEqual(planAcknowledging([lines[2]!], [mark], TODAY).lines);
    const writes = acknowledgementWrites(planAcknowledging(lines, [mark], TODAY).open, TODAY);
    expect(writes.map((w) => w.reason)).toEqual([READ_IT]);
  });

  /*
   * 🔴 With no reason given, a mark partly acknowledged said "--confirm needs --reason='<what the statement shows>'" —
   * and the session's own words are refused for it: lines alike take the one stored (review of 9084a9c). It names that
   * one now, exactly, quoted as the shell reads it.
   */
  test("⛔ a mark partly acknowledged, no reason yet: --confirm needs the reason stored, named exactly", () => {
    const lines = [line({ acknowledged: { on: "2026-10-04", reason: READ_IT } }), line({ rowId: "row-twin" })];
    const mark = leftOutToken(line());
    const plan = planAcknowledging(lines, [mark], { on: "2026-10-05", reason: null });
    expect(plan.open).toEqual([lines[1]]);
    expect(plan.reasonsStored).toEqual(new Map([[mark, [READ_IT]]]));
    expect(plan.lines.at(-1)).toBe(
      `${mark}: stores no reason yet — --confirm needs the reason its lines alike carry, exactly: ` +
        "--reason='July statement, page 1: the bank'\\''s opening deposit, reversed the same day by the card it came from', " +
        "printed with the line from then on",
    );
    // a mark with nothing acknowledged takes the session's words: no reason stored to name
    expect(planAcknowledging([line()], [mark], { on: "2026-10-05", reason: null }).reasonsStored).toEqual(new Map());
  });

  /*
   * Another reason is one NONE of a mark's lines carries. 🔴 It was one any of them did not: lines alike carrying two
   * reasons refused every --reason — each differs from one of the two — so a line alike left open beside them could
   * never be acknowledged, and ledger-check failed on it for good (review of 9084a9c). Lines alike given two keep both
   * (this step never changes a stored reason); a run giving one of them writes nothing more, and says both.
   */
  test("⛔ two lines alike acknowledged with two reasons: giving one writes nothing, giving neither is refused", () => {
    const [first, second] = [
      { on: "2026-10-04", reason: "Printed on the July statement." },
      { on: "2026-10-05", reason: READ_IT },
    ];
    const twins = [line({ acknowledged: first }), line({ rowId: "row-twin", acknowledged: second })];
    const mark = leftOutToken(line());
    for (const { reason } of [first, second]) {
      const plan = planAcknowledging(twins, [mark], { on: "2026-10-06", reason });
      expect([plan.open, plan.unmatched, plan.reasonsKept]).toEqual([[], [], []]);
      expect(plan.lines).toEqual([
        `${mark}: acknowledged already, nothing to write — Acknowledged on 2026-10-04: Printed on the July statement.`,
        `${mark}: acknowledged already, nothing to write — Acknowledged on 2026-10-05: ${READ_IT}`,
      ]);
    }
    const neither = planAcknowledging(twins, [mark], { on: "2026-10-06", reason: "My own words for it." });
    expect(neither.reasonsKept).toEqual([{ mark, stored: [first, second] }]);
    expect(reasonChangeRefusal(neither.reasonsKept).slice(1)).toEqual([
      `  ${mark}: Acknowledged on 2026-10-04: Printed on the July statement.`,
      `  ${mark}: Acknowledged on 2026-10-05: ${READ_IT}`,
    ]);
  });

  test("⛔ lines alike with two reasons, one left open: either reason stored acknowledges it — never a third", () => {
    const [first, second] = [
      { on: "2026-10-04", reason: "Printed on the July statement." },
      { on: "2026-10-05", reason: READ_IT },
    ];
    const lines = [
      line({ acknowledged: first }),
      line({ rowId: "row-twin", acknowledged: second }),
      line({ rowId: "row-third" }),
    ];
    const mark = leftOutToken(line());
    for (const { reason } of [first, second]) {
      const acknowledging = { on: "2026-10-06", reason };
      const plan = planAcknowledging(lines, [mark], acknowledging);
      expect(plan.reasonsKept).toEqual([]);
      expect(plan.open).toEqual([lines[2]]);
      expect(acknowledgementWrites(plan.open, acknowledging).map((w) => w.reason)).toEqual([reason]);
    }
    const third = planAcknowledging(lines, [mark], { on: "2026-10-06", reason: "My own words for it." });
    expect(third.open).toEqual([]);
    expect(third.reasonsKept).toEqual([{ mark, stored: [first, second] }]);
    // the dry run with no reason says each, and that --confirm takes one of them, exactly as the shell reads it
    const dry = planAcknowledging(lines, [mark], { on: "2026-10-06", reason: null });
    expect(dry.open).toEqual([lines[2]]);
    expect(dry.lines.at(-1)).toBe(
      `${mark}: stores no reason yet — --confirm needs a reason its lines alike carry, exactly: ` +
        "--reason='Printed on the July statement.' or --reason='July statement, page 1: the bank'\\''s opening deposit, " +
        "reversed the same day by the card it came from', printed with the line from then on",
    );
  });

  /*
   * 🔴 Beside two reasons stored, a run giving a third was told "--reason is not the reason stored, which stays", and
   * refused as one that "never changes a stored one nor gives lines alike two" — as if one were stored, and its lines
   * alike did not carry two already. Worded by how many are stored now; one stored reads as it did (above).
   */
  test("⛔ another reason beside two stored: said and refused by their count — never 'the reason stored'", () => {
    const [first, second] = [
      { on: "2026-10-04", reason: "Printed on the July statement." },
      { on: "2026-10-05", reason: READ_IT },
    ];
    const twins = [line({ acknowledged: first }), line({ rowId: "row-twin", acknowledged: second })];
    const mark = leftOutToken(line());
    const another = { on: "2026-10-06", reason: "My own words for it." };
    const all = planAcknowledging(twins, [mark], another);
    expect(all.lines).toEqual([
      `${mark}: acknowledged already, and --reason is not one of the 2 reasons stored, which stay: this step never ` +
        "changes a stored one — Acknowledged on 2026-10-04: Printed on the July statement.",
      `${mark}: acknowledged already, and --reason is not one of the 2 reasons stored, which stay: this step never ` +
        `changes a stored one — Acknowledged on 2026-10-05: ${READ_IT}`,
    ]);
    const refused =
      "REFUSED: --reason is not one of the 2 reasons stored, and this step never changes a stored one nor gives lines " +
      "alike another — nothing was written. Stored:";
    expect(reasonChangeRefusal(all.reasonsKept)[0]).toBe(refused);
    // one left open beside them: each reason stored is said with how many lines carry it, in the count's words too
    const partly = planAcknowledging([...twins, line({ rowId: "row-third" })], [mark], another);
    expect(partly.lines).toEqual([
      `${mark}: 1 of its 3 lines alike acknowledged already, and --reason is not one of the 2 reasons stored, which ` +
        "stay: this step never changes a stored one nor gives lines alike another — Acknowledged on 2026-10-04: " +
        "Printed on the July statement.",
      `${mark}: 1 of its 3 lines alike acknowledged already, and --reason is not one of the 2 reasons stored, which ` +
        `stay: this step never changes a stored one nor gives lines alike another — Acknowledged on 2026-10-05: ${READ_IT}`,
    ]);
    expect(reasonChangeRefusal(partly.reasonsKept)[0]).toBe(refused);
  });

  /*
   * The day is in the key: two lines alike but for the day the file prints are two lines — two marks, and an
   * acknowledgement of one never covers the other, beside it or alone.
   */
  test("⛔ two lines alike but for the day: two marks, and acknowledging one leaves the other failing", () => {
    const first = line().printings[0]!;
    const nextDay = line({ rowId: "row-next-day", printedOn: "2026-07-28", printings: [{ ...first, printedOn: "2026-07-28" }] });
    expect(leftOutToken(nextDay)).not.toBe(leftOutToken(line()));
    const plan = planAcknowledging([line(), nextDay], [leftOutToken(line())], TODAY);
    expect(plan.open).toEqual([line()]);
    const written = acknowledgementWrites(plan.open, TODAY).map((w) => ({ ...w, id: "ack-1", createdAt: "2026-10-05T16:00:00.000Z" }));
    for (const lines of [[line(), nextDay], [nextDay, line()]]) {
      const { byRow, unmatched } = acknowledgementsOf(lines, written);
      expect([...byRow.keys()]).toEqual(["row-opening"]);
      expect(unmatched).toEqual([]);
    }
    expect(acknowledgementsOf([nextDay], written).byRow.size).toBe(0);
  });

  test("⛔ a mark no line left out carries is unmatched — the command refuses the whole write", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line()), "0123456789"], TODAY);
    expect(plan.unmatched).toEqual(["0123456789"]);
    expect(plan.lines).toContain("0123456789: no line left out carries this mark — the ledger moved, or it was mistyped");
  });
});

/**
 * The words a shell reads in `text`: split at whitespace, `'…'` kept literally with its quotes gone, `\x` outside quotes
 * an x — so `--reason='the bank'\''s deposit'` is ONE argument, `--reason=the bank's deposit`.
 */
const shellWords = (text: string): string[] => {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error(`an unclosed quote: ${text}`);
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (c === "\\") {
      word = (word ?? "") + text[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  return word === null ? words : [...words, word];
};

/** the arguments a printed run passes, as the shell reads them */
const shellArgs = (text: string): string[] => shellWords(text).filter((word) => word.startsWith("--"));

/**
 * Every run a dry run's last words name, as the command line it is, each with the runs it may be swapped for — a line
 * "or …" names one in place of the run above it. "The same command with <args>" adds them to the dry run's own, on its
 * line or on the lines below it; one run a mark, each on its own line, takes those in place of the dry run's.
 */
const runsNamed = (step: readonly string[], dryRun: readonly string[]): string[][][] => {
  const [said, ...below] = step;
  if (below.length === 0) return [[[...dryRun, ...shellArgs(said!.slice(said!.indexOf("the same command with ")))]]];
  // its header may go on to say why a mark has an "or" below its run
  const inPlace = said!.includes("in place of its own");
  const runs: string[][][] = [];
  for (const text of below) {
    const run = inPlace ? shellArgs(text) : [...dryRun, ...shellArgs(text)];
    if (/^\s*or /.test(text)) runs.at(-1)!.push(run);
    else runs.push([run]);
  }
  return runs;
};

describe("confirmingStep — what a dry run ends with: the run that confirms it", () => {
  const COFFEE = line({
    rowId: "row-coffee",
    amountCents: -1000,
    description: "Coffee Roasters 12",
    printings: [{ sha256: RE_DOWNLOAD, printedOn: "2026-07-27", words: "COFFEE ROASTERS 12" }],
  });
  const [OPENING_MARK, COFFEE_MARK] = [leftOutToken(line()), leftOutToken(COFFEE)];
  const ONE_A_RUN =
    "Only once each line is read on its statement, one run a mark — a reason says what ONE line is: the same command " +
    "with these arguments in place of its own:";
  /*
   * 🔴 Several marks, one with lines alike carrying two reasons: its runs came "or" one below the other under a header
   * that said only "one run a mark" — never why a mark had two, nor that its open lines take one of them. One mark alone
   * says so (below); several say it in one sentence more, and only when an "or" follows.
   */
  const ONE_A_RUN_OR =
    "Only once each line is read on its statement, one run a mark — a reason says what ONE line is: the same command " +
    'with these arguments in place of its own. Where "or" follows a run, that mark\'s lines alike carry more than one ' +
    "reason, and its open lines take one of them, exactly, never another:";
  const runOf = (mark: string) => `    --acknowledge-left-out=${mark} --reason='<what the statement shows>' --confirm`;
  /** a plan's open lines, with no line alike acknowledged: no reason stored to name */
  const opened = (open: AcknowledgeableLine[]) => ({ open, reasonsStored: new Map<string, readonly string[]>() });
  /** READ_IT as a shell reads it back: its apostrophe closes the quote, is escaped, and opens it again */
  const READ_IT_QUOTED =
    "'July statement, page 1: the bank'\\''s opening deposit, reversed the same day by the card it came from'";

  test("one mark, no reason yet: the same command with what the statement shows, and --confirm", () => {
    expect(confirmingStep([OPENING_MARK], opened([line()]), null)).toEqual([
      "Only once each line is read on its statement: the same command with --reason='<what the statement shows>' --confirm",
    ]);
  });

  test("one mark with its reason: the same command with --confirm", () => {
    expect(confirmingStep([OPENING_MARK], opened([line()]), READ_IT)).toEqual([
      "Only once each line is read on its statement: the same command with --confirm",
    ]);
  });

  /*
   * 🔴 After two marks it said "the same command with --reason='<what the statement shows>' --confirm", and the command
   * line refuses a reason beside two marks — a reason says what ONE line is (`ledgerCheckMode`): the step it guided the
   * session to was a refusal, exit 2. Probe on a scratch ledger at 266be8e.
   */
  test("⛔ two marks: one run a mark, each with its own reason — never the same command with one reason for both", () => {
    expect(confirmingStep([OPENING_MARK, COFFEE_MARK], opened([line(), COFFEE]), null)).toEqual([
      ONE_A_RUN,
      runOf(OPENING_MARK),
      runOf(COFFEE_MARK),
    ]);
  });

  test("a mark whose lines are acknowledged already takes no run; two lines alike take one, under their one mark", () => {
    expect(confirmingStep([OPENING_MARK, COFFEE_MARK], opened([COFFEE]), null)).toEqual([ONE_A_RUN, runOf(COFFEE_MARK)]);
    const twins = [line(), line({ rowId: "row-twin" }), COFFEE];
    expect(confirmingStep([OPENING_MARK, COFFEE_MARK], opened(twins), null)).toEqual([
      ONE_A_RUN,
      runOf(OPENING_MARK),
      runOf(COFFEE_MARK),
    ]);
  });

  /*
   * 🔴 A mark partly acknowledged takes the reason its lines alike carry — another is refused (`planAcknowledging`) — and
   * its dry run still ended "the same command with --reason='<what the statement shows>' --confirm": run with the
   * session's own words, as it invited, it was refused, exit 2 (review of 9084a9c). The step names the reason stored
   * now, exactly, quoted as a shell reads it — in one run a mark too.
   */
  test("⛔ a mark partly acknowledged: its run gives the reason its lines alike carry, exactly — no placeholder", () => {
    const lines = [line({ acknowledged: { on: "2026-10-04", reason: READ_IT } }), line({ rowId: "row-twin" }), COFFEE];
    const one = planAcknowledging(lines, [OPENING_MARK], { on: "2026-10-05", reason: null });
    expect(confirmingStep([OPENING_MARK], one, null)).toEqual([
      `Only once each line is read on its statement: the same command with --reason=${READ_IT_QUOTED} --confirm`,
    ]);
    const both = planAcknowledging(lines, [OPENING_MARK, COFFEE_MARK], { on: "2026-10-05", reason: null });
    expect(confirmingStep([OPENING_MARK, COFFEE_MARK], both, null)).toEqual([
      ONE_A_RUN,
      `    --acknowledge-left-out=${OPENING_MARK} --reason=${READ_IT_QUOTED} --confirm`,
      runOf(COFFEE_MARK),
    ]);
  });

  /*
   * 🔴 Lines alike carrying two reasons take either for a line left open beside them (`planAcknowledging`), and the
   * step named only the first (`stored[0]`): a session whose statement read as the second was never told it is taken.
   * It names each now, exactly, as a shell reads it — one run, or the other in its place; never a third.
   */
  test("⛔ lines alike carrying two reasons: the run names each, exactly — one or the other, never a third", () => {
    const first = { on: "2026-10-04", reason: "Printed on the July statement." };
    const second = { on: "2026-10-05", reason: READ_IT };
    const lines = [
      line({ acknowledged: first }),
      line({ rowId: "row-twin", acknowledged: second }),
      line({ rowId: "row-third" }),
      COFFEE,
    ];
    const one = planAcknowledging(lines, [OPENING_MARK], { on: "2026-10-06", reason: null });
    expect(confirmingStep([OPENING_MARK], one, null)).toEqual([
      "Only once each line is read on its statement: the same command with one of these — its lines alike carry 2 " +
        "reasons, and its open lines take one of them, exactly, never another:",
      "    --reason='Printed on the July statement.' --confirm",
      `    or --reason=${READ_IT_QUOTED} --confirm`,
    ]);
    const both = planAcknowledging(lines, [OPENING_MARK, COFFEE_MARK], { on: "2026-10-06", reason: null });
    expect(confirmingStep([OPENING_MARK, COFFEE_MARK], both, null)).toEqual([
      ONE_A_RUN_OR,
      `    --acknowledge-left-out=${OPENING_MARK} --reason='Printed on the July statement.' --confirm`,
      `    or --acknowledge-left-out=${OPENING_MARK} --reason=${READ_IT_QUOTED} --confirm`,
      runOf(COFFEE_MARK),
    ]);
  });

  /*
   * ⛔ The runs it names are runs the PLAN takes, not only the command line: each, planned again against the same lines,
   * refuses nothing — no mark unmatched, no reason another — and together they acknowledge every line the dry run would.
   */
  test("⛔ every run it names is a --confirm the plan refuses nothing of — together, every open line", () => {
    const done = line({ acknowledged: { on: "2026-10-04", reason: "Printed on the July statement." } });
    const twins = [line(), line({ rowId: "row-twin" })];
    // a mark partly acknowledged, its reason one a shell must quote; and lines alike carrying two reasons, one open
    const partly = [line({ acknowledged: { on: "2026-10-04", reason: READ_IT } }), line({ rowId: "row-twin" })];
    const two = [
      done,
      line({ rowId: "row-twin", acknowledged: { on: "2026-10-05", reason: READ_IT } }),
      line({ rowId: "row-third" }),
    ];
    const ledgers: [AcknowledgeableLine[], string[], string | null][] = [
      [[line()], [OPENING_MARK], null],
      [[line()], [OPENING_MARK], READ_IT],
      [twins, [OPENING_MARK], null],
      [[line(), COFFEE], [OPENING_MARK, COFFEE_MARK], null],
      [[done, COFFEE], [OPENING_MARK, COFFEE_MARK], null],
      [[...twins, COFFEE], [COFFEE_MARK, OPENING_MARK], null],
      [partly, [OPENING_MARK], null],
      [partly, [OPENING_MARK], READ_IT],
      [[...partly, COFFEE], [OPENING_MARK, COFFEE_MARK], null],
      [two, [OPENING_MARK], null],
      [[...two, COFFEE], [COFFEE_MARK, OPENING_MARK], null],
    ];
    const rows = (open: readonly AcknowledgeableLine[]) => open.map((l) => l.rowId).sort();
    for (const [lines, marks, reason] of ledgers) {
      const dryRun = [`--acknowledge-left-out=${marks.join(",")}`, ...(reason === null ? [] : [`--reason=${reason}`])];
      expect(ledgerCheckMode(dryRun)).toMatchObject({ mode: "acknowledge", confirm: false });
      const plan = planAcknowledging(lines, marks, { on: "2026-10-05", reason });
      expect([plan.unmatched, plan.reasonsKept]).toEqual([[], []]);
      const planned = runsNamed(confirmingStep(marks, plan, reason), dryRun).map((alternatives) =>
        alternatives.map((args) => {
          const mode = ledgerCheckMode(args);
          if (mode.mode !== "acknowledge" || !mode.confirm) throw new Error(`not a --confirm: ${args.join(" ")}`);
          return planAcknowledging(lines, mode.tokens, { on: "2026-10-06", reason: mode.reason });
        }),
      );
      for (const run of planned.flat()) expect([run.unmatched, run.reasonsKept]).toEqual([[], []]);
      // a run named in another's place acknowledges the very lines that one does
      for (const [run, ...others] of planned) for (const other of others) expect(rows(other.open)).toEqual(rows(run!.open));
      expect(rows(planned.flatMap(([run]) => run!.open))).toEqual(rows(plan.open));
    }
  });

  /*
   * How lines alike come to carry two reasons with no run of this step giving them two: three lines alike, printed by
   * two files; one acknowledged under its own mark, and an acknowledgement keyed under the other file — given for a line
   * only that file printed, back in the ledger since — free for the second (`acknowledgementsOf`); the third left out
   * after both. The review of 9084a9c reached it so: every --reason was refused, and the third failed for good.
   */
  test("⛔ lines alike the matching gave two reasons: the run their dry run names acknowledges the one left open", () => {
    const words = "WFB OPENING DEPOSIT FROM CARD";
    const printings = [
      { sha256: STATEMENT, printedOn: "2026-07-27", words },
      { sha256: RE_DOWNLOAD, printedOn: "2026-07-27", words },
    ];
    const alike = (rowId: string, rowWrittenAt: string) => line({ rowId, rowWrittenAt, printings });
    // the first two left out before both acknowledgements, the third after
    const lines = [
      alike("row-a", "2026-09-20T14:00:00.000Z"),
      alike("row-b", "2026-09-20T14:00:00.000Z"),
      alike("row-c", "2026-10-06T09:00:00.000Z"),
    ];
    const own = ack({
      id: "ack-own",
      printerSha256: STATEMENT,
      acknowledgedOn: "2026-10-04",
      reason: "Printed on the July statement.",
      createdAt: "2026-10-04T16:00:00.000Z",
    });
    const another = ack({ id: "ack-another", printerSha256: RE_DOWNLOAD, createdAt: "2026-10-05T16:00:00.000Z" });
    const { byRow } = acknowledgementsOf(lines, [own, another]);
    const read = lines.map((l) => ({ ...l, acknowledged: byRow.has(l.rowId) ? acknowledgedOf(byRow.get(l.rowId)!) : null }));
    expect(read.map((l) => l.acknowledged?.reason ?? null)).toEqual(["Printed on the July statement.", READ_IT, null]);

    const mark = leftOutToken(lines[0]!);
    const plan = planAcknowledging(read, [mark], { on: "2026-10-06", reason: null });
    const [alternatives] = runsNamed(confirmingStep([mark], plan, null), [`--acknowledge-left-out=${mark}`]);
    const runs = alternatives!.map((args) => {
      const run = ledgerCheckMode(args);
      if (run.mode !== "acknowledge" || !run.confirm) throw new Error(`not a --confirm: ${args.join(" ")}`);
      return run;
    });
    // each reason they carry, either taking the line left open
    expect(runs.map((run) => run.reason)).toEqual(["Printed on the July statement.", READ_IT]);
    for (const run of runs) {
      const confirmed = planAcknowledging(read, run.tokens, { on: "2026-10-06", reason: run.reason });
      expect(confirmed.reasonsKept).toEqual([]);
      expect(confirmed.open.map((l) => l.rowId)).toEqual(["row-c"]);
    }
  });
});

describe("unmatchedAcknowledgementNotice — an acknowledgement no line matches now", () => {
  test("names the line it was given for, that it hides nothing, and what the session read", () => {
    expect(unmatchedAcknowledgementNotice(ack(), "Wells Fargo Everyday Checking")).toBe(
      "+$25.00 on 2026-07-27, WFB Opening Deposit From Card, on Wells Fargo Everyday Checking — no line left out matches " +
        `it now, so it hides nothing. Acknowledged on 2026-10-05: ${READ_IT}`,
    );
  });
});
