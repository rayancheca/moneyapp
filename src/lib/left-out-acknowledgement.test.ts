import { describe, expect, test } from "vitest";
import { lineLeftOutNotice } from "./import-file-label";
import {
  acknowledgementsOf,
  leftOutToken,
  planAcknowledging,
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

/** the rehearsal of 2026-09-28: a re-read of the export drops the account's +$25.00 opening deposit */
const line = (over: Partial<AcknowledgeableLine> = {}): AcknowledgeableLine => ({
  accountId: WF,
  accountName: "Wells Fargo Everyday Checking",
  printedOn: "2026-07-27",
  amountCents: 2500,
  description: "WFB Opening Deposit From Card",
  printedBy: ["wf-export (1).csv"],
  readBy: "wf-export.csv",
  acknowledgedOn: null,
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
  test("a line's mark acknowledges it: the write keys it by its first printer, and says the line it is", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line())], "2026-10-05");
    expect(plan.writes).toEqual([
      {
        accountId: WF,
        printedOn: "2026-07-27",
        amountCents: 2500,
        printedWords: "WFB OPENING DEPOSIT FROM CARD",
        printerSha256: RE_DOWNLOAD,
        description: "WFB Opening Deposit From Card",
        acknowledgedOn: "2026-10-05",
      },
    ]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.lines).toEqual([`${leftOutToken(line())}: acknowledges ${lineLeftOutNotice(line())}`]);
  });

  test("two lines alike share a mark, and it acknowledges both — one write each", () => {
    const twins = [line(), line({ rowId: "row-twin" })];
    const plan = planAcknowledging(twins, [leftOutToken(line())], "2026-10-05");
    expect(plan.writes).toHaveLength(2);
    expect(plan.lines[0]).toMatch(/: acknowledges 2 lines alike — /);
  });

  test("a line acknowledged already is said, and written again never", () => {
    const done = line({ acknowledgedOn: "2026-10-04" });
    const plan = planAcknowledging([done], [leftOutToken(done)], "2026-10-05");
    expect(plan.writes).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.lines).toEqual([`${leftOutToken(done)}: acknowledged on 2026-10-04 already — nothing to write`]);
  });

  test("⛔ a mark no line left out carries is unmatched — the command refuses the whole write", () => {
    const plan = planAcknowledging([line()], [leftOutToken(line()), "0123456789"], "2026-10-05");
    expect(plan.unmatched).toEqual(["0123456789"]);
    expect(plan.lines).toContain("0123456789: no line left out carries this mark — the ledger moved, or it was mistyped");
  });
});
