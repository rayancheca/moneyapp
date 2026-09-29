import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import {
  applyAndVerify,
  describeRed,
  isGreen,
  onStopSignal,
  outcomeFromReport,
  passedInTheEnd,
  runWithOneRerun,
  STOP_SIGNALS,
  type Attempt,
  type SuiteOutcome,
} from "./suite-run";

const COLOURED_ERROR =
  "\u001b[31mError: expect(locator).toHaveText(expected)\u001b[39m\n\nExpected: 3";
const PASSED = { projectName: "chromium", status: "expected", results: [{ status: "passed" }] };
const NO_STATS = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };

/** The shape Playwright 1.61's JSON reporter writes, cut down to what the command reads. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    config: { version: "1.61.1" },
    suites: [
      {
        title: "visual.spec.ts",
        file: "visual.spec.ts",
        specs: [],
        suites: [
          {
            title: "accounts",
            specs: [
              {
                title: "dark 1440",
                ok: false,
                tests: [
                  {
                    projectName: "chromium",
                    status: "unexpected",
                    results: [
                      {
                        status: "failed",
                        errors: [{ message: COLOURED_ERROR }],
                      },
                    ],
                  },
                ],
              },
              {
                title: "light 1440",
                ok: true,
                tests: [PASSED],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
    stats: { expected: 601, unexpected: 1, flaky: 0, skipped: 0 },
    ...overrides,
  };
}

const green = (passed = 602): SuiteOutcome => ({
  exitCode: 0,
  passed,
  flaky: 0,
  skipped: 0,
  failed: [],
  globalErrors: [],
});
const TIMEOUT = "Timeout 30000ms exceeded";
const red = (titles: string[], passed = 600): SuiteOutcome => ({
  exitCode: 1,
  passed,
  flaky: 0,
  skipped: 0,
  failed: titles.map((title) => ({ title, project: "chromium", error: TIMEOUT })),
  globalErrors: [],
});
const setupThrew: SuiteOutcome = {
  exitCode: 1,
  passed: 0,
  flaky: 0,
  skipped: 0,
  failed: [],
  globalErrors: ["e2e: THE BOX IS ALREADY BUSY — load average 31.0 across 15 cores"],
};

describe("outcomeFromReport", () => {
  test("a failed test by its full title, its project, and its first plain error line", () => {
    const outcome = outcomeFromReport(1, report());
    expect(outcome.passed).toBe(601);
    expect(outcome.failed).toEqual([
      {
        title: "visual.spec.ts › accounts › dark 1440",
        project: "chromium",
        error: "Error: expect(locator).toHaveText(expected)",
      },
    ]);
    expect(outcome.globalErrors).toEqual([]);
  });

  test("an error outside any test is a global error", () => {
    const outcome = outcomeFromReport(
      1,
      report({
        suites: [],
        errors: [{ message: "Error: localhost:3111 is already used" }],
        stats: NO_STATS,
      }),
    );
    expect(outcome.globalErrors).toEqual(["Error: localhost:3111 is already used"]);
    expect(isGreen(outcome)).toBe(false);
  });

  /** A run that died before reporting has said nothing, and nothing is never green. */
  test("no report, or one Playwright never writes, is a global error", () => {
    expect(outcomeFromReport(0, null).globalErrors[0]).toMatch(/no JSON report/);
    const foreign = outcomeFromReport(0, { stats: "?" });
    expect(foreign.globalErrors[0]).toMatch(/not one Playwright writes/);
    expect(isGreen(outcomeFromReport(0, null))).toBe(false);
  });
});

describe("isGreen", () => {
  test("exit 0, nothing failed, and something ran", () => {
    expect(isGreen(green())).toBe(true);
    expect(isGreen(green(0))).toBe(false);
    expect(isGreen({ ...green(), exitCode: 1 })).toBe(false);
    expect(isGreen({ ...green(), exitCode: null })).toBe(false);
    expect(isGreen(red(["a"]))).toBe(false);
  });
});

/** Replays a fixed list of outcomes and records what each attempt asked for. */
function scripted(outcomes: SuiteOutcome[]) {
  const asked: Attempt[] = [];
  const run = async (attempt: Attempt) => {
    asked.push(attempt);
    const next = outcomes.shift();
    if (next === undefined) throw new Error("ran more often than scripted");
    return next;
  };
  return { asked, run };
}

describe("runWithOneRerun", () => {
  test("green the first time runs once", async () => {
    const s = scripted([green()]);
    expect(await runWithOneRerun(s.run)).toEqual({ green: true, attempts: [green()] });
    expect(s.asked).toEqual([{ lastFailed: false }]);
  });

  test("a failure gets one re-run of what failed, and passing it is green", async () => {
    const s = scripted([red(["a", "b"]), green(2)]);
    const runs = await runWithOneRerun(s.run);
    expect(runs.green).toBe(true);
    expect(s.asked).toEqual([{ lastFailed: false }, { lastFailed: true }]);
    expect(passedInTheEnd(runs)).toBe(602);
  });

  test("failing the re-run too is red, and there is no third run", async () => {
    const s = scripted([red(["a", "b"]), red(["b"], 1)]);
    const runs = await runWithOneRerun(s.run);
    expect(runs.green).toBe(false);
    expect(runs.attempts).toHaveLength(2);
    expect(describeRed(runs)[0]).toBe("2 failed; the one re-run of those still failed 1:");
  });

  /** --last-failed with nothing recorded as failed would run the whole suite a second time. */
  test("a run that failed outside any test is not re-run", async () => {
    const s = scripted([setupThrew]);
    const runs = await runWithOneRerun(s.run);
    expect(runs).toEqual({ green: false, attempts: [setupThrew] });
    expect(describeRed(runs)).toEqual([`  ✗ ${setupThrew.globalErrors[0]}`]);

    const silent = scripted([{ ...green(), exitCode: 1 }]);
    expect((await runWithOneRerun(silent.run)).attempts).toHaveLength(1);
  });
});

describe("describeRed", () => {
  test("names each failure, up to twenty-five", () => {
    const titles = Array.from({ length: 30 }, (_, i) => `visual.spec.ts › page ${i}`);
    const lines = describeRed({ green: false, attempts: [red(titles)] });
    expect(lines[0]).toBe("30 failed:");
    expect(lines).toContain("  ✗ [chromium] visual.spec.ts › page 0");
    expect(lines).toContain(`      ${TIMEOUT}`);
    expect(lines).not.toContain("  ✗ [chromium] visual.spec.ts › page 25");
    expect(lines.at(-1)).toBe("  … and 5 more");
  });

  test("a run with no test and no error still says why it is not green", () => {
    const nothingRan = describeRed({ green: false, attempts: [green(0)] });
    expect(nothingRan).toEqual(["  ✗ no test ran (exit 0)"]);
  });
});

/** Effects that record what was done, with a gate that answers from a script. */
function effects(
  gate: SuiteOutcome[],
  fail: { copy?: string; restore?: string; mark?: string; clear?: string } = {},
) {
  const done: string[] = [];
  const s = scripted(gate);
  return {
    done,
    fx: {
      markPending: (files: readonly string[]) => {
        if (fail.mark !== undefined) throw new Error(fail.mark);
        done.push(files.length === 0 ? "mark" : `mark ${files.join(",")}`);
      },
      clearPending: () => {
        if (fail.clear !== undefined) throw new Error(fail.clear);
        done.push("clear");
      },
      copyTwin: (baseline: string) => {
        if (baseline === fail.copy) throw new Error(`EACCES: ${baseline}`);
        done.push(`copy ${baseline}`);
      },
      writeRecord: () => done.push("record"),
      runGate: async (attempt: Attempt) => {
        done.push(attempt.lastFailed ? "gate --last-failed" : "gate");
        return s.run(attempt);
      },
      restore: (baselines: readonly string[]) => {
        if (fail.restore !== undefined) throw new Error(fail.restore);
        done.push(`restore ${baselines.join(",")}`);
      },
    },
  };
}

const LOCKED = "1 file(s) could not be put back as HEAD has them: e2e/a.png (index.lock exists)";

describe("applyAndVerify", () => {
  test("copies, records, and keeps it all when the gate is green", async () => {
    const { done, fx } = effects([green()]);
    const applied = await applyAndVerify(["a.png", "b.png"], fx);
    expect(applied.verified).toBe(true);
    expect(done).toEqual([
      "mark a.png,b.png",
      "copy a.png",
      "copy b.png",
      "record",
      "gate",
      "clear",
    ]);
  });

  test("a gate red after its one re-run puts every file back", async () => {
    const { done, fx } = effects([red(["x"]), red(["x"], 0)]);
    const applied = await applyAndVerify(["a.png", "b.png"], fx);
    expect(applied.verified).toBe(false);
    expect(done).toEqual([
      "mark a.png,b.png",
      "copy a.png",
      "copy b.png",
      "record",
      "gate",
      "gate --last-failed",
      "restore a.png,b.png",
      "clear",
    ]);
  });

  test("a failure part way through copying puts back the whole list, then says why", async () => {
    const { done, fx } = effects([green()], { copy: "b.png" });
    await expect(applyAndVerify(["a.png", "b.png", "c.png"], fx)).rejects.toThrow(/EACCES/);
    expect(done).toEqual([
      "mark a.png,b.png,c.png",
      "copy a.png",
      "restore a.png,b.png,c.png",
      "clear",
    ]);
  });

  test("a gate that cannot even start puts every file back too", async () => {
    const { done, fx } = effects([]);
    await expect(applyAndVerify(["a.png"], fx)).rejects.toThrow(/more often than scripted/);
    expect(done.slice(-2)).toEqual(["restore a.png", "clear"]);
  });

  test("the bootstrap copies nothing and still records and verifies", async () => {
    const { done, fx } = effects([green()]);
    expect((await applyAndVerify([], fx)).verified).toBe(true);
    expect(done).toEqual(["mark", "record", "gate", "clear"]);
  });

  /**
   * A restore that throws must not become the command's crash: the caller has still to say what
   * is left in e2e/ ("NOT AS HEAD HAS IT"), and a rejection here skipped exactly that.
   */
  test("a restore that fails after a red gate is answered with the red gate, and why", async () => {
    const { fx } = effects([red(["x"]), red(["x"], 0)], { restore: LOCKED });
    const applied = await applyAndVerify(["a.png"], fx);
    expect(applied.verified).toBe(false);
    expect(applied.gate.attempts).toHaveLength(2);
    expect(applied.notRestored).toBe(LOCKED);
  });

  test("a green gate or a restore that held leaves nothing unrestored to report", async () => {
    expect((await applyAndVerify(["a.png"], effects([green()]).fx)).notRestored).toBeNull();
    const red2 = effects([red(["x"]), red(["x"], 0)]).fx;
    expect((await applyAndVerify(["a.png"], red2)).notRestored).toBeNull();
  });

  /** The error that stopped the re-base is the headline; a failed restore after it is added. */
  test("a restore that fails after an error keeps that error, and adds why", async () => {
    const { fx } = effects([green()], { copy: "b.png", restore: LOCKED });
    const stopped = applyAndVerify(["a.png", "b.png"], fx);
    await expect(stopped).rejects.toThrow(/^EACCES: b\.png/);
    await expect(stopped).rejects.toThrow(LOCKED);
  });

  /**
   * The mark is the next run's only way to know a --confirm never heard its gate pass: it is left
   * before the first file is written, and taken away only when nothing unverified is left.
   */
  test("a restore that fails keeps the mark, so the next run puts the files back", async () => {
    const { done, fx } = effects([red(["x"]), red(["x"], 0)], { restore: LOCKED });
    await applyAndVerify(["a.png"], fx);
    expect(done).toEqual(["mark a.png", "copy a.png", "record", "gate", "gate --last-failed"]);
  });

  test("a mark that cannot be taken away after a restore never replaces the error", async () => {
    const { fx } = effects([green()], { copy: "b.png", clear: "EPERM: the pending mark" });
    const stopped = applyAndVerify(["a.png", "b.png"], fx);
    await expect(stopped).rejects.toThrow(/^EACCES: b\.png/);
    await expect(stopped).rejects.toThrow(/EPERM: the pending mark/);
  });

  test("a mark that cannot be left stops the re-base before anything is written", async () => {
    const { done, fx } = effects([green()], { mark: "EROFS: .git" });
    await expect(applyAndVerify(["a.png"], fx)).rejects.toThrow(/EROFS/);
    expect(done).toEqual([]);
  });
});

describe("onStopSignal", () => {
  /**
   * tsx relays only SIGINT and SIGTERM. A terminal or session that closes sends SIGHUP, whose
   * default kills the run with twins and a record written and unverified.
   */
  test("a closed terminal's SIGHUP is heard, as SIGINT and SIGTERM are", () => {
    expect(STOP_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    const target = new EventEmitter();
    const heard: string[] = [];
    const stop = onStopSignal((signal) => heard.push(signal), target);
    target.emit("SIGHUP", "SIGHUP");
    expect(heard).toEqual(["SIGHUP"]);
    // `once`: the one that fired is gone, the other two wait for stop()
    for (const signal of STOP_SIGNALS) {
      expect(target.listenerCount(signal), signal).toBe(signal === "SIGHUP" ? 0 : 1);
    }
    stop();
    for (const signal of STOP_SIGNALS) expect(target.listenerCount(signal), signal).toBe(0);
  });
});
