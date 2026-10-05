import { describe, expect, test } from "vitest";
import { lineLeftOutNotice } from "./import-file-label";
import {
  acknowledgementWrites,
  acknowledgementsOf,
  leftOutToken,
  planAcknowledging,
  unmatchedAcknowledgementNotice,
  type AcknowledgeableLine,
  type LeftOutAcknowledgement,
} from "./left-out-acknowledgement";

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
    const stored = `Acknowledged on 2026-10-05: ${READ_IT}.`;
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
    const plan = planAcknowledging([done], [leftOutToken(done)], TODAY);
    expect(plan.open).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.lines).toEqual([
      `${leftOutToken(done)}: acknowledged already, nothing to write — Acknowledged on 2026-10-04: Printed on the July statement.`,
    ]);
  });

  test("⛔ a mark no line left out carries is unmatched — the command refuses the whole write", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line()), "0123456789"], TODAY);
    expect(plan.unmatched).toEqual(["0123456789"]);
    expect(plan.lines).toContain("0123456789: no line left out carries this mark — the ledger moved, or it was mistyped");
  });
});

describe("unmatchedAcknowledgementNotice — an acknowledgement no line matches now", () => {
  test("names the line it was given for, that it hides nothing, and what the session read", () => {
    expect(unmatchedAcknowledgementNotice(ack(), "Wells Fargo Everyday Checking")).toBe(
      "+$25.00 on 2026-07-27, WFB Opening Deposit From Card, on Wells Fargo Everyday Checking — no line left out matches " +
        `it now, so it hides nothing. Acknowledged on 2026-10-05: ${READ_IT}.`,
    );
  });
});
