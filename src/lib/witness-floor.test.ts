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
  type FloorResult,
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
const RC = "Robinhood Cash";
const COH = "Cash on Hand";
const WF = "Wells Fargo Everyday Checking";

/** the owner's thirteen accounts and their ids, read off the same copy */
const ID: Readonly<Record<string, string>> = {
  "Capital One 360 Checking": "01a03a43-ab5d-7001-8575-676060f15c78",
  [COH]: "019fcd2f-0777-7000-9728-f51c9f2dbd7e",
  [CC]: "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722",
  "Chase Sapphire": "019f4ca7-a750-7f21-8ffa-2546cac01f3a",
  Discover: "019f4cd1-b24f-7c43-895b-fc1c219b3dec",
  "Robinhood Agentic": "01a0a5f7-fdde-7000-85d2-1cd5ddd17902",
  [B]: "019f4c7d-cc91-74b0-9349-1c012e2cfb50",
  [RC]: "019f4c92-3250-7cd2-b24a-ba39058990d2",
  "Robinhood Crypto": "019f4c7d-cc91-7eb1-a3bb-aee70ab6193e",
  "SoFi Checking": "019f4cbb-9782-7d47-94c3-710d9ec30f05",
  "SoFi Savings": "019f4cbd-d2e7-78f3-8b38-f19f6a970d09",
  "Venture X": "019f4ccb-f9dd-7849-acfd-d76140adce62",
  "Wells Fargo Everyday Checking": "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8",
};

/** a witness as stored: its account's id, then its fields */
const at = (name: string, ...fields: string[]): string[] => [ID[name]!, ...fields];
/** the account names a mark over these accounts carries */
const named = (...names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [ID[n]!, n]));

/** Chase Checking, renamed the way the owner might: same id, a different name */
const CC_RENAMED = "Chase Checking 3522";
const idsAfterRename: Record<string, string> = Object.fromEntries(
  Object.entries(ID).map(([name, id]) => [name === CC ? CC_RENAMED : name, id]),
);

const observation = (over: Partial<LedgerObservation> = {}): LedgerObservation => ({
  accounts: [],
  accountIds: ID,
  chainEndpoints: {},
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

/** plain runs in order, each against the marks the run before it left — what the hook does commit by commit */
function runInOrder(
  marks: WitnessMarks,
  states: readonly LedgerObservation[],
): { results: FloorResult[]; marks: WitnessMarks } {
  const results: FloorResult[] = [];
  let current = marks;
  for (const state of states) {
    const result = compareToMarks(state, current);
    results.push(result);
    current = { ...current, ...result.writes };
  }
  return { results, marks: current };
}

const LOWER_HOW =
  "A witness this check counted has left the ledger, and nothing it proved is being checked any more. " +
  "Find what removed it (an un-import, a deleted anchor, a removed account) before anything else; only if the " +
  "owner approved that removal, lower the mark:";

describe("witnessesOf — what each kind counts", () => {
  it("counts every statement day on an investment account, valued or not; every window walked; every period graded; every account read", () => {
    const seen = witnessesOf(
      observation({
        accounts: [B, COH],
        // Cash on Hand's one typed balance bounds no window, and is an endpoint all the same
        chainEndpoints: { [CC]: ["2022-09-13", "2022-08-24"], [COH]: ["2026-08-03"] },
        chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }], [COH]: [] },
        gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
        valuedAnchorDays: { [B]: ["2024-09-30", "2024-08-31"] },
        // a statement the app could not value is still a statement that is there
        unpricedAnchors: [{ account: "Robinhood Crypto", on: "2025-10-31", printedCents: 150_500, derivedCents: null }],
      }),
    );
    expect(seen).toEqual({
      "value-anchors": [at(B, "2024-08-31"), at(B, "2024-09-30"), at("Robinhood Crypto", "2025-10-31")],
      "chain-endpoints": [at(COH, "2026-08-03"), at(CC, "2022-08-24"), at(CC, "2022-09-13")],
      "chain-windows": [at(CC, "2022-08-24", "2022-09-13")],
      "statement-periods": [at(CC, "2022-08-25", "2022-09-13")],
      accounts: [at(COH), at(B)],
    });
  });

  it("names the five kinds, in the order the summary prints them", () => {
    expect(WITNESS_KINDS).toEqual(["value-anchors", "chain-endpoints", "chain-windows", "statement-periods", "accounts"]);
  });

  it("⛔ keys a witness by its account's ID — the same ledger with an account renamed is the same witnesses", () => {
    const ledger = (name: string, accountIds: Record<string, string>) =>
      observation({
        accounts: [name, B],
        accountIds,
        chainWindows: { [name]: [{ from: "2022-08-24", to: "2022-09-13" }] },
        gradedPeriods: { [name]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
      });
    expect(witnessesOf(ledger(CC_RENAMED, idsAfterRename))).toEqual(witnessesOf(ledger(CC, ID)));
  });

  it("⛔ an account the observation gives no id is an error — keyed by its name, a rename would read as a removal", () => {
    const nameless = { accountIds: { [B]: ID[B]! } };
    const cases: [Partial<LedgerObservation>, string][] = [
      [{ accounts: [CC] }, CC],
      [{ chainEndpoints: { [CC]: ["2022-08-24"] } }, CC],
      [{ chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] } }, CC],
      [{ gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] } }, CC],
      [{ valuedAnchorDays: { "Robinhood Crypto": ["2025-10-31"] } }, "Robinhood Crypto"],
      [
        { unpricedAnchors: [{ account: "Robinhood Crypto", on: "2025-10-31", printedCents: 150_500, derivedCents: null }] },
        "Robinhood Crypto",
      ],
    ];
    for (const [over, name] of cases) {
      expect(() => witnessesOf(observation({ ...nameless, ...over }))).toThrow(
        `"${name}" has no account id in the observation`,
      );
    }
  });
});

describe("compareToMarks — a floor under every witness kind", () => {
  const today = observation({
    accounts: [COH, B],
    chainEndpoints: { [CC]: ["2022-08-24", "2022-09-13"] },
    chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] },
    gradedPeriods: { [CC]: [{ periodStart: "2022-08-25", periodEnd: "2022-09-13" }] },
    valuedAnchorDays: { [B]: ["2024-08-31"] },
  });

  it("a ledger with no marks records every kind at what it sees, with the name of every account it saw, and passes", () => {
    const result = compareToMarks(today, {});
    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({
      "value-anchors": { count: 1, witnesses: [at(B, "2024-08-31")], accountNames: named(B) },
      "chain-endpoints": {
        count: 2,
        witnesses: [at(CC, "2022-08-24"), at(CC, "2022-09-13")],
        accountNames: named(CC),
      },
      "chain-windows": { count: 1, witnesses: [at(CC, "2022-08-24", "2022-09-13")], accountNames: named(CC) },
      "statement-periods": { count: 1, witnesses: [at(CC, "2022-08-25", "2022-09-13")], accountNames: named(CC) },
      accounts: { count: 2, witnesses: [at(COH), at(B)], accountNames: named(COH, B) },
    });
    expect(result.summary).toBe(
      "witness marks: value anchors 1 (recorded) · chain endpoints 2 (recorded) · chain windows 1 (recorded) · " +
        "statement periods 1 (recorded) · accounts 2 (recorded)",
    );
  });

  it("a count AT its mark holds — nothing is written and nothing fails", () => {
    const result = compareToMarks(today, marksAt(today));
    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({});
    expect(result.summary).toBe(
      "witness marks: value anchors 1 · chain endpoints 2 · chain windows 1 · statement periods 1 · accounts 2",
    );
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
          "1 seen, below the mark of 2 — listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31. " +
          `${LOWER_HOW} pnpm ledger-check --lower-marks=value-anchors, then the same with --confirm`,
      },
    ]);
    // the mark stays where it was: a drop never lowers it on its own
    expect(result.writes).toEqual({});
    expect(result.summary).toBe(
      "witness marks: value anchors 1 (below its mark of 2) · chain endpoints 0 · chain windows 0 · statement periods 0 · accounts 0",
    );
  });

  it("a count above its mark raises the mark to exactly what was seen, on its own", () => {
    const before = observation({ valuedAnchorDays: { [B]: ["2024-08-31"] } });
    const after = observation({ valuedAnchorDays: { [B]: ["2024-08-31", "2024-09-30"] } });

    const result = compareToMarks(after, marksAt(before));

    expect(result.failures).toEqual([]);
    expect(result.writes).toEqual({
      "value-anchors": { count: 2, witnesses: [at(B, "2024-08-31"), at(B, "2024-09-30")], accountNames: named(B) },
    });
    expect(result.summary).toBe(
      "witness marks: value anchors 2 (raised from 1) · chain endpoints 0 · chain windows 0 · statement periods 0 · accounts 0",
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
      "1 seen, below the mark of 2 — listed in the mark, no longer seen: Chase Checking 2022-08-24 → 2022-09-13, " +
        "Chase Checking 2022-09-13 → 2022-10-13. ",
    );
    expect(result.writes).toEqual({
      "statement-periods": {
        count: 2,
        witnesses: [at(CC, "2022-08-25", "2022-09-13"), at(CC, "2022-09-14", "2022-10-13")],
        accountNames: named(CC),
      },
    });
  });

  /*
   * Measured on a copy of the owner's ledger (2026-09-15, review): Cash on Hand
   * holds ONE balance anchor, the $5,000.00 typed on 2026-08-03 that he decided
   * to keep. It bounds no chain window, so deleting it through the app's own
   * deleteAnchor wiped the account's whole balance history and the floor held
   * every mark and exited 0.
   */
  it("⛔ a lone anchor is a witness: removing Cash on Hand's one typed balance drops chain endpoints, though no window moves", () => {
    const before = observation({ chainEndpoints: { [COH]: ["2026-08-03"] }, chainWindows: { [COH]: [] } });
    const after = observation({ chainEndpoints: { [COH]: [] }, chainWindows: { [COH]: [] } });

    const result = compareToMarks(after, marksAt(before));

    expect(result.failures).toEqual([
      {
        kind: "witness-drop",
        account: "chain endpoints",
        detail:
          "0 seen, below the mark of 1 — listed in the mark, no longer seen: Cash on Hand 2026-08-03. " +
          `${LOWER_HOW} pnpm ledger-check --lower-marks=chain-endpoints, then the same with --confirm`,
      },
    ]);
    expect(result.writes).toEqual({});
    expect(result.summary).toBe(
      "witness marks: value anchors 0 · chain endpoints 0 (below its mark of 1) · chain windows 0 · statement periods 0 · accounts 0",
    );
  });

  it("a chain window an arriving anchor divided is not gone — its span is still walked; a window no walk stops on is", () => {
    const marks: WitnessMarks = {
      "chain-windows": {
        count: 5,
        witnesses: [
          at(CC, "2022-08-24", "2022-10-13"),
          at(CC, "2022-10-13", "2022-11-10"),
          at(CC, "2022-11-10", "2022-12-12"),
          at(CC, "2022-12-12", "2023-01-12"),
          at("Discover", "2023-01-01", "2023-02-01"),
        ],
        accountNames: named(CC, "Discover"),
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
      "3 seen, below the mark of 5 — listed in the mark, no longer seen: " +
        "Chase Checking 2022-10-13 → 2022-11-10, Chase Checking 2022-11-10 → 2022-12-12, " +
        "Chase Checking 2022-12-12 → 2023-01-12, Discover 2023-01-01 → 2023-02-01. ",
    );
  });

  /*
   * The one-caller sweep (2026-09-22): the stored SET was read only once the
   * count had dropped. One statement un-imported and the next month's imported
   * between two runs held the count and passed; with one more imported too, the
   * raise rewrote the mark from what was seen, and the statement that left was
   * gone from it for good — no later run could ever name it.
   */
  describe("⛔ a witness that left fails whatever the count does — a swap or a raise hides nothing", () => {
    const before = observation({ valuedAnchorDays: { [B]: ["2024-08-31", "2024-09-30"] } });
    const gone =
      "listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31. " +
      `${LOWER_HOW} pnpm ledger-check --lower-marks=value-anchors, then the same with --confirm`;

    it("a swap — one statement left, another arrived — holds the count, and fails naming the one that left", () => {
      const swapped = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31"] } });

      const result = compareToMarks(swapped, marksAt(before));

      expect(result.failures).toEqual([
        {
          kind: "witness-drop",
          account: "value anchors",
          detail: `2 seen, as many as the mark of 2 but not the same ones — ${gone}`,
        },
      ]);
      // the one that left stays in the mark, and the one that arrived joins it
      expect(result.writes).toEqual({
        "value-anchors": {
          count: 3,
          witnesses: [at(B, "2024-08-31"), at(B, "2024-09-30"), at(B, "2024-10-31")],
          accountNames: named(B),
        },
      });
      expect(result.summary).toBe(
        "witness marks: value anchors 2 (1 gone from its mark of 2; 1 arrival joins it: 2 → 3) · " +
          "chain endpoints 0 · chain windows 0 · statement periods 0 · accounts 0",
      );
    });

    it("a raise with a departure fails naming it, and never erases it — the next run names it again", () => {
      const raised = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31", "2024-11-30"] } });

      const {
        results: [first, second],
      } = runInOrder(marksAt(before), [raised, raised]);

      expect(first?.failures).toEqual([
        {
          kind: "witness-drop",
          account: "value anchors",
          detail: `3 seen, above the mark of 2 but not every one it lists — ${gone}`,
        },
      ]);
      expect(first?.writes).toEqual({
        "value-anchors": {
          count: 4,
          witnesses: [at(B, "2024-08-31"), at(B, "2024-09-30"), at(B, "2024-10-31"), at(B, "2024-11-30")],
          accountNames: named(B),
        },
      });
      expect(first?.summary).toContain(
        "value anchors 3 (1 gone from its mark of 2; 2 arrivals join it: 2 → 4) · ",
      );
      // the same ledger again: the one that left is named again, and with nothing new arrived nothing is written
      expect(second?.failures.map((f) => f.detail)).toEqual([`3 seen, below the mark of 4 — ${gone}`]);
      expect(second?.writes).toEqual({});
    });

    it("a window an arriving anchor divided is a raise, not a departure — its span is still walked", () => {
      const whole = observation({ chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-10-13" }] } });
      const divided = observation({
        chainWindows: {
          [CC]: [
            { from: "2022-08-24", to: "2022-09-13" },
            { from: "2022-09-13", to: "2022-10-13" },
          ],
        },
      });

      const result = compareToMarks(divided, marksAt(whole));

      expect(result.failures).toEqual([]);
      expect(result.writes).toEqual({
        "chain-windows": {
          count: 2,
          witnesses: [at(CC, "2022-08-24", "2022-09-13"), at(CC, "2022-09-13", "2022-10-13")],
          accountNames: named(CC),
        },
      });
    });

    it("a count held by one window divided while two others merged fails on the two that merged", () => {
      const marked = observation({
        chainWindows: {
          [CC]: [
            { from: "2022-08-24", to: "2022-10-13" },
            { from: "2022-10-13", to: "2022-11-10" },
            { from: "2022-11-10", to: "2022-12-12" },
          ],
        },
      });
      const after = observation({
        chainWindows: {
          [CC]: [
            { from: "2022-08-24", to: "2022-09-13" },
            { from: "2022-09-13", to: "2022-10-13" },
            { from: "2022-10-13", to: "2022-12-12" },
          ],
        },
      });

      const result = compareToMarks(after, marksAt(marked));

      expect(result.failures.map((f) => f.detail)).toEqual([
        "3 seen, as many as the mark of 3 but not the same ones — listed in the mark, no longer seen: " +
          "Chase Checking 2022-10-13 → 2022-11-10, Chase Checking 2022-11-10 → 2022-12-12. " +
          `${LOWER_HOW} pnpm ledger-check --lower-marks=chain-windows, then the same with --confirm`,
      ]);
      expect(result.writes).toEqual({});
    });
  });

  /*
   * Review of the set floor (2026-09-28): a kind that dropped wrote nothing, so a witness that ARRIVED while it
   * was failing never got into the mark. Un-imported again before the lowering, no run named it, and
   * `--lower-marks` — approved for the removal it did name — set the mark to what was seen and erased it without
   * a word. Main's drop path had the same hole; the set floor sends swaps and raises down it too.
   */
  describe("⛔ what arrives while a kind is failing joins its mark — named if it leaves before the lowering", () => {
    const marked = observation({ valuedAnchorDays: { [B]: ["2024-08-31", "2024-09-30"] } });
    const lower = `${LOWER_HOW} pnpm ledger-check --lower-marks=value-anchors, then the same with --confirm`;

    it("a statement imported while the kind is failing, then un-imported again, is named by the next run and by the lowering", () => {
      // the first statement un-imported and the next two imported; then the first of those un-imported again
      const raised = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31", "2024-11-30"] } });
      const undone = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-11-30"] } });

      const {
        results: [, second],
        marks,
      } = runInOrder(marksAt(marked), [raised, undone]);
      const plan = planLowering(undone, marks, ["value-anchors"]);

      expect(second?.failures.map((f) => f.detail)).toEqual([
        "2 seen, below the mark of 4 — listed in the mark, no longer seen: " +
          `Robinhood Brokerage 2024-08-31, Robinhood Brokerage 2024-10-31. ${lower}`,
      ]);
      expect(plan.lines).toEqual([
        "value anchors: lowers its mark 4 → 2 — listed in the mark, no longer seen: " +
          "Robinhood Brokerage 2024-08-31, Robinhood Brokerage 2024-10-31",
      ]);
      expect(compareToMarks(undone, { ...marks, ...plan.writes }).failures).toEqual([]);
    });

    it("so is one imported and un-imported again while the count is below the mark — main's drop path", () => {
      const dropped = observation({ valuedAnchorDays: { [B]: ["2024-09-30"] } });
      const imported = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31"] } });

      const { results } = runInOrder(marksAt(marked), [dropped, imported, dropped]);

      expect(results.map((r) => r.failures.map((f) => f.detail))).toEqual([
        [
          "1 seen, below the mark of 2 — listed in the mark, no longer seen: " +
            `Robinhood Brokerage 2024-08-31. ${lower}`,
        ],
        [
          "2 seen, as many as the mark of 2 but not the same ones — listed in the mark, no longer seen: " +
            `Robinhood Brokerage 2024-08-31. ${lower}`,
        ],
        [
          "1 seen, below the mark of 3 — listed in the mark, no longer seen: " +
            `Robinhood Brokerage 2024-08-31, Robinhood Brokerage 2024-10-31. ${lower}`,
        ],
      ]);
      // nothing arrived on the first run or the third, so they wrote nothing; the second took 2024-10-31 in
      expect(results.map((r) => r.writes["value-anchors"]?.count)).toEqual([undefined, 3, undefined]);
    });

    it("⛔ a witness on an account that is itself gone keeps the name the mark knew it by — the row reads back", () => {
      // Cash on Hand removed and Wells Fargo added between two runs: accounts fails, and takes Wells Fargo in
      const before = observation({ accounts: [B, COH] });
      const after = observation({ accounts: [B, WF], accountIds: { [B]: ID[B]!, [WF]: ID[WF]! } });

      const { writes } = compareToMarks(after, marksAt(before));

      expect(writes.accounts).toEqual({
        count: 3,
        witnesses: [at(COH), at(B), at(WF)],
        accountNames: named(COH, B, WF),
      });
      const joined = writes.accounts!;
      const stored = marksFromRows([
        { kind: "accounts", mark: joined.count, witnesses: joined.witnesses, accountNames: joined.accountNames },
      ]);
      expect(compareToMarks(after, stored).failures[0]?.detail).toContain(
        "2 seen, below the mark of 3 — listed in the mark, no longer seen: Cash on Hand. ",
      );
    });

    describe("chain windows", () => {
      const span = (from: string, to: string) => ({ from, to });
      const two = marksAt(
        observation({ chainWindows: { [CC]: [span("2022-08-24", "2022-09-13"), span("2022-09-13", "2022-10-13")] } }),
      );

      it("a window over days the mark does not cover joins it like any other witness", () => {
        // 2022-09-13 un-imported and 2022-11-10 imported; then 2022-11-10 un-imported again
        const imported = observation({
          chainWindows: { [CC]: [span("2022-08-24", "2022-10-13"), span("2022-10-13", "2022-11-10")] },
        });
        const undone = observation({ chainWindows: { [CC]: [span("2022-08-24", "2022-10-13")] } });

        const {
          results: [first, second],
        } = runInOrder(two, [imported, undone]);

        expect(first?.writes).toEqual({
          "chain-windows": {
            count: 3,
            witnesses: [
              at(CC, "2022-08-24", "2022-09-13"),
              at(CC, "2022-09-13", "2022-10-13"),
              at(CC, "2022-10-13", "2022-11-10"),
            ],
            accountNames: named(CC),
          },
        });
        // two windows arrived and one joined: the summary counts what joined, and claims no more arrived
        expect(first?.summary).toContain("chain windows 2 (2 gone from its mark of 2; 1 arrival joins it: 2 → 3) · ");
        expect(second?.failures[0]?.detail).toContain(
          "1 seen, below the mark of 3 — listed in the mark, no longer seen: " +
            "Chase Checking 2022-08-24 → 2022-09-13, Chase Checking 2022-09-13 → 2022-10-13, " +
            "Chase Checking 2022-10-13 → 2022-11-10. ",
        );
      });

      it("⛔ a window over days the mark already covers does not — a statement un-imported and imported again passes", () => {
        // walked only because 2022-09-13 left: the mark keeps the two it merged, which name that departure
        const unimported = observation({ chainWindows: { [CC]: [span("2022-08-24", "2022-10-13")] } });
        const again = observation({
          chainWindows: { [CC]: [span("2022-08-24", "2022-09-13"), span("2022-09-13", "2022-10-13")] },
        });

        const {
          results: [first, second],
        } = runInOrder(two, [unimported, again]);

        expect(first?.failures.map((f) => f.account)).toEqual(["chain windows"]);
        expect(first?.writes).toEqual({});
        expect(second).toEqual({
          writes: {},
          failures: [],
          summary:
            "witness marks: value anchors 0 · chain endpoints 0 · chain windows 2 · statement periods 0 · accounts 0",
        });
      });

      it("⛔ nor does one an arriving anchor divided — the mark's window measures its span, and a restored ledger passes", () => {
        // 2022-11-10 un-imported while a 2022-09-13 statement is backfilled; then 2022-11-10 imported again
        const marks = marksAt(
          observation({ chainWindows: { [CC]: [span("2022-08-24", "2022-10-13"), span("2022-10-13", "2022-11-10")] } }),
        );
        const meanwhile = observation({
          chainWindows: { [CC]: [span("2022-08-24", "2022-09-13"), span("2022-09-13", "2022-10-13")] },
        });
        const restored = observation({
          chainWindows: {
            [CC]: [
              span("2022-08-24", "2022-09-13"),
              span("2022-09-13", "2022-10-13"),
              span("2022-10-13", "2022-11-10"),
            ],
          },
        });

        const {
          results: [first, second],
        } = runInOrder(marks, [meanwhile, restored]);

        expect(first?.failures[0]?.detail).toContain(
          "2 seen, as many as the mark of 2 but not the same ones — listed in the mark, no longer seen: " +
            "Chase Checking 2022-10-13 → 2022-11-10. ",
        );
        expect(first?.writes).toEqual({});
        expect(second?.failures).toEqual([]);
      });
    });
  });

  it("a witness recorded twice and seen once is gone once", () => {
    const marks: WitnessMarks = {
      "value-anchors": { count: 2, witnesses: [at(B, "2024-08-31"), at(B, "2024-08-31")], accountNames: named(B) },
    };
    const [failure] = compareToMarks(observation({ valuedAnchorDays: { [B]: ["2024-08-31"] } }), marks).failures;
    expect(failure?.detail).toContain("1 seen, below the mark of 2 — listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31. ");
  });

  it("a drop whose mark's witnesses are all still accounted for says it cannot tell which left — and still fails", () => {
    const marks: WitnessMarks = {
      "chain-windows": {
        count: 2,
        witnesses: [at(CC, "2022-08-24", "2022-09-13"), at(CC, "2022-08-24", "2022-09-13")],
        accountNames: named(CC),
      },
    };
    const after = observation({ chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] } });

    const { failures } = compareToMarks(after, marks);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain(
      "1 seen, below the mark of 2 — every witness the mark lists is still accounted for, so which one left cannot be told. ",
    );
  });

  it("names ten gone witnesses, in name order, and counts the rest", () => {
    // the owner's thirteen accounts, as the check reads them
    const thirteen = Object.keys(ID);
    const [failure] = compareToMarks(observation(), marksAt(observation({ accounts: thirteen }))).failures;
    expect(failure?.account).toBe("accounts");
    expect(failure?.detail).toContain(
      "0 seen, below the mark of 13 — listed in the mark, no longer seen: Capital One 360 Checking, Cash on Hand, " +
        "Chase Checking, Chase Sapphire, Discover, Robinhood Agentic, Robinhood Brokerage, Robinhood Cash, " +
        "Robinhood Crypto, SoFi Checking and 3 more. ",
    );
    expect(failure?.detail).toContain("pnpm ledger-check --lower-marks=accounts, then the same with --confirm");
  });

  /*
   * Measured on a copy of the owner's ledger (2026-09-15, review): with the marks
   * recorded, Chase Checking renamed, then the first Robinhood statement
   * un-imported, the drop of ONE chain window listed fifty Chase Checking windows
   * as gone "and 40 more" — and the two Robinhood Cash windows that had actually
   * left were among the hidden forty.
   */
  describe("⛔ a rename moves no witness", () => {
    const windows = (chase: string, robinhood: { from: string; to: string }[]) => ({
      [chase]: [
        { from: "2022-08-24", to: "2022-09-13" },
        { from: "2022-09-13", to: "2022-10-13" },
      ],
      [RC]: robinhood,
    });
    const recorded = marksAt(
      observation({
        chainWindows: windows(CC, [
          { from: "2024-06-30", to: "2024-07-31" },
          { from: "2024-07-31", to: "2024-08-31" },
        ]),
      }),
    );

    it("renaming an account holds every count and writes nothing", () => {
      const renamed = observation({
        accountIds: idsAfterRename,
        chainWindows: windows(CC_RENAMED, [
          { from: "2024-06-30", to: "2024-07-31" },
          { from: "2024-07-31", to: "2024-08-31" },
        ]),
      });
      expect(compareToMarks(renamed, recorded)).toEqual({
        writes: {},
        failures: [],
        summary: "witness marks: value anchors 0 · chain endpoints 0 · chain windows 4 · statement periods 0 · accounts 0",
      });
    });

    it("a drop after a rename names exactly the witnesses that left, and none that were renamed", () => {
      const dropped = observation({
        accountIds: idsAfterRename,
        chainWindows: windows(CC_RENAMED, [{ from: "2024-06-30", to: "2024-08-31" }]),
      });
      expect(compareToMarks(dropped, recorded).failures).toEqual([
        {
          kind: "witness-drop",
          account: "chain windows",
          detail:
            "3 seen, below the mark of 4 — listed in the mark, no longer seen: " +
            "Robinhood Cash 2024-06-30 → 2024-07-31, Robinhood Cash 2024-07-31 → 2024-08-31. " +
            `${LOWER_HOW} pnpm ledger-check --lower-marks=chain-windows, then the same with --confirm`,
        },
      ]);
    });

    it("a gone witness on a renamed account is named as the account is called now", () => {
      const dropped = observation({
        accountIds: idsAfterRename,
        chainWindows: {
          [CC_RENAMED]: [{ from: "2022-08-24", to: "2022-09-13" }],
          [RC]: [
            { from: "2024-06-30", to: "2024-07-31" },
            { from: "2024-07-31", to: "2024-08-31" },
          ],
        },
      });
      expect(compareToMarks(dropped, recorded).failures[0]?.detail).toContain(
        "3 seen, below the mark of 4 — listed in the mark, no longer seen: Chase Checking 3522 2022-09-13 → 2022-10-13. ",
      );
    });

    it("a witness on an account that is itself gone is named as the mark knew it", () => {
      const before = observation({ accounts: [B, COH] });
      const after = observation({ accounts: [B], accountIds: { [B]: ID[B]! } });
      expect(compareToMarks(after, marksAt(before)).failures[0]?.detail).toContain(
        "1 seen, below the mark of 2 — listed in the mark, no longer seen: Cash on Hand. ",
      );
    });

    it("a mark that knows no name for an account says its id rather than nothing", () => {
      const marks: WitnessMarks = { accounts: { count: 1, witnesses: [at(COH)], accountNames: {} } };
      const after = observation({ accountIds: {} });
      expect(compareToMarks(after, marks).failures[0]?.detail).toContain(
        "0 seen, below the mark of 1 — listed in the mark, no longer seen: account 019fcd2f-0777-7000-9728-f51c9f2dbd7e. ",
      );
    });
  });
});

describe("planLowering — the guarded way down, after a removal the owner approved", () => {
  const seen = observation({
    valuedAnchorDays: { [B]: ["2024-09-30"] },
    chainWindows: { [CC]: [{ from: "2022-08-24", to: "2022-09-13" }] },
  });
  const marks: WitnessMarks = {
    "value-anchors": { count: 2, witnesses: [at(B, "2024-08-31"), at(B, "2024-09-30")], accountNames: named(B) },
    "chain-windows": { count: 1, witnesses: [at(CC, "2022-08-24", "2022-09-13")], accountNames: named(CC) },
  };

  it("lowers a named kind to exactly what is seen, and says what it forgets", () => {
    const plan = planLowering(seen, marks, ["value-anchors", "chain-windows", "statement-periods"]);
    expect(plan.writes).toEqual({
      "value-anchors": { count: 1, witnesses: [at(B, "2024-09-30")], accountNames: named(B) },
    });
    expect(plan.lines).toEqual([
      "value anchors: lowers its mark 2 → 1 — listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31",
      "chain windows: 1 seen, mark 1 — not below it and nothing it lists gone, nothing to lower",
      "statement periods: no mark recorded yet — nothing to lower (a plain run records one)",
    ]);
  });

  it("⛔ never raises — a kind seen above its mark, with nothing it lists gone, is left for a plain run", () => {
    const plan = planLowering(seen, { "chain-windows": { count: 0, witnesses: [], accountNames: {} } }, ["chain-windows"]);
    expect(plan.writes).toEqual({});
    expect(plan.lines).toEqual([
      "chain windows: 1 seen, mark 0 — not below it and nothing it lists gone, nothing to lower",
    ]);
  });

  it("⛔ touches only the kinds it was told to — a dropped kind nobody named keeps its mark", () => {
    expect(planLowering(seen, marks, ["chain-windows"]).writes).toEqual({});
  });

  describe("a witness that left while the count held or rose is approved the same way", () => {
    const marked: WitnessMarks = {
      "value-anchors": { count: 2, witnesses: [at(B, "2024-08-31"), at(B, "2024-09-30")], accountNames: named(B) },
    };

    it("a swap sets the mark to exactly what is seen, and says what it forgets", () => {
      const swapped = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31"] } });

      const plan = planLowering(swapped, marked, ["value-anchors"]);

      expect(plan.writes).toEqual({
        "value-anchors": { count: 2, witnesses: [at(B, "2024-09-30"), at(B, "2024-10-31")], accountNames: named(B) },
      });
      expect(plan.lines).toEqual([
        "value anchors: sets its mark 2 → 2, forgetting what left — listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31",
      ]);
    });

    it("a raise with a departure is lowered to what is seen, after which a plain run passes and writes nothing", () => {
      const raised = observation({ valuedAnchorDays: { [B]: ["2024-09-30", "2024-10-31", "2024-11-30"] } });

      const plan = planLowering(raised, marked, ["value-anchors"]);
      const next = compareToMarks(raised, { ...marked, ...plan.writes });

      expect(plan.lines).toEqual([
        "value anchors: sets its mark 2 → 3, forgetting what left — listed in the mark, no longer seen: Robinhood Brokerage 2024-08-31",
      ]);
      expect(next.failures).toEqual([]);
      // held at exactly what the lowering set (the other kinds have no mark here, so they are recorded)
      expect(next.writes["value-anchors"]).toBeUndefined();
      expect(next.summary).toContain("witness marks: value anchors 3 · ");
    });

    it("a window only divided is not lowered — nothing the mark lists has left", () => {
      const whole: WitnessMarks = {
        "chain-windows": { count: 1, witnesses: [at(CC, "2022-08-24", "2022-10-13")], accountNames: named(CC) },
      };
      const divided = observation({
        chainWindows: {
          [CC]: [
            { from: "2022-08-24", to: "2022-09-13" },
            { from: "2022-09-13", to: "2022-10-13" },
          ],
        },
      });

      const plan = planLowering(divided, whole, ["chain-windows"]);

      expect(plan.writes).toEqual({});
      expect(plan.lines).toEqual([
        "chain windows: 2 seen, mark 1 — not below it and nothing it lists gone, nothing to lower",
      ]);
    });
  });
});

describe("ledgerCheckMode — the command line", () => {
  /** what a session read on the statement, as `--reason` gives it */
  const READ_IT = "July statement, page 1: the bank's opening deposit, reversed the same day by the card it came from";

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
        "--lower-marks needs the kinds to lower: --lower-marks=<kind,...>, of value-anchors, chain-endpoints, chain-windows, statement-periods, accounts",
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

  /* ⚖️ Owner, 2026-10-02 (§6A 30): a line left out is acknowledged by the same guarded step — a dry run, then --confirm */
  it("--acknowledge-left-out=<marks> is a dry run; --confirm with --reason makes it write", () => {
    expect(ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de"])).toEqual({
      mode: "acknowledge",
      tokens: ["3f9a0c12de"],
      confirm: false,
      reason: null,
    });
    expect(ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de,0b1c2d3e4f,3f9a0c12de"])).toEqual({
      mode: "acknowledge",
      tokens: ["3f9a0c12de", "0b1c2d3e4f"],
      confirm: false,
      reason: null,
    });
    expect(ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", `--reason=${READ_IT}`, "--confirm"])).toEqual({
      mode: "acknowledge",
      tokens: ["3f9a0c12de"],
      confirm: true,
      reason: READ_IT,
    });
  });

  /*
   * ⛔ "An entry without a reason is a check that has been quieted rather than passed" (ledger-check's BASELINE). An
   * acknowledgement stops a finding failing, so it is stored with what the session read on the statement, and printed
   * with the line wherever the line is printed. Refused before the ledger is opened: nothing is written.
   */
  it("⛔ --confirm without --reason is refused — an acknowledgement says what the session read on the statement", () => {
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", "--confirm"])).toThrow(WitnessFlagRefusal);
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", "--confirm"])).toThrow(
      /--confirm records an acknowledgement, and one needs --reason='<what the statement shows>'/,
    );
  });

  /* 🔴 `\s` and `trim()` know no zero-width character: `--reason=` and one U+200B was a reason, and its dry run said so */
  it("⛔ a reason that says nothing is refused, dry run or not — Unicode whitespace and zero-width characters too", () => {
    const unicode = [" ", "　 ", "​", "‌‍⁠﻿", "  ​　 "];
    const blanks = ["--reason", "--reason=", "--reason=   ", "--reason=\n\t", ...unicode.map((r) => `--reason=${r}`)];
    for (const reason of blanks) {
      for (const confirm of [[], ["--confirm"]]) {
        expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", reason, ...confirm])).toThrow(
          /--reason needs what the session read on the statement/,
        );
      }
    }
  });

  it("the reason is kept whole — its commas, colons and equals signs — on one line, its spaces collapsed", () => {
    const mode = ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", "--reason=  July, p. 1:\n  fee =  $25.00 , reversed  "]);
    expect(mode).toEqual({ mode: "acknowledge", tokens: ["3f9a0c12de"], confirm: false, reason: "July, p. 1: fee = $25.00 , reversed" });
  });

  it("⛔ one reason names one line: --reason beside two marks is refused — each its own run, its own reason", () => {
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de,0b1c2d3e4f", `--reason=${READ_IT}`])).toThrow(
      /--reason says what ONE line is on its statement — 2 marks given/,
    );
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de,0b1c2d3e4f", `--reason=${READ_IT}`, "--confirm"])).toThrow(
      WitnessFlagRefusal,
    );
  });

  it("⛔ --reason given twice, or with nothing to acknowledge, is refused rather than dropped", () => {
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", "--reason=a", "--reason=b", "--confirm"])).toThrow(
      /--reason given 2 times/,
    );
    expect(() => ledgerCheckMode([`--reason=${READ_IT}`])).toThrow(/--reason is stored by --acknowledge-left-out/);
    expect(() => ledgerCheckMode(["--lower-marks=accounts", `--reason=${READ_IT}`, "--confirm"])).toThrow(
      /--reason is stored by --acknowledge-left-out/,
    );
  });

  it("⛔ --acknowledge-left-out with no marks is refused", () => {
    for (const argv of [["--acknowledge-left-out"], ["--acknowledge-left-out="], ["--acknowledge-left-out=,"]]) {
      expect(() => ledgerCheckMode(argv)).toThrow(/--acknowledge-left-out needs the marks of the lines to acknowledge/);
    }
  });

  it("⛔ a mark that is not one is refused rather than skipped", () => {
    expect(() => ledgerCheckMode(["--acknowledge-left-out=all"])).toThrow(/"all" is not a line's mark/);
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3F9A0C12DE"])).toThrow(/"3F9A0C12DE" is not a line's mark/);
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12d"])).toThrow(/"3f9a0c12d" is not a line's mark/);
  });

  it("⛔ --acknowledge-left-out given twice, or beside --lower-marks, is refused: one guarded write a run", () => {
    expect(() => ledgerCheckMode(["--acknowledge-left-out=3f9a0c12de", "--acknowledge-left-out=0b1c2d3e4f"])).toThrow(
      /--acknowledge-left-out given 2 times/,
    );
    expect(() => ledgerCheckMode(["--lower-marks=accounts", "--acknowledge-left-out=3f9a0c12de", "--confirm"])).toThrow(
      /--lower-marks and --acknowledge-left-out are two guarded writes/,
    );
  });

  it("⛔ --confirm alone names both writes it could confirm", () => {
    expect(() => ledgerCheckMode(["--confirm"])).toThrow(/--acknowledge-left-out=<mark> --reason='<what the statement shows>'/);
  });
});

describe("marksFromRows — reading what the ledger stored", () => {
  it("reads a stored mark as its count, its witnesses and the names of their accounts", () => {
    expect(
      marksFromRows([{ kind: "value-anchors", mark: 1, witnesses: [at(B, "2024-08-31")], accountNames: named(B) }]),
    ).toEqual({
      "value-anchors": { count: 1, witnesses: [at(B, "2024-08-31")], accountNames: named(B) },
    });
  });

  it("leaves a kind this version does not know to the version that wrote it", () => {
    expect(marksFromRows([{ kind: "a-later-kind", mark: 0, witnesses: [], accountNames: {} }])).toEqual({});
  });

  it("⛔ a mark whose witnesses are not a list of fields is an error, never an absent mark", () => {
    for (const witnesses of ["[]", [["a"], "b"], [[]], [[1]]]) {
      expect(() => marksFromRows([{ kind: "accounts", mark: 1, witnesses, accountNames: {} }])).toThrow(
        /the accounts mark's witnesses are not a list of fields/,
      );
    }
  });

  it("⛔ a mark whose account names are not a map of id to name is an error, never an absent mark", () => {
    for (const accountNames of ["{}", null, [], { [ID[COH]!]: 1 }]) {
      expect(() => marksFromRows([{ kind: "accounts", mark: 1, witnesses: [at(COH)], accountNames }])).toThrow(
        /the accounts mark's account names are not a map of account id to name/,
      );
    }
  });

  it("⛔ a mark whose count disagrees with its own witnesses is an error, never an absent mark", () => {
    expect(() =>
      marksFromRows([{ kind: "accounts", mark: 3, witnesses: [at(COH)], accountNames: named(COH) }]),
    ).toThrow(/the accounts mark says 3 but lists 1 witness —/);
    expect(() =>
      marksFromRows([{ kind: "accounts", mark: 1, witnesses: [at(COH), at(B)], accountNames: named(COH, B) }]),
    ).toThrow(/the accounts mark says 1 but lists 2 witnesses —/);
  });

  it("⛔ a mark with a witness on an account it names nowhere is an error — its message could not say what left", () => {
    expect(() =>
      marksFromRows([{ kind: "accounts", mark: 2, witnesses: [at(COH), at(B)], accountNames: named(B) }]),
    ).toThrow(/the accounts mark lists a witness on account 019fcd2f-0777-7000-9728-f51c9f2dbd7e and names no such account/);
  });
});
