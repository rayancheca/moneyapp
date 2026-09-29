import { describe, expect, test } from "vitest";
import { diffVerdict, INK_MEASURES, type DiffVerdict, type RawImage } from "./diff-verdict";
import {
  compareRecord,
  oneLineRenderer,
  type RendererRecord,
  type RendererVerdict,
} from "./fingerprint";
import type { GateAnswer } from "./gate-comparator";
import {
  commitMessage,
  describeContent,
  describeLeft,
  describePlan,
  describeRebased,
  describeTally,
  gateLines,
  inkMargins,
  pairBaselines,
  parseRebaseArgs,
  planRebase,
  tally,
  toleratedLine,
  UsageError,
  verdictTable,
  withinGateTolerance,
  type CommitFacts,
  type Judged,
  type RebasePlan,
} from "./rebase-plan";

describe("parseRebaseArgs", () => {
  test("no flag is a dry run of the whole suite", () => {
    expect(parseRebaseArgs([])).toEqual({ confirm: false, allowUnpushed: false, only: null });
  });

  test("the switches, and pnpm's separating -- ignored", () => {
    expect(parseRebaseArgs(["--", "--confirm", "--allow-unpushed"])).toEqual({
      confirm: true,
      allowUnpushed: true,
      only: null,
    });
  });

  test("a rehearsal takes a spec and a title pattern, either spelling", () => {
    const only = { spec: "e2e/interaction-states.spec.ts", grep: "hover" };
    expect(parseRebaseArgs(["--only", only.spec, "-g", only.grep]).only).toEqual(only);
    expect(parseRebaseArgs([`--only=${only.spec}`, `--grep=${only.grep}`]).only).toEqual(only);
    expect(parseRebaseArgs(["--only", only.spec]).only).toEqual({ spec: only.spec, grep: null });
  });

  /** A partial control proves nothing about the baselines it did not draw. */
  test("--confirm refuses a rehearsal, in either order", () => {
    const spec = "e2e/interaction-states.spec.ts";
    expect(() => parseRebaseArgs(["--confirm", "--only", spec])).toThrow(UsageError);
    expect(() => parseRebaseArgs(["--only", spec, "--confirm"])).toThrow(/cannot be combined/);
  });

  /**
   * A switch takes no value. Read as "on" whatever the value said, `--confirm=false` wrote the
   * baselines of someone who spelled out a dry run, and `--allow-unpushed=false` waived the pushed
   * guard for someone who spelled out keeping it.
   */
  test("a switch given a value is a usage error, never the switch turned on", () => {
    for (const arg of [
      "--confirm=false",
      "--confirm=no",
      "--confirm=0",
      "--confirm=",
      "--confirm=true",
      "--allow-unpushed=false",
      "--allow-unpushed=no",
      "--allow-unpushed=",
    ]) {
      expect(() => parseRebaseArgs([arg]), arg).toThrow(UsageError);
      expect(() => parseRebaseArgs([arg]), arg).toThrow(/is a switch: it takes no value/);
    }
  });

  test("anything it does not know, or a flag missing its value, is a usage error", () => {
    for (const argv of [
      ["--force"],
      ["confirm"],
      ["--only"],
      ["--only", "--confirm"],
      ["--only="],
      ["-g", "hover"],
      ["--only", "a", "--only", "b"],
      ["--only", "a", "-g", "x", "-g", "y"],
    ]) {
      expect(() => parseRebaseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});

const A = "e2e/visual.spec.ts-snapshots/accounts-dark-1440-chromium-darwin.png";
const B = "e2e/visual.spec.ts-snapshots/budgets-light-320-chromium-darwin.png";
const C = "e2e/zz-golden-path.spec.ts-snapshots/account-detail-dark-chromium-darwin.png";

describe("pairBaselines", () => {
  test("every committed baseline with its twin, by path relative to e2e/ and to the root", () => {
    const twins = [
      "zz-golden-path.spec.ts-snapshots/account-detail-dark-chromium-darwin.png",
      "visual.spec.ts-snapshots/accounts-dark-1440-chromium-darwin.png",
    ];
    expect(pairBaselines([C, A], twins, false)).toEqual({
      pairs: [
        { baseline: A, twin: twins[1] },
        { baseline: C, twin: twins[0] },
      ],
      missing: [],
      extra: [],
      notRun: [],
    });
  });

  const twins = [
    "visual.spec.ts-snapshots/accounts-dark-1440-chromium-darwin.png",
    "new.spec.ts-snapshots/n.png",
  ];

  test("a baseline the control never drew is missing; a drawing nobody committed is extra", () => {
    const pairing = pairBaselines([A, B], twins, false);
    expect(pairing.missing).toEqual([B]);
    expect(pairing.extra).toEqual(["e2e/new.spec.ts-snapshots/n.png"]);
    expect(pairing.pairs.map((p) => p.baseline)).toEqual([A]);
  });

  test("a rehearsal leaves the part it did not run unjudged, but still refuses an extra", () => {
    const pairing = pairBaselines([A, B, C], twins, true);
    expect(pairing.missing).toEqual([]);
    expect(pairing.notRun).toEqual([B, C]);
    expect(pairing.extra).toEqual(["e2e/new.spec.ts-snapshots/n.png"]);
  });
});

const RENDERER_ONLY_REASON =
  "every change is sub-pixel: no ink moved a whole pixel or changed colour";

function verdict(
  kind: DiffVerdict["verdict"],
  changedFraction: number,
  reasons: string[] = [],
  bbox: DiffVerdict["metrics"]["bbox"] = null,
): DiffVerdict {
  return {
    verdict: kind,
    reasons,
    metrics: {
      changedPixels: Math.round(changedFraction * 1_000_000),
      changedFraction,
      maxDelta: kind === "identical" ? 0 : 66,
      meanDelta: kind === "identical" ? 0 : 5,
      bbox,
      decidingMeasure: kind === "identical" ? "pixels" : "ink-fine",
    },
  };
}

/** Renderer drift as diffVerdict judges it, not yet put to the gate. */
const drift = (baseline: string, fraction: number, fine: number, coarse: number): Judged => ({
  baseline,
  verdict: verdict("renderer-only", fraction, [
    RENDERER_ONLY_REASON,
    `ink-fine ${fine.toFixed(4)} <= 0.18 at (10,20)`,
    `ink-coarse ${coarse.toFixed(4)} <= 0.029 at (11,21)`,
  ]),
});
const same = (baseline: string): Judged => ({
  baseline,
  verdict: verdict("identical", 0, ["no pixel differs"]),
});
const changed = (baseline: string): Judged => ({
  baseline,
  verdict: verdict(
    "content",
    0.0004,
    [
      "ink-fine 0.3333 > 0.18 at (1302,303): ink moved, appeared or vanished here",
      "ink-coarse 0.0100 <= 0.029 at (1,1)",
    ],
    { x: 1296, y: 297, w: 101, h: 34 },
  ),
});

const D = "e2e/visual.spec.ts-snapshots/cashflow-dark-1440-chromium-darwin.png";
const E = "e2e/visual.spec.ts-snapshots/dashboard-dark-1440-chromium-darwin.png";

/** A judged pair with the gate's own answer on it, as judgeAll puts every renderer-only one. */
const gated = (judged: Judged, gate: GateAnswer): Judged => ({ ...judged, gate });
const fails = (baseline: string, fraction = 0.002): Judged =>
  gated(drift(baseline, fraction, 0.05, 0.01), "fails");
const passes = (baseline: string, fraction = 0.002): Judged =>
  gated(drift(baseline, fraction, 0.05, 0.01), "passes");
const unknown = (baseline: string): Judged =>
  gated(drift(baseline, 0.002, 0.05, 0.01), "unknown");

/** A pairing with a twin for every committed baseline: the control drew exactly the set. */
const full = (committed: readonly string[]) =>
  pairBaselines(committed, committed.map((b) => b.slice("e2e/".length)), false);

/** HEAD was origin/main's tip: it passed the gate, so the committed baselines are its UI. */
const PUSHED = { pushed: true, allowUnpushed: false };
const UNPUSHED = { pushed: false, allowUnpushed: false };

function rebasePlan(rendererVerdict: RendererVerdict, judged: readonly Judged[]): RebasePlan {
  const plan = planRebase(
    rendererVerdict,
    full(judged.map((j) => j.baseline)),
    tally(judged),
    PUSHED,
  );
  if (plan.action !== "rebase") throw new Error(`expected a re-base, got ${plan.action}`);
  return plan;
}

describe("inkMargins", () => {
  /** The lines are diffVerdict's own; reading them back must not drift from what it writes. */
  test("reads back every ink measure diffVerdict actually measured", () => {
    const blank = (): RawImage => ({
      width: 24,
      height: 24,
      data: new Uint8Array(24 * 24 * 4).fill(255),
    });
    const expected = blank();
    const actual = blank();
    const set = (img: RawImage, x: number, y: number, v: number) =>
      img.data.fill(v, (y * 24 + x) * 4, (y * 24 + x) * 4 + 3);
    // a black line turned grey, and a dot drawn on bare paper beside it: every measure reads it
    for (let y = 4; y < 20; y++) {
      set(expected, 8, y, 0);
      set(actual, 8, y, 60);
    }
    set(actual, 16, 12, 0);
    const margins = inkMargins({ baseline: A, verdict: diffVerdict(expected, actual) });
    expect(margins.map((m) => m.scale).sort()).toEqual(INK_MEASURES.map((m) => m.id).sort());
    for (const m of margins) {
      expect(m.limit).toBe(INK_MEASURES.find((s) => s.id === m.scale)!.limit);
      expect(m.value).toBeGreaterThan(0);
    }
  });

  test("a verdict decided by size or by identical pixels has none", () => {
    expect(inkMargins(same(A))).toEqual([]);
  });
});

describe("withinGateTolerance", () => {
  test("a renderer-only file the gate passes, and no other answer", () => {
    expect(withinGateTolerance(passes(A))).toBe(true);
    expect(withinGateTolerance(fails(A))).toBe(false);
    // never the reverse: a file the gate could not be asked about is re-based, not left
    expect(withinGateTolerance(unknown(A))).toBe(false);
    expect(withinGateTolerance(drift(A, 0.002, 0.05, 0.01))).toBe(false);
  });

  /** The gate's colour threshold never excuses content, and identical has nothing to leave. */
  test("never a content or identical verdict, whatever the gate was said to answer", () => {
    expect(withinGateTolerance(gated(changed(A), "passes"))).toBe(false);
    expect(withinGateTolerance(gated(same(A), "passes"))).toBe(false);
  });
});

describe("tally", () => {
  test("the renderer-only files split by the gate's own answer", () => {
    const failed = fails(A);
    const passed = passes(B);
    const couldNot = unknown(C);
    const unasked = drift(D, 0.002, 0.05, 0.01);
    const counts = tally([failed, passed, couldNot, unasked, same(E)]);
    expect(counts.rendererOnly).toHaveLength(4);
    expect(counts.toRebase).toEqual([failed, couldNot, unasked]);
    expect(counts.tolerated).toEqual([passed]);
    expect(counts.identical).toHaveLength(1);
    expect(counts.content).toHaveLength(0);
  });

  test("counts, the median and worst changed fraction, and the closest call", () => {
    const counts = tally([
      same(A),
      drift(B, 0.0023, 0.05, 0.01),
      drift(C, 0.0059, 0.0982, 0.0158),
      drift("e2e/x.spec.ts-snapshots/d.png", 0.001, 0.02, 0.005),
    ]);
    expect(counts.identical).toHaveLength(1);
    expect(counts.rendererOnly).toHaveLength(3);
    expect(counts.content).toHaveLength(0);
    expect(counts.medianChangedFraction).toBe(0.0023);
    expect(counts.worst?.baseline).toBe(C);
    // 0.0982 / 0.18 = 0.546 beats 0.0158 / 0.029 = 0.545: the closest call is the fine scale
    expect(counts.closest).toEqual({ baseline: C, scale: "ink-fine", value: 0.0982, limit: 0.18 });
  });

  /** They describe every pair diffVerdict judged renderer-only, not only the part re-based. */
  test("the median, the worst and the closest call count the tolerated files too", () => {
    const counts = tally([fails(A, 0.001), gated(drift(B, 0.009, 0.1, 0.01), "passes")]);
    expect(counts.worst?.baseline).toBe(B);
    expect(counts.closest?.baseline).toBe(B);
    expect(counts.medianChangedFraction).toBeCloseTo(0.005, 12);
  });

  test("an even count takes the mean of the middle two; none has no median at all", () => {
    const two = tally([drift(A, 0.001, 0.01, 0.01), drift(B, 0.003, 0.01, 0.01)]);
    expect(two.medianChangedFraction).toBeCloseTo(0.002, 12);
    const nothing = tally([same(A)]);
    expect(nothing.medianChangedFraction).toBeNull();
    expect(nothing.worst).toBeNull();
    expect(nothing.closest).toBeNull();
    expect(nothing.toRebase).toEqual([]);
    expect(nothing.tolerated).toEqual([]);
  });
});

describe("planRebase", () => {
  test("a missing or extra twin refuses before any verdict counts", () => {
    const pairing = pairBaselines([A, B], [A.slice("e2e/".length)], false);
    expect(planRebase("renderer-changed", pairing, tally([same(A)]), PUSHED)).toEqual({
      action: "refuse-unpaired",
      missing: [B],
      extra: [],
    });
  });

  test("one content verdict among a hundred drift ones refuses the lot", () => {
    const judged = [fails(A), changed(B), fails(C)];
    const plan = planRebase("renderer-changed", full([A, B, C]), tally(judged), PUSHED);
    expect(plan).toEqual({ action: "refuse-content", content: [judged[1]] });
  });

  /** Every pair is judged by diffVerdict first; the gate's tolerance never excuses content. */
  test("content refuses even when the gate passes every drifted file", () => {
    const judged = [passes(A), changed(B), passes(C)];
    expect(planRebase("unrecorded", full([A, B, C]), tally(judged), PUSHED)).toEqual({
      action: "refuse-content",
      content: [judged[1]],
    });
  });

  test("re-bases only the drift the gate fails, never one it passes nor an identical one", () => {
    expect(rebasePlan("renderer-changed", [same(A), fails(B), passes(C), fails(D)])).toEqual({
      action: "rebase",
      files: [B, D],
      tolerated: [C],
      bootstrap: false,
    });
  });

  /** Never the reverse: leaving a file the gate does fail would turn the verifying gate red. */
  test("a file the comparator could not judge, or was never asked about, is re-based", () => {
    const unasked = drift(B, 0.002, 0.05, 0.01);
    expect(rebasePlan("renderer-changed", [unknown(A), unasked, passes(C)])).toEqual({
      action: "rebase",
      files: [A, B],
      tolerated: [C],
      bootstrap: false,
    });
  });

  /** The first run on a machine the baselines already match: record the renderer, move nothing. */
  test("no record and nothing changed is the bootstrap: the record alone", () => {
    expect(rebasePlan("unrecorded", [same(A), same(B)])).toEqual({
      action: "rebase",
      files: [],
      tolerated: [],
      bootstrap: true,
    });
    expect(rebasePlan("renderer-changed", [same(A)])).toEqual({
      action: "rebase",
      files: [],
      tolerated: [],
      bootstrap: false,
    });
  });

  /**
   * This Mac as of 2026-09-29: no record yet and the gate green, while baselines drawn before
   * macOS 27.2 differ from its drawing within the gate's tolerance (gate-comparator.ts). The
   * record alone, then the verifying gate; not one baseline copied.
   */
  test("no record, and every moved file within the gate's tolerance: the record alone", () => {
    expect(rebasePlan("unrecorded", [same(A), passes(B), passes(C)])).toEqual({
      action: "rebase",
      files: [],
      tolerated: [B, C],
      bootstrap: true,
    });
    expect(rebasePlan("renderer-changed", [passes(A)])).toEqual({
      action: "rebase",
      files: [],
      tolerated: [A],
      bootstrap: false,
    });
  });
});

/**
 * A HEAD never pushed as origin/main's tip has passed no gate, so nothing proves its committed
 * baselines are its UI. Recording the renderer needs no such proof: the gate's own comparator
 * passing every baseline is the proof, drawn by the control at HEAD. Copying a twin does, and that
 * needs --allow-unpushed.
 */
describe("planRebase on a HEAD never pushed as origin/main's tip", () => {
  test("the record alone goes ahead: after the merge that brings this command, its run", () => {
    const plan = planRebase("unrecorded", full([A, B]), tally([same(A), passes(B)]), UNPUSHED);
    expect(plan).toEqual({ action: "rebase", files: [], tolerated: [B], bootstrap: true });
  });

  test("a twin to copy is refused without --allow-unpushed, and allowed with it", () => {
    const judged = [fails(A), passes(B), unknown(C)];
    const pairing = full([A, B, C]);
    expect(planRebase("canary-changed", pairing, tally(judged), UNPUSHED)).toEqual({
      action: "refuse-unpushed",
      files: [A, C],
    });
    const allowed = { pushed: false, allowUnpushed: true };
    expect(planRebase("canary-changed", pairing, tally(judged), allowed)).toMatchObject({
      action: "rebase",
      files: [A, C],
    });
  });

  test("an unpaired twin or a content verdict still refuses first", () => {
    const plan = planRebase("unrecorded", full([A, B]), tally([fails(A), changed(B)]), UNPUSHED);
    expect(plan.action).toBe("refuse-content");
  });
});

/**
 * The canary embeds the Geist files the app ships, so a Geist upgrade moves the canary's source,
 * and every baseline with text moves with it. That drift is the app's own, a UI change, however
 * much it looks like the renderer's to diffVerdict: its baselines belong to the commit that
 * changed the font. So no twin is copied while the fonts differ from the record, whatever vouched
 * for HEAD; the record alone may be written once the gate passes every baseline drawn with them.
 */
describe("planRebase when the fonts the app ships changed", () => {
  const record = (fontSha256: string, sourceSha256: string): RendererRecord => ({
    canary: { pixelSha256: "a".repeat(64), sourceSha256, fontSha256, width: 1280, height: 720 },
    recordedOn: "2026-09-28T19:02:11.000Z",
    macos: { productVersion: "27.2", buildVersion: "26B5091g" },
    playwright: "1.61.1",
    chromiumRevision: "1228",
  });
  const recorded = record("d".repeat(64), "c".repeat(64));
  // a Geist upgrade: new font bytes, so a new source hash too, on the same Mac
  const upgraded = record("e".repeat(64), "f".repeat(64));

  test("a Geist upgrade copies no twin, pushed or not, allowed or not", () => {
    const verdict = compareRecord(recorded, upgraded);
    const judged = [fails(A), passes(B), unknown(C)];
    for (const push of [PUSHED, UNPUSHED, { pushed: false, allowUnpushed: true }]) {
      expect(planRebase(verdict, full([A, B, C]), tally(judged), push)).toEqual({
        action: "refuse-fonts",
        files: [A, C],
      });
    }
  });

  test("the record alone goes ahead when the gate passes every baseline drawn with them", () => {
    const verdict = compareRecord(recorded, upgraded);
    const plan = planRebase(verdict, full([A, B]), tally([same(A), passes(B)]), UNPUSHED);
    expect(plan).toEqual({ action: "rebase", files: [], tolerated: [B], bootstrap: false });
  });

  test("an unpaired twin or a content verdict still refuses first", () => {
    const verdict = compareRecord(recorded, upgraded);
    const plan = planRebase(verdict, full([A, B]), tally([fails(A), changed(B)]), PUSHED);
    expect(plan.action).toBe("refuse-content");
  });

  /** An edit to the canary page alone moves no baseline: renderer drift is re-based as ever. */
  test("an edit to the canary page alone still re-bases what the gate fails", () => {
    const verdict = compareRecord(recorded, record("d".repeat(64), "f".repeat(64)));
    expect(verdict).toBe("canary-changed");
    expect(planRebase(verdict, full([A, B]), tally([fails(A), passes(B)]), PUSHED)).toEqual({
      action: "rebase",
      files: [A],
      tolerated: [B],
      bootstrap: false,
    });
  });
});

describe("the words", () => {
  test("a content refusal names the file, the measure that decided, and where", () => {
    expect(describeContent([changed(B)])).toEqual([
      B,
      "  ink-fine 0.3333 > 0.18 at (1302,303): ink moved, appeared or vanished here",
      "  400 px changed (0.04%), max delta 66 in 101x34 at (1296,297)",
    ]);
  });

  /**
   * The line a --confirm that wrote ends on, whatever stopped it: the red gate, an error, a
   * signal. It used to be skipped whenever the restore itself threw.
   */
  test("after --confirm wrote: where e2e/ stands, and who puts back what is left", () => {
    expect(describeLeft([], false)).toEqual(["e2e/ matches HEAD again."]);
    expect(describeLeft([A, "e2e/baseline-renderer.json"], true)).toEqual([
      `NOT AS HEAD HAS IT: ${A}; e2e/baseline-renderer.json`,
      "The next pnpm e2e:rebase-renderer puts back what this run wrote before anything else.",
    ]);
    expect(describeLeft([A], false)).toEqual([`NOT AS HEAD HAS IT: ${A}`]);
  });

  test("the tally says what a rehearsal left out", () => {
    const lines = describeTally(tally([same(A), fails(B, 0.0023)]), 150);
    expect(lines).toContain("identical      1");
    expect(lines).toContain("renderer-only  1");
    expect(lines.at(-1)).toBe("150 committed baselines outside this rehearsal, not judged");
  });

  /** A file the gate passes is counted, never listed: the report's only word on it. */
  test("under the renderer-only count: what the gate fails, could not judge, and passes", () => {
    const counts = tally([fails(A), passes(B), passes(C), unknown(D), same(E)]);
    expect(describeTally(counts, 0).slice(0, 6)).toEqual([
      "identical      1",
      "renderer-only  4",
      "  1 fails the gate itself: re-based",
      "  1 the gate's comparator could not judge: re-based as though the gate failed it",
      "  2 moved within the gate's tolerance, left as they are",
      "content        0",
    ]);
  });

  test("a kind with no file has no line, and one file is singular", () => {
    expect(gateLines(tally([fails(A), fails(B)]))).toEqual(["2 fail the gate itself: re-based"]);
    expect(gateLines(tally([unknown(A), unknown(B)]))).toEqual([
      "2 the gate's comparator could not judge: re-based as though the gate failed them",
    ]);
    expect(gateLines(tally([passes(A)]))).toEqual([toleratedLine(1)]);
    expect(toleratedLine(1)).toBe("1 moved within the gate's tolerance, left as it is");
    expect(toleratedLine(1_234)).toBe("1,234 moved within the gate's tolerance, left as they are");
    expect(gateLines(tally([same(A)]))).toEqual([]);
  });

  test("only the files to re-base are listed, most changed first; every verdict is tabled", () => {
    const judged = [
      same(A),
      fails(B, 0.001),
      gated(drift(C, 0.004, 0.0982, 0.0158), "fails"),
      passes(D, 0.009),
      drift(E, 0.003, 0.05, 0.01),
    ];
    expect(describeRebased(tally(judged).toRebase)).toEqual([
      ` 0.40%  ${C}`,
      ` 0.30%  ${E}`,
      ` 0.10%  ${B}`,
    ]);
    const table = verdictTable(judged).trimEnd().split("\n");
    expect(table[0]).toBe(
      "baseline\tverdict\tgate\tdeciding\tchanged_px\tchanged_fraction\tmax_delta\tink_fine\t" +
        "ink_coarse\tink_lone\tink_tone",
    );
    expect(table).toHaveLength(6);
    expect(table[1]).toBe(`${A}\tidentical\t\tpixels\t0\t0.000000\t0\t\t\t\t`);
    expect(table[3]).toBe(
      `${C}\trenderer-only\tfails\tink-fine\t4000\t0.004000\t66\t0.0982\t0.0158\t\t`,
    );
    // the tolerated are named here, and one never asked says what the plan took it for
    expect(table[4]).toBe(
      `${D}\trenderer-only\tpasses\tink-fine\t9000\t0.009000\t66\t0.05\t0.01\t\t`,
    );
    expect(table[5]?.split("\t").slice(0, 3)).toEqual([E, "renderer-only", "unknown"]);
  });

  const RECORDED: RendererRecord = {
    canary: {
      pixelSha256: "a".repeat(64),
      sourceSha256: "c".repeat(64),
      fontSha256: "d".repeat(64),
      width: 1280,
      height: 720,
    },
    recordedOn: "2026-09-28T19:02:11.000Z",
    macos: { productVersion: "27.2", buildVersion: "26B5091g" },
    playwright: "1.61.1",
    chromiumRevision: "1228",
  };
  const CURRENT: RendererRecord = {
    ...RECORDED,
    canary: { ...RECORDED.canary, pixelSha256: "b".repeat(64) },
    recordedOn: "2026-10-30T12:00:00.000Z",
    macos: { productVersion: "27.3", buildVersion: "26C12" },
  };

  test("the dry run says what --confirm copies, what it leaves, and what it records", () => {
    const plan = rebasePlan("renderer-changed", [same(A), fails(B), passes(C), passes(D)]);
    expect(describePlan(plan, CURRENT)).toEqual([
      "copy 1 twin over its baseline, and write e2e/baseline-renderer.json;",
      "leave the 2 that moved within the gate's tolerance as they are;",
      `record ${oneLineRenderer(CURRENT)};`,
      "then run the gate with the renderer check on, and put every file back if it is red.",
    ]);
    const nothingLeft = rebasePlan("renderer-changed", [fails(A), fails(B)]);
    expect(describePlan(nothingLeft, CURRENT).slice(0, 2)).toEqual([
      "copy 2 twins over their baselines, and write e2e/baseline-renderer.json;",
      `record ${oneLineRenderer(CURRENT)};`,
    ]);
  });

  test("the first run on a Mac the gate already passes: the record alone, then the gate", () => {
    const plan = rebasePlan("unrecorded", [same(A), passes(B)]);
    expect(describePlan(plan, CURRENT).slice(0, 2)).toEqual([
      "copy no baseline, and write e2e/baseline-renderer.json (the bootstrap: nothing had been " +
        "recorded);",
      "leave the 1 that moved within the gate's tolerance as it is;",
    ]);
  });

  function facts(judged: Judged[], overrides: Partial<CommitFacts> = {}): CommitFacts {
    const rendererVerdict = overrides.verdict ?? "renderer-changed";
    return {
      plan: rebasePlan(rendererVerdict, judged),
      counts: tally(judged),
      total: judged.length,
      verdict: rendererVerdict,
      recorded: RECORDED,
      current: CURRENT,
      lastMatch: null,
      head: { sha: "c3b9a59163994b2db7145ce4aea77bd806d66425", subject: "fix(pay): a payday" },
      pushed: true,
      control: { passed: 602, rerun: null },
      gate: { passed: 602, rerun: null },
      ...overrides,
    };
  }

  /** The body read as prose: the wrapped lines of each paragraph joined again. */
  const prose = (message: string) => message.replaceAll("\n", " ");

  function expectWrapped(message: string): void {
    expect(message.endsWith("\n")).toBe(true);
    for (const line of message.split("\n")) expect(line.length, line).toBeLessThanOrEqual(92);
  }

  test("the commit message: the house subject, what moved, and the numbers behind it", () => {
    const judged = [
      same(A),
      fails(B, 0.0023),
      gated(drift(C, 0.0059, 0.0982, 0.0158), "fails"),
    ];
    const message = commitMessage(facts(judged));
    const [subject, blank, ...body] = message.split("\n");
    expect(subject).toBe("chore(e2e): re-base 2 baselines on macOS 27.3 (26C12) — no UI changed");
    expect(blank).toBe("");
    const text = body.join(" ");
    expect(text).toContain("macOS 27.2 (26B5091g) -> 27.3 (26C12)");
    expect(text).toContain("aaaaaaaaaaaa -> bbbbbbbbbbbb");
    expect(text).toContain("at c3b9a59");
    expect(text).toContain("602 passed");
    expect(text).toContain("2 renderer-only, 1 identical, none content, none missing or extra");
    expect(text).toContain("Of the 2 renderer-only files, 2 fail it and are re-based.");
    expect(text).toContain("Changed pixels of the renderer-only files: median 0.41%");
    expect(text).toContain(`worst 0.59% (${C})`);
    expect(text).toContain("ink-fine 0.0982 of 0.18 (1.83x under)");
    expectWrapped(message);
  });

  /**
   * The record is written only when the canary moves, so its versions go stale on every update
   * that draws the canary identically; the commit names what moved since the canary last matched
   * here, when that match was against this record.
   */
  test("what moved is read since the canary last matched on this machine", () => {
    const rolled = { playwright: "1.62.0", chromiumRevision: "1240" };
    const lastMatch: RendererRecord = {
      ...RECORDED,
      ...rolled,
      recordedOn: "2026-10-20T08:00:00.000Z",
    };
    const current = { ...CURRENT, ...rolled };
    const text = prose(commitMessage(facts([fails(A)], { current, lastMatch })));
    expect(text).toContain(
      "Since it last matched on this machine, 2026-10-20: macOS 27.2 (26B5091g) -> 27.3 (26C12);",
    );
    expect(text).not.toContain("r1228");
  });

  test("with no match remembered, what moved is read since the record, and said to be", () => {
    const rolled = { playwright: "1.62.0", chromiumRevision: "1240" };
    const text = prose(commitMessage(facts([fails(A)], { current: { ...CURRENT, ...rolled } })));
    expect(text).toContain("chromium r1228 -> r1240");
    expect(text).toMatch(/since the record was written/);
    expect(text).toMatch(/may have moved long before/);
  });

  test("the subject counts only what the gate fails, and the body names what it left", () => {
    const message = commitMessage(facts([fails(A), passes(B), passes(C)]));
    expect(message.split("\n")[0]).toBe(
      "chore(e2e): re-base 1 baseline on macOS 27.3 (26C12) — no UI changed",
    );
    expect(prose(message)).toContain(
      "Only what the gate itself fails is re-based, asked of Playwright's own comparator with " +
        "the gate's options (scripts/e2e-renderer/gate-comparator.ts). Of the 3 renderer-only " +
        "files, 1 fails it and is re-based; 2 moved within the gate's tolerance and are left as " +
        "they are.",
    );
    expectWrapped(message);
  });

  /** This Mac's first run: record only, then the verifying gate; no baseline is touched. */
  test("a bootstrap the gate already passes records the renderer and names every file left", () => {
    const message = commitMessage(
      facts([same(A), passes(B), passes(C)], { recorded: null, verdict: "unrecorded" }),
    );
    expect(message.split("\n")[0]).toBe(
      "chore(e2e): record macOS 27.3 (26C12) as the baselines' renderer — no baseline changed",
    );
    const text = prose(message);
    expect(text).toContain("NO RENDERER RECORD");
    expect(text).toContain(
      "Of the 2 renderer-only files, none fails it; 2 moved within the gate's tolerance and " +
        "are left as they are.",
    );
    expect(text).toContain("Changed pixels of the renderer-only files");
    expectWrapped(message);
  });

  /** After the font's baselines were redrawn with it: the record alone, and why it moved. */
  test("a record-only run after a Geist upgrade says the fonts moved, not the Mac", () => {
    const upgraded: RendererRecord = {
      ...CURRENT,
      canary: { ...CURRENT.canary, fontSha256: "e".repeat(64), sourceSha256: "f".repeat(64) },
    };
    const message = commitMessage(
      facts([same(A), passes(B)], { verdict: "fonts-changed", current: upgraded }),
    );
    expect(message.split("\n")[0]).toBe(
      "chore(e2e): record macOS 27.3 (26C12) as the baselines' renderer — no baseline changed",
    );
    const text = prose(message);
    expect(text).toContain(
      "The Geist files the app ships (node_modules/geist) changed since 2026-09-28",
    );
    expect(text).toContain("dddddddddddd -> eeeeeeeeeeee");
    expect(text).not.toContain("This Mac stopped drawing");
    expectWrapped(message);
  });

  test("a file the comparator could not judge is re-based, and the commit says why", () => {
    const message = commitMessage(facts([unknown(A), fails(B)]));
    expect(message.split("\n")[0]).toBe(
      "chore(e2e): re-base 2 baselines on macOS 27.3 (26C12) — no UI changed",
    );
    expect(prose(message)).toContain(
      "Of the 2 renderer-only files, 1 fails it and is re-based; 1 could not be put to it and " +
        "is re-based as though the gate failed it.",
    );
  });

  test("one baseline is singular, and a record-only run says no baseline changed", () => {
    const one = commitMessage(facts([fails(A)]));
    expect(one.split("\n")[0]).toBe(
      "chore(e2e): re-base 1 baseline on macOS 27.3 (26C12) — no UI changed",
    );
    expect(prose(one)).toContain("Of the one renderer-only file, 1 fails it and is re-based.");
    const bootstrap = commitMessage(facts([same(A)], { recorded: null, verdict: "unrecorded" }));
    expect(bootstrap.split("\n")[0]).toBe(
      "chore(e2e): record macOS 27.3 (26C12) as the baselines' renderer — no baseline changed",
    );
    expect(bootstrap).toContain("NO RENDERER RECORD");
    expect(bootstrap).not.toContain("Changed pixels");
    expect(bootstrap).not.toContain("Only what the gate itself fails");
  });

  /**
   * The commit is the lasting record of what proved it, so a HEAD no gate passed is said there,
   * in words true both of one with commits origin/main lacks and of one a push carried past.
   */
  test("a HEAD never pushed as origin/main's tip is said in the commit, with what vouched", () => {
    const recordOnly = prose(
      commitMessage(
        facts([same(A), passes(B)], { recorded: null, verdict: "unrecorded", pushed: false }),
      ),
    );
    expect(recordOnly).toContain("c3b9a59 was never pushed as origin/main's tip");
    expect(recordOnly).not.toContain("was not on origin/main");
    expect(recordOnly).toContain("no baseline was copied");
    const allowed = prose(commitMessage(facts([fails(A), fails(B)], { pushed: false })));
    expect(allowed).toContain("--allow-unpushed");
    expect(allowed).toContain("diffVerdict's content check alone vouches");
    expect(allowed).toContain("2 re-based files");
    expect(commitMessage(facts([fails(A)]))).not.toContain("origin/main");
  });

  test("a re-run that rescued a failure is said, not hidden, as what it re-ran", () => {
    const message = commitMessage(
      facts([fails(A)], {
        control: { passed: 602, rerun: "whole-suite" },
        gate: { passed: 602, rerun: "what-failed" },
      }),
    );
    expect(prose(message)).toContain(
      "602 passed, on one re-run of the whole suite after the first run failed.",
    );
    expect(prose(message)).toContain(
      "(E2E_GATE=1): 602 passed, after one re-run of what failed first.",
    );
    expect(prose(commitMessage(facts([fails(A)])))).not.toContain("re-run");
  });
});
