import { describe, expect, test } from "vitest";
import { diffKeyed, matchPrintedLines, type LedgerLeg, type PrintedLine } from "./sapphire-printed-lines";

/**
 * Every shape below is one the 19 Chase Sapphire statements actually print, or
 * one the 36 hand-reconstructed payment rows actually hold. The stakes are
 * asymmetric: attaching a row to a line that records DIFFERENT money would put
 * a statement badge on money no statement proves, while leaving a row
 * unattached only keeps it hand-entered.
 */

let order = 0;
const line = (day: string, amountCents: number, fileId = "f-2026-03", periodStart = "2026-02-03"): PrintedLine => ({
  fileId,
  fileName: `${fileId}.pdf`,
  periodStart,
  periodEnd: "2026-03-02",
  day,
  amountCents,
  description: "Payment Thank You-Mobile",
  order: order++,
});
const leg = (id: string, postedOn: string, amountCents: number, extra: Partial<LedgerLeg> = {}): LedgerLeg => ({
  id,
  postedOn,
  transactedOn: null,
  amountCents,
  occurrenceIndex: 0,
  ...extra,
});
const attached = (result: ReturnType<typeof matchPrintedLines>) =>
  result.attachments.map((a) => [a.rowId, a.line.day, a.lens]);

describe("matchPrintedLines", () => {
  test("attaches a hand row to the line printed on its posted day", () => {
    // 2026-02-13 +$300.00: printed "02/13 Payment Thank You-Mobile -300.00"
    const result = matchPrintedLines([line("2026-02-13", 30000)], [], [leg("hand", "2026-02-13", 30000)]);
    expect(attached(result)).toEqual([["hand", "2026-02-13", "posted"]]);
    expect(result.unprinted).toEqual([]);
    expect(result.unclaimedLines).toEqual([]);
  });

  test("falls back to the transaction day — the row posted 07/01 that Chase prints as 06/30", () => {
    const result = matchPrintedLines(
      [line("2026-06-30", 10000)],
      [],
      [leg("hand", "2026-07-01", 10000, { transactedOn: "2026-06-30" })],
    );
    expect(attached(result)).toEqual([["hand", "2026-06-30", "transacted"]]);
  });

  test("never hands a hand row a line a statement-backed row already records", () => {
    // 2025-02-11 prints -350.00 AND -300.00; the $300.00 is already a statement row
    const result = matchPrintedLines(
      [line("2025-02-11", 35000), line("2025-02-11", 30000)],
      [leg("backed", "2025-02-11", 30000, { transactedOn: "2025-02-11" })],
      [leg("hand-350", "2025-02-11", 35000), leg("hand-300", "2025-02-11", 30000)],
    );
    expect(attached(result)).toEqual([["hand-350", "2025-02-11", "posted"]]);
    expect(result.unprinted.map((r) => r.id)).toEqual(["hand-300"]);
  });

  test("one printed line, two identical hand rows: the first occurrence attaches, the second is unprinted", () => {
    // 2026-03-02: two +$115.00 rows, one "03/02 Payment Thank You-Mobile -115.00"
    const result = matchPrintedLines(
      [line("2026-03-02", 11500)],
      [],
      [
        leg("occ1", "2026-03-02", 11500, { occurrenceIndex: 1 }),
        leg("occ0", "2026-03-02", 11500, { occurrenceIndex: 0 }),
      ],
    );
    expect(attached(result)).toEqual([["occ0", "2026-03-02", "posted"]]);
    expect(result.unprinted.map((r) => r.id)).toEqual(["occ1"]);
  });

  test("a hand-made reversal with no printed line stays unprinted — sign is part of the money", () => {
    const result = matchPrintedLines(
      [line("2026-03-02", 11500)],
      [],
      [leg("cancelled", "2026-03-02", -11500), leg("payment", "2026-03-02", 11500)],
    );
    expect(attached(result)).toEqual([["payment", "2026-03-02", "posted"]]);
    expect(result.unprinted.map((r) => r.id)).toEqual(["cancelled"]);
  });

  test("a line is claimed at most once even when two statements print the same day and amount", () => {
    const result = matchPrintedLines(
      [line("2025-07-02", 10000, "f-2025-07", "2025-06-03"), line("2025-07-02", 10000, "f-2025-08", "2025-07-03")],
      [],
      [leg("only", "2025-07-02", 10000)],
    );
    expect(attached(result)).toEqual([["only", "2025-07-02", "posted"]]);
    expect(result.attachments[0]!.line.fileId).toBe("f-2025-07");
    expect(result.unclaimedLines.map((l) => l.fileId)).toEqual(["f-2025-08"]);
  });

  test("a row's transaction day outranks a neighbour's posted day — the dense-fare shape", () => {
    // Measured on 20250402: RAM`S VILLAGE -1.04 printed 03/22 and 03/26; the
    // Spending Report rows are posted 03/24 (tx 03/22) and 03/28 (tx 03/26),
    // and a third -1.04 row is posted 03/26 (tx 03/24). Posted-first handed that
    // third row the 03/26 line and stranded its real owner.
    const result = matchPrintedLines(
      [line("2025-03-22", -104), line("2025-03-26", -104)],
      [],
      [
        leg("tx0322", "2025-03-24", -104, { transactedOn: "2025-03-22" }),
        leg("tx0324", "2025-03-26", -104, { transactedOn: "2025-03-24" }),
        leg("tx0326", "2025-03-28", -104, { transactedOn: "2025-03-26" }),
      ],
    );
    expect(attached(result).sort()).toEqual([
      ["tx0322", "2025-03-22", "transacted"],
      ["tx0326", "2025-03-26", "transacted"],
    ]);
    expect(result.unclaimedLines).toEqual([]);
  });

  test("a row with a transaction day still falls back to its posted day when nothing else claims it", () => {
    const result = matchPrintedLines([line("2025-07-03", 10000)], [], [leg("hand", "2025-07-03", 10000, { transactedOn: "2025-07-02" })]);
    expect(attached(result)).toEqual([["hand", "2025-07-03", "posted"]]);
  });

  test("a row whose day matches but amount differs is not attached", () => {
    const result = matchPrintedLines([line("2025-09-12", 6109)], [], [leg("hand", "2025-09-12", 1040)]);
    expect(result.attachments).toEqual([]);
    expect(result.unclaimedLines).toHaveLength(1);
  });
});

describe("diffKeyed", () => {
  test("reports changed, removed and added keys separately", () => {
    const before = new Map([
      ["2026-03-01", "-11500|derived"],
      ["2026-03-02", "0|anchored"],
      ["2026-03-03", "0|derived"],
    ]);
    const after = new Map([
      ["2026-03-01", "-11500|derived"],
      ["2026-03-02", "11500|anchored"],
      ["2026-03-04", "0|carried"],
    ]);
    expect(diffKeyed(before, after)).toEqual({
      changed: [{ key: "2026-03-02", before: "0|anchored", after: "11500|anchored" }],
      removed: ["2026-03-03"],
      added: ["2026-03-04"],
    });
  });

  test("identical maps diff to nothing", () => {
    const m = new Map([["a", 1]]);
    expect(diffKeyed(m, new Map(m))).toEqual({ changed: [], removed: [], added: [] });
  });
});
