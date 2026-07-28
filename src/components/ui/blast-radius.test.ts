import { describe, expect, it } from "vitest";
import { blastRadiusSentence, countPhrase } from "./blast-radius";

describe("countPhrase", () => {
  it("singularises exactly one", () => {
    expect(countPhrase(1, "transaction")).toBe("1 transaction");
  });

  it("pluralises everything else", () => {
    expect(countPhrase(2, "transaction")).toBe("2 transactions");
  });

  it("says 'no X' rather than '0 X' — the blast radius reads as prose", () => {
    expect(countPhrase(0, "transaction")).toBe("no transactions");
  });

  it("groups thousands: the owner's real import file owns four figures of rows", () => {
    expect(countPhrase(1_332, "transaction")).toBe("1,332 transactions");
  });

  it("takes an irregular plural", () => {
    expect(countPhrase(3, "day", "days")).toBe("3 days");
    expect(countPhrase(2, "entry", "entries")).toBe("2 entries");
    expect(countPhrase(1, "entry", "entries")).toBe("1 entry");
  });

  it("rejects a non-count — a wrong number in a confirm is worse than none", () => {
    expect(() => countPhrase(-1, "transaction")).toThrow(RangeError);
    expect(() => countPhrase(1.5, "transaction")).toThrow(RangeError);
    expect(() => countPhrase(Number.NaN, "transaction")).toThrow(RangeError);
    expect(() => countPhrase(Number.POSITIVE_INFINITY, "transaction")).toThrow(RangeError);
  });
});

describe("blastRadiusSentence", () => {
  it("states the headline alone when there is nothing to measure", () => {
    expect(blastRadiusSentence({ headline: "This deletes the file" })).toBe(
      "This deletes the file.",
    );
  });

  it("keeps the headline's own terminator", () => {
    expect(blastRadiusSentence({ headline: "Delete everything?" })).toBe("Delete everything?");
    expect(blastRadiusSentence({ headline: "Gone!" })).toBe("Gone!");
    expect(blastRadiusSentence({ headline: "Already stopped." })).toBe("Already stopped.");
  });

  it("reads every measured line as label: value, in order", () => {
    expect(
      blastRadiusSentence({
        headline: "Un-importing deletes this file's rows",
        lines: [
          { label: "Transactions deleted", value: "1,332 transactions" },
          { label: "Categorized by you", value: "421 of them", irreversible: true },
          { label: "Money removed", value: "$12,345.67 in · $8,910.11 out" },
        ],
      }),
    ).toBe(
      "Un-importing deletes this file's rows. Transactions deleted: 1,332 transactions. " +
        "Categorized by you: 421 of them. Money removed: $12,345.67 in · $8,910.11 out.",
    );
  });

  it("puts what survives last — the honest counterweight to the loss", () => {
    expect(
      blastRadiusSentence({
        headline: "This removes the anchor",
        lines: [{ label: "Balance removed", value: "$4,231.00" }],
        reassurance: "Balance history is derived — it rebuilds from what is left",
      }),
    ).toBe(
      "This removes the anchor. Balance removed: $4,231.00. " +
        "Balance history is derived — it rebuilds from what is left.",
    );
  });

  it("drops blank parts instead of emitting a bare full stop", () => {
    expect(
      blastRadiusSentence({
        headline: "Archiving hides the account",
        lines: [{ label: "Net worth will read", value: "$1,200.00 higher" }],
        reassurance: "   ",
      }),
    ).toBe("Archiving hides the account. Net worth will read: $1,200.00 higher.");
  });

  it("trims each part so a stray newline in the copy never leaks into speech", () => {
    expect(
      blastRadiusSentence({
        headline: "  Deactivating stops the budget  ",
        lines: [{ label: " Budget ", value: " $600.00/mo " }],
      }),
    ).toBe("Deactivating stops the budget. Budget: $600.00/mo.");
  });

  it("treats an empty line list as no lines", () => {
    expect(blastRadiusSentence({ headline: "Nothing measured", lines: [] })).toBe(
      "Nothing measured.",
    );
  });
});
