import { describe, expect, it } from "vitest";
import type { LedgerObservation } from "./ledger-integrity";
import {
  WITNESS_KINDS,
  WitnessFlagRefusal,
  compareToMarks,
  ledgerCheckMode,
  marksFromRows,
  planLowering,
  witnessesOf,
  type WitnessMarks,
} from "./witness-floor";

/*
 * The identities below are the owner's ledger's own, read off a `.backup` copy
 * on 2026-09-15: Robinhood Brokerage's first statement closes 2024-08-31, and
 * Chase Checking's 2022 statements anchor on 2022-08-24, 2022-09-13, 2022-10-13,
 * 2022-11-10, 2022-12-12 and 2023-01-12 (their file names carry the days).
 */
const B = "Robinhood Brokerage";
const CC = "Chase Checking";

const observation = (over: Partial<LedgerObservation> = {}): LedgerObservation => ({
  accounts: [],
  chainWindows: {},
  breaks: {},
  syntheticNetCents: {},
  staleVerdicts: [],
  valuedAnchorDays: {},
  valueAnchors: {},
  unpricedAnchors: [],
  gradedPeriods: {},
  ...over,
});

/** the marks a first run on `observed` would record */
const marksAt = (observed: LedgerObservation): WitnessMarks => compareToMarks(observed, {}).writes;

const LOWER_HOW =
  "A witness this check counted has left the ledger, and nothing it proved is being checked any more. " +
  "Find what removed it (an un-import, a deleted anchor, a removed account) before anything else; only if the " +
  "owner approved that removal, lower the mark:";

describe("witnessesOf — what each kind counts", () => {
  it("counts every statement day on an investment account, valued or not; every window walked; every period graded; every account read", () => {
    const seen = witnessesOf(
      observation({
        accounts: [B, "Cash on Hand"],
        chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] },
        gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
        valuedAnchorDays: { [B]: ["2024-09-30", "2024-08-31"] },
        // a statement the app could not value is still a statement that is there
        unpricedAnchors: [{ account: "Robinhood Crypto", on: "2025-10-31", printedCents: 150_500, derivedCents: null }],
      }),
    );
    expect(seen).toEqual({
      "value-anchors": [
        [B, "2024-08-31"],
        [B, "2024-09-30"],
        ["Robinhood Crypto", "2025-10-31"],
      ],
      "chain-windows": [[CC, "2022-08-24", "2022-09-13"]],
      "statement-periods": [[CC, "2022-08-25", "2022-09-13"]],
      accounts: [["Cash on Hand"], [B]],
    });
  });

  it("names the four kinds, in the order the summary prints them", () => {
    expect(WITNESS_KINDS).toEqual(["value-anchors", "chain-windows", "statement-periods", "accounts"]);
  });
});

describe("compareToMarks — a floor under every witness kind", () => {
  const today = observation({
    accounts: ["Cash on Hand", B],
    chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] },
    gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
    valuedAnchorDays: { [B]: ["2024-08-31"] },
  });

  it("a ledger with no marks records every kind at what it sees, and passes", () => {
    const result = compareToMarks(today, {});
    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({
      "value-anchors": { count: 1, witnesses: [[B, "2024-08-31"]] },
      "chain-windows": { count: 1, witnesses: [[CC, "2022-08-24", "2022-09-13"]] },
      "statement-periods": { count: 1, witnesses: [[CC, "2022-08-25", "2022-09-13"]] },
      accounts: { count: 2, witnesses: [["Cash on Hand"], [B]] },
    });
    expect(result.summary).toBe(
      "witness marks: value anchors 1 (recorded) · chain windows 1 (recorded) · statement periods 1 (recorded) · accounts 2 (recorded)",
    );
  });

  it("a count AT its mark holds — nothing is written and nothing fails", () => {
    const result = compareToMarks(today, marksAt(today));
    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({});
    expect(result.summary).toBe("witness marks: value anchors 1 · chain windows 1 · statement periods 1 · accounts 2");
  });

  it("⛔ a count ONE below its mark fails, naming the kind, the mark, the count, the witness that left and how to lower it", () => {
    const before = observation({ valuedAnchorDays: { [B]: ["2024-08-31", "2024-09-30"] } });
    const after = observation({ valuedAnchorDays: { [B]: ["2024-09-30"] } });

    const result = compareToMarks(after, marksAt(before));

    expect(result.failures).toEqual([
      {
        kind: "witness-drop",
        account: "value anchors",
        detail:
          "1 seen, below the mark of 2 — gone since the mark was set: Robinhood Brokerage 2024-08-31. " +
          `${LOWER_HOW} pnpm ledger-check --lower-marks=value-anchors, then the same with --confirm`,
      },
    ]);
    // the mark stays where it was: a drop never lowers it on its own
    expect(result.writes).toEqual({});
    expect(result.summary).toBe(
      "witness marks: value anchors 1 (below its mark of 2) · chain windows 0 · statement periods 0 · accounts 0",
    );
  });

  it("a count above its mark raises the mark to exactly what was seen, on its own", () => {
    const before = observation({ valuedAnchorDays: { [B]: ["2024-08-31"] } });
    const after = observation({ valuedAnchorDays: { [B]: ["2024-08-31", "2024-09-30"] } });

    const result = compareToMarks(after, marksAt(before));

    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({
      "value-anchors": { count: 2, witnesses: [[B, "2024-08-31"], [B, "2024-09-30"]] },
    });
    expect(result.summary).toBe(
      "witness marks: value anchors 2 (raised from 1) · chain windows 0 · statement periods 0 · accounts 0",
    );
  });

  it("each kind is floored on its own — one dropping neither stops another rising nor is hidden by it", () => {
    const before = observation({
      chainWindows: {
        [CC]: [
          { from: "2022-08-24", to: "2022-09-13" },
          { from: "2022-09-13", to: "2022-10-13" },
        ],
      },
      gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
    });
    const after = observation({
      chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-10-13" }] },
      gradedPeriods: {
        [CC]: [
          { periodStart: "2022-08-25", periodEnd: "2022-09-13" },
          { periodStart: "2022-09-14", periodEnd: "2022-10-13" },
        ],
      },
    });

    const result = compareToMarks(after, marksAt(before));

    expect(result.failures.map((f) => f.account)).toEqual(["chain windows"]);
    expect(result.failures[0]?.detail).toContain(
      "1 seen, below the mark of 2 — gone since the mark was set: Chase Checking 2022-08-24 → 2022-09-13, " +
        "Chase Checking 2022-09-13 → 2022-10-13. ",
    );
    expect(result.writes).toEqual({
      "statement-periods": {
        count: 2,
        witnesses: [
          [CC, "2022-08-25", "2022-09-13"],
          [CC, "2022-09-14", "2022-10-13"],
        ],
      },
    });
  });

  it("a chain window an arriving anchor divided is not gone — its span is still walked; a window no walk stops on is", () => {
    const marks: WitnessMarks = {
      "chain-windows": {
        count: 5,
        witnesses: [
          [CC, "2022-08-24", "2022-10-13"],
          [CC, "2022-10-13", "2022-11-10"],
          [CC, "2022-11-10", "2022-12-12"],
          [CC, "2022-12-12", "2023-01-12"],
          ["Discover", "2023-01-01", "2023-02-01"],
        ],
      },
    };
    const after = observation({
      chainWindows: {
        [CC]: [
          { from: "2022-08-24", to: "2022-09-13" },
          { from: "2022-09-13", to: "2022-10-13" },
          { from: "2022-10-13", to: "2022-12-12" },
        ],
      },
    });

    const [failure] = compareToMarks(after, marks).failures;

    expect(failure?.detail).toContain(
      "3 seen, below the mark of 5 — gone since the mark was set: " +
        "Chase Checking 2022-10-13 → 2022-11-10, Chase Checking 2022-11-10 → 2022-12-12, " +
        "Chase Checking 2022-12-12 → 2023-01-12, Discover 2023-01-01 → 2023-02-01. ",
    );
  });

  it("a witness recorded twice and seen once is gone once", () => {
    const marks: WitnessMarks = {
      "value-anchors": { count: 2, witnesses: [[B, "2024-08-31"], [B, "2024-08-31"]] },
    };
    const [failure] = compareToMarks(observation({ valuedAnchorDays: { [B]: ["2024-08-31"] } }), marks).failures;
    expect(failure?.detail).toContain("1 seen, below the mark of 2 — gone since the mark was set: Robinhood Brokerage 2024-08-31. ");
  });

  it("a drop whose mark's witnesses are all still accounted for says it cannot tell which left — and still fails", () => {
    const marks: WitnessMarks = {
      "chain-windows": { count: 2, witnesses: [[CC, "2022-08-24", "2022-09-13"], [CC, "2022-08-24", "2022-09-13"]] },
    };
    const after = observation({ chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] } });

    const { failures } = compareToMarks(after, marks);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain(
      "1 seen, below the mark of 2 — every witness the mark lists is still accounted for, so which one left cannot be told. ",
    );
  });

  it("names ten gone witnesses and counts the rest", () => {
    // the owner's thirteen accounts, as the check reads them
    const thirteen = [
      "Capital One 360 Checking",
      "Cash on Hand",
      CC,
      "Chase Sapphire",
      "Discover",
      "Robinhood Agentic",
      B,
      "Robinhood Cash",
      "Robinhood Crypto",
      "SoFi Checking",
      "SoFi Savings",
      "Venture X",
      "Wells Fargo Everyday Checking",
    ];
    const [failure] = compareToMarks(observation(), marksAt(observation({ accounts: thirteen }))).failures;
    expect(failure?.account).toBe("accounts");
    expect(failure?.detail).toContain(
      "0 seen, below the mark of 13 — gone since the mark was set: Capital One 360 Checking, Cash on Hand, " +
        "Chase Checking, Chase Sapphire, Discover, Robinhood Agentic, Robinhood Brokerage, Robinhood Cash, " +
        "Robinhood Crypto, SoFi Checking and 3 more. ",
    );
    expect(failure?.detail).toContain("pnpm ledger-check --lower-marks=accounts, then the same with --confirm");
  });
});

describe("planLowering — the guarded way down, after a removal the owner approved", () => {
  const seen = observation({
    valuedAnchorDays: { [B]: ["2024-09-30"] },
    chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] },
  });
  const marks: WitnessMarks = {
    "value-anchors": { count: 2, witnesses: [[B, "2024-08-31"], [B, "2024-09-30"]] },
    "chain-windows": { count: 1, witnesses: [[CC, "2022-08-24", "2022-09-13"]] },
  };

  it("lowers a named kind to exactly what is seen, and says what it forgets", () => {
    const plan = planLowering(seen, marks, ["value-anchors", "chain-windows", "statement-periods"]);
    expect(plan.writes).toEqual({ "value-anchors": { count: 1, witnesses: [[B, "2024-09-30"]] } });
    expect(plan.lines).toEqual([
      "value anchors: lowers its mark 2 → 1 — gone since the mark was set: Robinhood Brokerage 2024-08-31",
      "chain windows: 1 seen, mark 1 — not below it, nothing to lower",
      "statement periods: no mark recorded yet — nothing to lower (a plain run records one)",
    ]);
  });

  it("⛔ never raises — a kind seen above its mark is left for a plain run", () => {
    const plan = planLowering(seen, { "chain-windows": { count: 0, witnesses: [] } }, ["chain-windows"]);
    expect(plan.writes).toEqual({});
    expect(plan.lines).toEqual(["chain windows: 1 seen, mark 0 — not below it, nothing to lower"]);
  });

  it("⛔ touches only the kinds it was told to — a dropped kind nobody named keeps its mark", () => {
    expect(planLowering(seen, marks, ["chain-windows"]).writes).toEqual({});
  });
});

describe("ledgerCheckMode — the command line", () => {
  it("no arguments is the plain check the hook runs", () => {
    expect(ledgerCheckMode([])).toEqual({ mode: "check" });
  });

  it("--lower-marks=<kinds> is a dry run; --confirm makes it write", () => {
    expect(ledgerCheckMode(["--lower-marks=value-anchors"])).toEqual({
      mode: "lower",
      kinds: ["value-anchors"],
      confirm: false,
    });
    expect(ledgerCheckMode(["--confirm", "--lower-marks=value-anchors,chain-windows,value-anchors"])).toEqual({
      mode: "lower",
      kinds: ["value-anchors", "chain-windows"],
      confirm: true,
    });
  });

  it("⛔ --confirm alone confirms nothing, and is refused", () => {
    expect(() => ledgerCheckMode(["--confirm"])).toThrow(WitnessFlagRefusal);
    expect(() => ledgerCheckMode(["--confirm"])).toThrow(/--confirm confirms --lower-marks/);
  });

  it("⛔ --lower-marks with no kinds is refused, and lists the kinds", () => {
    for (const argv of [["--lower-marks"], ["--lower-marks="], ["--lower-marks=,"]]) {
      expect(() => ledgerCheckMode(argv)).toThrow(
        "--lower-marks needs the kinds to lower: --lower-marks=<kind,...>, of value-anchors, chain-windows, statement-periods, accounts",
      );
    }
  });

  it("⛔ a kind that does not exist is refused rather than skipped", () => {
    expect(() => ledgerCheckMode(["--lower-marks=value-anchor"])).toThrow(/no witness kind "value-anchor"/);
  });

  it("⛔ --lower-marks given twice is refused", () => {
    expect(() => ledgerCheckMode(["--lower-marks=accounts", "--lower-marks=value-anchors"])).toThrow(
      /--lower-marks given 2 times/,
    );
  });

  it("⛔ any other argument is refused — --db=<copy> would otherwise check the REAL ledger", () => {
    expect(() => ledgerCheckMode(["--db=/scratch/copy.db"])).toThrow(/unknown argument --db=\/scratch\/copy\.db — .*MONEYAPP_DB_PATH/);
    expect(() => ledgerCheckMode(["statements"])).toThrow(/unknown argument statements/);
    expect(() => ledgerCheckMode(["--confirm=yes"])).toThrow(/unknown argument --confirm=yes/);
  });
});

describe("marksFromRows — reading what the ledger stored", () => {
  it("reads a stored mark as its count and its witnesses", () => {
    expect(marksFromRows([{ kind: "value-anchors", mark: 1, witnesses: [[B, "2024-08-31"]] }])).toEqual({
      "value-anchors": { count: 1, witnesses: [[B, "2024-08-31"]] },
    });
  });

  it("leaves a kind this version does not know to the version that wrote it", () => {
    expect(marksFromRows([{ kind: "a-later-kind", mark: 0, witnesses: [] }])).toEqual({});
  });

  it("⛔ a mark whose witnesses are not a list of fields is an error, never an absent mark", () => {
    for (const witnesses of ["[]", [["a"], "b"], [[]], [[1]]]) {
      expect(() => marksFromRows([{ kind: "accounts", mark: 1, witnesses }])).toThrow(
        /the accounts mark's witnesses are not a list of fields/,
      );
    }
  });

  it("⛔ a mark whose count disagrees with its own witnesses is an error, never an absent mark", () => {
    expect(() => marksFromRows([{ kind: "accounts", mark: 3, witnesses: [["Cash on Hand"]] }])).toThrow(
      /the accounts mark says 3 but lists 1 witness —/,
    );
    expect(() => marksFromRows([{ kind: "accounts", mark: 1, witnesses: [["Cash on Hand"], [B]] }])).toThrow(
      /the accounts mark says 1 but lists 2 witnesses —/,
    );
  });
});
