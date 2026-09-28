import { describe, expect, test } from "vitest";
import { diffVerdict, type DiffVerdict, type RawImage } from "./diff-verdict";
import type { RendererRecord } from "./fingerprint";
import { INK_SCALES } from "./ink-shift";
import {
  commitMessage,
  describeContent,
  describeRebased,
  describeTally,
  gateSentence,
  inkMargins,
  pairBaselines,
  parseRebaseArgs,
  planRebase,
  tally,
  UsageError,
  verdictTable,
  type CommitFacts,
  type Judged,
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

describe("inkMargins", () => {
  /** The lines are diffVerdict's own; reading them back must not drift from what it writes. */
  test("reads back every ink scale diffVerdict actually measured", () => {
    const blank = (): RawImage => ({
      width: 24,
      height: 24,
      data: new Uint8Array(24 * 24 * 4).fill(255),
    });
    const expected = blank();
    const actual = blank();
    for (const [img, x] of [
      [expected, 8],
      [actual, 9],
    ] as const) {
      for (let y = 6; y < 18; y++) img.data.fill(0, (y * 24 + x) * 4, (y * 24 + x) * 4 + 3);
    }
    const margins = inkMargins({ baseline: A, verdict: diffVerdict(expected, actual) });
    expect(margins.map((m) => m.scale).sort()).toEqual(INK_SCALES.map((s) => s.id).sort());
    for (const m of margins) {
      expect(m.limit).toBe(INK_SCALES.find((s) => s.id === m.scale)!.limit);
      expect(m.value).toBeGreaterThan(0);
    }
  });

  test("a verdict decided by size or by identical pixels has none", () => {
    expect(inkMargins(same(A))).toEqual([]);
  });
});

describe("tally", () => {
  const asked = (j: Judged, gate: "fails" | "passes"): Judged => ({ ...j, gate });

  test("how many renderer-only files the gate itself fails, when it was asked of each", () => {
    const d1 = drift(A, 0.002, 0.05, 0.01);
    const d2 = drift(B, 0.003, 0.05, 0.01);
    expect(tally([asked(d1, "fails"), asked(d2, "passes"), same(C)]).gateFails).toBe(1);
    // one file it could not be asked about makes the count unknown, never an undercount
    expect(tally([asked(d1, "fails"), d2]).gateFails).toBeNull();
    expect(tally([same(A)]).gateFails).toBe(0);
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

  test("an even count takes the mean of the middle two; none has no median at all", () => {
    const two = tally([drift(A, 0.001, 0.01, 0.01), drift(B, 0.003, 0.01, 0.01)]);
    expect(two.medianChangedFraction).toBeCloseTo(0.002, 12);
    const nothing = tally([same(A)]);
    expect(nothing.medianChangedFraction).toBeNull();
    expect(nothing.worst).toBeNull();
    expect(nothing.closest).toBeNull();
  });
});

describe("planRebase", () => {
  const full = (committed: string[]) =>
    pairBaselines(committed, committed.map((b) => b.slice("e2e/".length)), false);

  test("a missing or extra twin refuses before any verdict counts", () => {
    const pairing = pairBaselines([A, B], [A.slice("e2e/".length)], false);
    expect(planRebase("renderer-changed", pairing, tally([same(A)]))).toEqual({
      action: "refuse-unpaired",
      missing: [B],
      extra: [],
    });
  });

  test("one content verdict among a hundred drift ones refuses the lot", () => {
    const judged = [drift(A, 0.002, 0.05, 0.01), changed(B), drift(C, 0.002, 0.05, 0.01)];
    const plan = planRebase("renderer-changed", full([A, B, C]), tally(judged));
    expect(plan).toEqual({ action: "refuse-content", content: [judged[1]] });
  });

  test("renderer drift re-bases exactly the files that moved, never the identical ones", () => {
    const judged = [same(A), drift(B, 0.002, 0.05, 0.01), same(C)];
    const plan = planRebase("renderer-changed", full([A, B, C]), tally(judged));
    expect(plan).toEqual({ action: "rebase", files: [B], bootstrap: false });
  });

  /** The first run on a machine the baselines already match: record the renderer, move nothing. */
  test("no record and nothing changed is the bootstrap: the record alone", () => {
    expect(planRebase("unrecorded", full([A, B]), tally([same(A), same(B)]))).toEqual({
      action: "rebase",
      files: [],
      bootstrap: true,
    });
    expect(planRebase("renderer-changed", full([A]), tally([same(A)]))).toEqual({
      action: "rebase",
      files: [],
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

  test("the tally says what a rehearsal left out", () => {
    const lines = describeTally(tally([same(A), drift(B, 0.0023, 0.05, 0.01)]), 150);
    expect(lines).toContain("identical      1");
    expect(lines).toContain("renderer-only  1");
    expect(lines.at(-1)).toBe("150 committed baselines outside this rehearsal, not judged");
  });

  /** A re-base that moves files the gate passed must say why, or it reads as churn. */
  test("the gate's own count explains a re-base larger than what the gate failed", () => {
    const fails: Judged = { ...drift(A, 0.002, 0.05, 0.01), gate: "fails" };
    const passes: Judged = { ...drift(B, 0.002, 0.05, 0.01), gate: "passes" };
    expect(gateSentence(tally([fails, passes]))).toBe(
      "the gate itself fails 1 of the 2 renderer-only files; it passes the other 1 under " +
        "Playwright's colour threshold, and they are re-based too, so every baseline is exactly " +
        "what the recorded renderer draws",
    );
    expect(gateSentence(tally([fails]))).toBe("the gate itself fails the one renderer-only file");
    const both: Judged = { ...fails, baseline: B };
    const all = "the gate itself fails all 2 renderer-only files";
    expect(gateSentence(tally([fails, both]))).toBe(all);
    expect(gateSentence(tally([drift(A, 0.002, 0.05, 0.01)]))).toBeNull();
    const mixed = tally([fails, passes]);
    expect(describeTally(mixed, 0)).toContain(gateSentence(mixed));
  });

  test("the re-based files are listed most changed first, and every verdict is tabled", () => {
    const judged = [same(A), drift(B, 0.001, 0.05, 0.01), drift(C, 0.004, 0.0982, 0.0158)];
    expect(describeRebased(tally(judged).rendererOnly)).toEqual([` 0.40%  ${C}`, ` 0.10%  ${B}`]);
    const table = verdictTable(judged).trimEnd().split("\n");
    expect(table[0]).toBe(
      "baseline\tverdict\tdeciding\tchanged_px\tchanged_fraction\tmax_delta\tink_fine\tink_coarse",
    );
    expect(table).toHaveLength(4);
    expect(table[3]).toBe(`${C}\trenderer-only\tink-fine\t4000\t0.004000\t66\t0.0982\t0.0158`);
    expect(table[1]).toBe(`${A}\tidentical\tpixels\t0\t0.000000\t0\t\t`);
  });

  const RECORDED: RendererRecord = {
    canary: { pixelSha256: "a".repeat(64), sourceSha256: "c".repeat(64), width: 1280, height: 720 },
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

  function facts(judged: Judged[], overrides: Partial<CommitFacts> = {}): CommitFacts {
    const counts = tally(judged);
    const committed = judged.map((j) => j.baseline);
    const pairing = pairBaselines(committed, committed.map((b) => b.slice("e2e/".length)), false);
    const plan = planRebase("renderer-changed", pairing, counts);
    if (plan.action !== "rebase") throw new Error("expected a re-base");
    return {
      plan,
      counts,
      total: judged.length,
      verdict: "renderer-changed",
      recorded: RECORDED,
      current: CURRENT,
      head: { sha: "c3b9a59163994b2db7145ce4aea77bd806d66425", subject: "fix(pay): a payday" },
      control: { passed: 602, rerun: false },
      gate: { passed: 602, rerun: false },
      ...overrides,
    };
  }

  test("the commit message: the house subject, what moved, and the numbers behind it", () => {
    const judged = [same(A), drift(B, 0.0023, 0.05, 0.01), drift(C, 0.0059, 0.0982, 0.0158)];
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
    expect(text).toContain("median 0.41%");
    expect(text).toContain(`worst 0.59% (${C})`);
    expect(text).toContain("ink-fine 0.0982 of 0.18 (1.83x under)");
    expect(message.endsWith("\n")).toBe(true);
    for (const line of message.split("\n")) expect(line.length, line).toBeLessThanOrEqual(92);
  });

  test("one baseline is singular, and a record-only run says no baseline changed", () => {
    expect(commitMessage(facts([drift(A, 0.002, 0.05, 0.01)])).split("\n")[0]).toBe(
      "chore(e2e): re-base 1 baseline on macOS 27.3 (26C12) — no UI changed",
    );
    const bootstrap = commitMessage(facts([same(A)], { recorded: null, verdict: "unrecorded" }));
    expect(bootstrap.split("\n")[0]).toBe(
      "chore(e2e): record macOS 27.3 (26C12) as the baselines' renderer — no baseline changed",
    );
    expect(bootstrap).toContain("NO RENDERER RECORD");
    expect(bootstrap).not.toContain("Changed pixels");
  });

  test("the commit message says how many of the re-based files the gate itself failed", () => {
    const fails: Judged = { ...drift(A, 0.002, 0.05, 0.01), gate: "fails" };
    const passes: Judged = { ...drift(B, 0.002, 0.05, 0.01), gate: "passes" };
    const message = commitMessage(facts([fails, passes])).replaceAll("\n", " ");
    expect(message).toContain("By its own comparator the gate fails 1 of the 2 renderer-only");
  });

  test("a re-run that rescued a failure is said, not hidden", () => {
    const message = commitMessage(
      facts([drift(A, 0.002, 0.05, 0.01)], { control: { passed: 602, rerun: true } }),
    ).replaceAll("\n", " ");
    expect(message).toContain("602 passed, after one re-run of what failed first");
  });
});
