import { describe, expect, test } from "vitest";
import { assignOccurrenceIndexes, dedupeHash, fileSha256 } from "./hash";

const base = {
  accountId: "acct-1",
  postedOn: "2026-06-30",
  amountCents: -1_299,
  rawDescription: "STARBUCKS #123 SEATTLE WA",
  occurrenceIndex: 0,
};

describe("dedupeHash", () => {
  test("is deterministic", () => {
    expect(dedupeHash(base)).toBe(dedupeHash({ ...base }));
    expect(dedupeHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("every identity field changes the hash", () => {
    const variants = [
      { ...base, accountId: "acct-2" },
      { ...base, postedOn: "2026-07-01" },
      { ...base, amountCents: -1_300 },
      { ...base, rawDescription: "STARBUCKS #124 SEATTLE WA" },
      { ...base, occurrenceIndex: 1 },
    ];
    const hashes = new Set([dedupeHash(base), ...variants.map(dedupeHash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  test("field boundaries cannot collide (separator safety)", () => {
    // without a separator, "12" + "3..." could equal "1" + "23..."
    const a = dedupeHash({ ...base, postedOn: "2026-06-30", rawDescription: "1AB" });
    const b = dedupeHash({ ...base, postedOn: "2026-06-301", rawDescription: "AB" });
    expect(a).not.toBe(b);
  });

  test("separator injection in untrusted descriptions cannot shift field boundaries", () => {
    // length-prefixed canonicalization: even a description containing the
    // separator itself cannot forge another identity's encoding
    const a = dedupeHash({ ...base, postedOn: "2026-06-30", rawDescription: "A\x1fB" });
    const b = dedupeHash({ ...base, postedOn: "2026-06-30\x1fA", rawDescription: "B" });
    expect(a).not.toBe(b);
    const c = dedupeHash({ ...base, rawDescription: "5:HELLO" });
    const d = dedupeHash({ ...base, rawDescription: "HELLO" });
    expect(c).not.toBe(d);
  });
});

describe("assignOccurrenceIndexes", () => {
  const key = (r: { desc: string; amount: number }) => ({
    accountId: "acct-1",
    postedOn: "2026-06-30",
    amountCents: r.amount,
    rawDescription: r.desc,
  });

  test("identical rows number 0..n−1 in file-row order", () => {
    const rows = [
      { desc: "COFFEE", amount: -575 },
      { desc: "COFFEE", amount: -575 },
      { desc: "COFFEE", amount: -575 },
    ];
    const out = assignOccurrenceIndexes(rows, key);
    expect(out.map((o) => o.occurrenceIndex)).toEqual([0, 1, 2]);
    expect(out.map((o) => o.row)).toEqual(rows); // order preserved
  });

  test("distinct rows all get index 0", () => {
    const rows = [
      { desc: "COFFEE", amount: -575 },
      { desc: "LUNCH", amount: -575 },
      { desc: "COFFEE", amount: -600 },
    ];
    expect(assignOccurrenceIndexes(rows, key).map((o) => o.occurrenceIndex)).toEqual([0, 0, 0]);
  });

  test("interleaved duplicates count per identity", () => {
    const rows = [
      { desc: "COFFEE", amount: -575 },
      { desc: "LUNCH", amount: -1200 },
      { desc: "COFFEE", amount: -575 },
    ];
    expect(assignOccurrenceIndexes(rows, key).map((o) => o.occurrenceIndex)).toEqual([0, 0, 1]);
  });

  test("truncated-chunk scenario: a file containing one copy always maps to index 0", () => {
    // File A had two identical charges (indexes 0,1). A later truncated file B
    // carries only one copy — it must deterministically get index 0 so it
    // collides with the existing row instead of inserting a third copy.
    const fileB = [{ desc: "COFFEE", amount: -575 }];
    expect(assignOccurrenceIndexes(fileB, key)[0]?.occurrenceIndex).toBe(0);
  });
});

describe("fileSha256", () => {
  test("hashes strings and buffers identically", () => {
    expect(fileSha256("abc")).toBe(fileSha256(Buffer.from("abc")));
    expect(fileSha256("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(fileSha256("abc")).not.toBe(fileSha256("abd"));
  });
});
