import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BASELINE_RENDERER_PATH,
  baselineRefusal,
  checkRendererForRun,
  compareRecord,
  currentEnvironment,
  describeRendererCheck,
  LAST_MATCH_NAME,
  lastMatchPath,
  readLastMatch,
  readRecord,
  REBASE_RENDERER_COMMAND,
  rememberMatch,
  RENDERER_CHECK_ENV,
  RENDERER_REFUSAL_ENV,
  rendererMismatchMessage,
  rendererRefusal,
  runKindOf,
  writeRecord,
  type RendererRecord,
  type RunKind,
} from "./fingerprint";

const PIXELS_BEFORE = "a7e111bb233faec6f7e1151efdc15b886b1f78209bcb54827664f3cd8320ad1f";
const PIXELS_AFTER = "3df6722d28b970ee0123456789abcdef0123456789abcdef0123456789abcdef";
const SOURCE_BEFORE = "34640c8f9377bb56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_AFTER = "84cf666e46613878bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FONTS_BEFORE = "5e0f1a2b3c4d5e6fdddddddddddddddddddddddddddddddddddddddddddddddd";
const FONTS_AFTER = "9a8b7c6d5e4f3a2beeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** The renderer the baselines were re-based on, 2026-09-28. */
const RECORDED: RendererRecord = {
  canary: {
    pixelSha256: PIXELS_BEFORE,
    sourceSha256: SOURCE_BEFORE,
    fontSha256: FONTS_BEFORE,
    width: 1280,
    height: 720,
  },
  recordedOn: "2026-09-28T19:02:11.000Z",
  macos: { productVersion: "27.2", buildVersion: "26B5091g" },
  playwright: "1.61.1",
  chromiumRevision: "1228",
};

function withCanary(
  record: RendererRecord,
  canary: Partial<RendererRecord["canary"]>,
): RendererRecord {
  return { ...record, canary: { ...record.canary, ...canary } };
}

/** The same machine after an OS update that moved text antialiasing. */
const AFTER_OS_UPDATE: RendererRecord = {
  ...withCanary(RECORDED, { pixelSha256: PIXELS_AFTER }),
  recordedOn: "2026-10-30T12:00:00.000Z",
  macos: { productVersion: "27.3", buildVersion: "26C12" },
};

/** A month on: Playwright 1.62 rolled Chromium and the canary still matched the record. */
const LAST_MATCH: RendererRecord = {
  ...RECORDED,
  recordedOn: "2026-10-20T08:00:00.000Z",
  playwright: "1.62.0",
  chromiumRevision: "1240",
};

/** Then macOS moved, and the canary with it. */
const AFTER_BOTH: RendererRecord = {
  ...withCanary(LAST_MATCH, { pixelSha256: PIXELS_AFTER }),
  recordedOn: "2026-10-30T12:00:00.000Z",
  macos: { productVersion: "27.3", buildVersion: "26C12" },
};

describe("compareRecord", () => {
  test("no record at all is unrecorded, whatever this machine draws", () => {
    expect(compareRecord(null, RECORDED)).toBe("unrecorded");
  });

  test("the same canary pixels from the same source match", () => {
    expect(compareRecord(RECORDED, { ...RECORDED, recordedOn: "2026-10-01T00:00:00.000Z" })).toBe(
      "match",
    );
  });

  /**
   * The pixels are the arbiter, not the version strings. Chromium 147, 148, 149 and 151 all
   * drew the canary identically on 2026-09-28; refusing a run because a version moved would
   * cry wolf on exactly the updates that change nothing, and teach everyone to skip the check.
   */
  test("versions that moved without moving a pixel still match", () => {
    const upgraded: RendererRecord = {
      ...RECORDED,
      macos: { productVersion: "27.3", buildVersion: "26C12" },
      playwright: "1.62.0",
      chromiumRevision: "1234",
    };
    expect(compareRecord(RECORDED, upgraded)).toBe("match");
  });

  test("different pixels from the same source are a renderer change", () => {
    expect(compareRecord(RECORDED, AFTER_OS_UPDATE)).toBe("renderer-changed");
  });

  test("a different canary size is a renderer change even when the hash agrees", () => {
    expect(compareRecord(RECORDED, withCanary(RECORDED, { width: 1279 }))).toBe("renderer-changed");
    expect(compareRecord(RECORDED, withCanary(RECORDED, { height: 721 }))).toBe("renderer-changed");
  });

  /**
   * A changed source means the recorded pixels belong to another page, so comparing them says
   * nothing about the renderer, in either direction.
   */
  test("a changed canary source wins over any pixel comparison", () => {
    expect(compareRecord(RECORDED, withCanary(RECORDED, { sourceSha256: SOURCE_AFTER }))).toBe(
      "canary-changed",
    );
    const both = withCanary(AFTER_OS_UPDATE, { sourceSha256: SOURCE_AFTER });
    expect(compareRecord(RECORDED, both)).toBe("canary-changed");
  });

  /**
   * The canary embeds the Geist files the app ships, so a Geist upgrade changes its source too.
   * That is the app's own change, moving every baseline with text, and not a renderer's: it is
   * told apart from an edit to the canary page, whatever the pixels or the page say.
   */
  test("changed Geist files are the app's fonts changing, not the canary", () => {
    const geist = withCanary(RECORDED, { fontSha256: FONTS_AFTER, sourceSha256: SOURCE_AFTER });
    expect(compareRecord(RECORDED, geist)).toBe("fonts-changed");
    const alsoTheMac = withCanary(AFTER_OS_UPDATE, {
      fontSha256: FONTS_AFTER,
      sourceSha256: SOURCE_AFTER,
    });
    expect(compareRecord(RECORDED, alsoTheMac)).toBe("fonts-changed");
  });
});

describe("rendererMismatchMessage", () => {
  test("a renderer change names what moved, from what to what", () => {
    const message = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE);
    expect(message).toMatch(/THE RENDERER CHANGED/);
    expect(message).toContain("macOS       27.2 (26B5091g) → 27.3 (26C12)");
    expect(message).toContain("chromium    r1228  (unchanged)");
    expect(message).toContain("playwright  1.61.1  (unchanged)");
    expect(message).toContain("a7e111bb233f → 3df6722d28b9  (1280×720)");
    expect(message).toContain("recorded 2026-09-28");
  });

  test("a canary that changed size says from what to what", () => {
    const resized = withCanary(AFTER_OS_UPDATE, { width: 1279 });
    expect(rendererMismatchMessage("renderer-changed", RECORDED, resized)).toContain(
      "(1280×720 → 1279×720)",
    );
  });

  test("a failure could be the Mac and NOT the change under test; it gives the fix", () => {
    const message = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE);
    expect(message).toMatch(/NOT the change under test/);
    expect(message).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
    expect(message).toContain(`${RENDERER_CHECK_ENV}=skip`);
  });

  test("when no version moved it says the change is beneath them", () => {
    const sameVersions = withCanary(RECORDED, { pixelSha256: PIXELS_AFTER });
    const message = rendererMismatchMessage("renderer-changed", RECORDED, sameVersions);
    expect(message).toMatch(/none of those versions moved/i);
    expect(message).toContain("macOS       27.2 (26B5091g)  (unchanged)");
  });

  test("a changed canary page names both sources, and that the fonts did not move", () => {
    const current = withCanary(RECORDED, { sourceSha256: SOURCE_AFTER });
    const message = rendererMismatchMessage("canary-changed", RECORDED, current);
    expect(message).toMatch(/THE RENDERER CANARY ITSELF CHANGED/);
    expect(message).toContain("34640c8f9377");
    expect(message).toContain("84cf666e4661");
    expect(message).toContain("scripts/e2e-renderer/canary.ts");
    expect(message).toMatch(/Geist files are the ones recorded/);
    expect(message).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
  });

  /**
   * `pnpm e2e:rebase-renderer --confirm` is not the fix for a Geist upgrade: it would copy the
   * font's own drift over the baselines as though the Mac had moved. The baselines belong to the
   * commit that changed the font, like any UI change; the command only records the renderer after.
   */
  test("changed Geist files are named a UI change, whose baselines are redrawn with it", () => {
    const current = withCanary(RECORDED, { fontSha256: FONTS_AFTER, sourceSha256: SOURCE_AFTER });
    const message = rendererMismatchMessage("fonts-changed", RECORDED, current);
    expect(message).toMatch(/THE APP'S FONTS CHANGED/);
    expect(message).toContain("node_modules/geist");
    expect(message).toContain("5e0f1a2b3c4d");
    expect(message).toContain("9a8b7c6d5e4f");
    expect(message).toMatch(/a UI change/);
    expect(message).toContain("E2E_RENDERER_CHECK=skip pnpm e2e:update");
    expect(message).not.toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
    expect(message).toMatch(/copies no twin while the fonts differ from the record/);
  });

  /**
   * The canary compares a hash of raw RGBA; the gate counts a pixel only past Playwright's colour
   * threshold and never one pixelmatch takes for anti-aliasing. On 2026-09-28 macOS 27.2 failed
   * 107 of 202 baselines, and 20 dark pages it moved by 931 to 6,394 pixels still passed. So a
   * moved canary says the pixels under the baselines moved, not how many the gate would fail.
   */
  test("it claims no count of failing baselines: the canary is exact, the gate is not", () => {
    const message = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE);
    expect(message).not.toMatch(/nearly every baseline with text in it would now fail/i);
    expect(message).toMatch(/not known until they are drawn/);
    expect(message).toMatch(/107 of the 202/);
    expect(message).toMatch(/20 dark pages/);
    expect(message).toMatch(/records the renderer alone when the gate fails none/);
  });

  /**
   * The record is written only when the canary moves, so its versions go stale on every update
   * that draws the canary identically. Read against it, a Chromium roll that matched for weeks
   * is listed beside the macOS update that actually moved the canary.
   */
  test("what moved is read since the canary last matched on this machine", () => {
    const message = rendererMismatchMessage(
      "renderer-changed",
      RECORDED,
      AFTER_BOTH,
      BASELINE_RENDERER_PATH,
      { lastMatch: LAST_MATCH },
    );
    expect(message).toContain("since the canary last matched on this machine, 2026-10-20");
    expect(message).toContain("macOS       27.2 (26B5091g) → 27.3 (26C12)");
    expect(message).toContain("chromium    r1240  (unchanged)");
    expect(message).toContain("playwright  1.62.0  (unchanged)");
    expect(message).toContain("recorded 2026-09-28");
  });

  test("with no match remembered, it reads since the record and says a move may be old", () => {
    const message = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_BOTH);
    expect(message).toContain("since the record was written, 2026-09-28");
    expect(message).toMatch(/may have moved long before/);
    expect(message).toContain("chromium    r1228 → r1240");
  });

  test("a match remembered against another canary is not this record's, and is ignored", () => {
    const another = withCanary(LAST_MATCH, { pixelSha256: PIXELS_AFTER });
    const message = rendererMismatchMessage(
      "renderer-changed",
      RECORDED,
      AFTER_BOTH,
      BASELINE_RENDERER_PATH,
      { lastMatch: another },
    );
    expect(message).not.toContain("last matched");
    expect(message).toContain("chromium    r1228 → r1240");
  });

  test("nothing moved since the last match: the change is beneath the versions", () => {
    const current: RendererRecord = {
      ...withCanary(LAST_MATCH, { pixelSha256: PIXELS_AFTER }),
      recordedOn: "2026-10-30T12:00:00.000Z",
    };
    const message = rendererMismatchMessage(
      "renderer-changed",
      RECORDED,
      current,
      BASELINE_RENDERER_PATH,
      { lastMatch: LAST_MATCH },
    );
    expect(message).toMatch(/none of those versions moved, so something beneath them did/i);
    expect(message).toContain("chromium    r1240  (unchanged)");
  });

  test("a missing record says what this machine would record", () => {
    const message = rendererMismatchMessage("unrecorded", null, RECORDED, "e2e/elsewhere.json");
    expect(message).toMatch(/NO RENDERER RECORD/);
    expect(message).toContain("e2e/elsewhere.json does not exist");
    expect(message).toContain("macOS 27.2 (26B5091g) · chromium r1228 · playwright 1.61.1");
    expect(message).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
    expect(message).toContain(`${RENDERER_CHECK_ENV}=skip`);
  });
});

describe("readRecord and writeRecord", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-record-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the record lives beside the baselines it describes", () => {
    expect(BASELINE_RENDERER_PATH).toBe("e2e/baseline-renderer.json");
  });

  test("a written record reads back unchanged, keys in the documented order", () => {
    const file = path.join(dir, "baseline-renderer.json");
    writeRecord(RECORDED, file);
    expect(readRecord(file)).toEqual(RECORDED);
    const text = fs.readFileSync(file, "utf8");
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "canary",
      "recordedOn",
      "macos",
      "playwright",
      "chromiumRevision",
    ]);
    expect(text.endsWith("}\n")).toBe(true);
  });

  test("a missing record reads as null, not as an error", () => {
    expect(readRecord(path.join(dir, "absent.json"))).toBeNull();
  });

  test("a record that is not JSON is refused, naming the file", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => readRecord(file)).toThrow(file);
  });

  /** A truncated hash would compare unequal forever and read as a renderer change every run. */
  test("a record with a malformed field is refused, naming the field", () => {
    const file = path.join(dir, "bad-sha.json");
    fs.writeFileSync(file, JSON.stringify(withCanary(RECORDED, { pixelSha256: "a7e111bb" })));
    expect(() => readRecord(file)).toThrow(/canary\.pixelSha256/);
  });

  test("a malformed record is never written", () => {
    const file = path.join(dir, "never.json");
    expect(() => writeRecord(withCanary(RECORDED, { width: 0 }), file)).toThrow(/canary\.width/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("the last match", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-last-match-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a remembered match reads back, and none reads as null", () => {
    const file = path.join(dir, LAST_MATCH_NAME);
    expect(readLastMatch(file)).toBeNull();
    rememberMatch(LAST_MATCH, file);
    expect(readLastMatch(file)).toEqual(LAST_MATCH);
    rememberMatch(RECORDED, file);
    expect(readLastMatch(file)).toEqual(RECORDED);
  });

  test("a note that is not a record is refused, naming the file", () => {
    const file = path.join(dir, LAST_MATCH_NAME);
    fs.writeFileSync(file, JSON.stringify({ canary: {} }));
    expect(() => readLastMatch(file)).toThrow(file);
  });

  /**
   * The note belongs to this machine and its node_modules, which every worktree shares, and never
   * to a commit: it lives in git's common directory, where no worktree's status can see it.
   */
  test("it lives in git's common directory, beside git's own files", () => {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
    expect(lastMatchPath()).toBe(path.resolve(common.trim(), LAST_MATCH_NAME));
    expect(LAST_MATCH_NAME).toBe("e2e-renderer-last-match.json");
  });
});

describe("runKindOf", () => {
  test("E2E_GATE set, to anything, is a gate, whatever it does with snapshots", () => {
    expect(runKindOf({ E2E_GATE: "1" }, "none")).toBe("gate");
    expect(runKindOf({ E2E_GATE: "yes" }, "changed")).toBe("gate");
  });

  test("--update-snapshots, bare (changed) or all, redraws baselines rather than comparing", () => {
    expect(runKindOf({}, "changed")).toBe("update");
    expect(runKindOf({ E2E_GATE: "" }, "all")).toBe("update");
  });

  test("anything else compares", () => {
    expect(runKindOf({}, "missing")).toBe("compare");
    expect(runKindOf({}, "none")).toBe("compare");
    expect(runKindOf({}, undefined)).toBe("compare");
  });
});

describe("checkRendererForRun", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-check-"));
    file = path.join(dir, "baseline-renderer.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const GATE = { E2E_GATE: "1" };

  test("skip bypasses the check without launching a browser", async () => {
    const measure = vi.fn(async () => RECORDED);
    const check = await checkRendererForRun({
      file,
      env: { [RENDERER_CHECK_ENV]: "skip" },
      measure,
    });
    expect(check).toEqual({ verdict: "skipped" });
    expect(measure).not.toHaveBeenCalled();
  });

  /** Stands in for a real render, which the canary's own proof covers. */
  const measured = (record: RendererRecord) => async (): Promise<RendererRecord> => record;

  /** A typo that silently ran the check anyway would look like the bypass failing. */
  test("any other value of the switch is refused rather than guessed at", async () => {
    const env = { [RENDERER_CHECK_ENV]: "off" };
    await expect(checkRendererForRun({ file, env, measure: measured(RECORDED) })).rejects.toThrow(
      `${RENDERER_CHECK_ENV}=off`,
    );
  });

  test("a matching renderer passes and returns both sides", async () => {
    writeRecord(RECORDED, file);
    const measure = measured(RECORDED);
    const check = await checkRendererForRun({ file, env: GATE, measure });
    expect(check).toEqual({ verdict: "match", recorded: RECORDED, current: RECORDED });
  });

  /**
   * A gate compares every committed baseline, and any failure could be the Mac's: it stops in a
   * second, before seeding, rather than after a whole run of failures that are not its change.
   */
  test("a gate is stopped by a changed renderer, with exactly the one message", async () => {
    writeRecord(RECORDED, file);
    const expected = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE, file, {
      run: "gate",
    });
    await expect(
      checkRendererForRun({ file, env: GATE, measure: measured(AFTER_OS_UPDATE) }),
    ).rejects.toThrow(expected);
  });

  /**
   * Only 4 of 60 spec files compare a committed baseline. A run that is not a gate goes on, so a
   * spec that compares none (zz-budgets, a11y, keyboard, hydration) is not stopped for a Mac it
   * never asks about; each comparison with a committed baseline refuses instead (expectBaseline).
   */
  test("any other run goes on, with the refusal each comparison throws", async () => {
    writeRecord(RECORDED, file);
    const check = await checkRendererForRun({ file, env: {}, measure: measured(AFTER_OS_UPDATE) });
    expect(check).toEqual({
      verdict: "renderer-changed",
      run: "compare",
      message: rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE, file, {
        run: "compare",
      }),
      refusal: rendererRefusal("renderer-changed", file),
    });
  });

  test("an update run goes on too, and is told why it redraws no baseline", async () => {
    writeRecord(RECORDED, file);
    const check = await checkRendererForRun({
      file,
      env: {},
      updateSnapshots: "changed",
      measure: measured(AFTER_OS_UPDATE),
    });
    expect(check).toMatchObject({ verdict: "renderer-changed", run: "update" });
    expect(check.verdict !== "skipped" && "message" in check && prose(check.message)).toMatch(
      /redraws no baseline/,
    );
  });

  test("no record stops a gate, pointing at the command that records one", async () => {
    await expect(
      checkRendererForRun({ file, env: GATE, measure: measured(RECORDED) }),
    ).rejects.toThrow(/NO RENDERER RECORD/);
  });

  test("no record lets any other run go on, refusing its comparisons", async () => {
    const check = await checkRendererForRun({ file, env: {}, measure: measured(RECORDED) });
    expect(check).toMatchObject({
      verdict: "unrecorded",
      run: "compare",
      refusal: rendererRefusal("unrecorded", file),
    });
  });

  test("a mismatch dates what moved by the last match, asked for only then", async () => {
    writeRecord(RECORDED, file);
    const lastMatch = vi.fn(() => LAST_MATCH);
    await checkRendererForRun({ file, env: {}, measure: measured(RECORDED), lastMatch });
    expect(lastMatch).not.toHaveBeenCalled();
    const check = await checkRendererForRun({
      file,
      env: {},
      measure: measured(AFTER_BOTH),
      lastMatch,
    });
    expect(check.verdict !== "skipped" && "message" in check && check.message).toContain(
      "since the canary last matched on this machine, 2026-10-20",
    );
  });
});

/** The message read as prose: its continuation lines joined again. */
const prose = (text: string) => text.replace(/\n +/g, " ");

describe("what each run is told", () => {
  const verdicts = [
    ["unrecorded", null, RECORDED],
    ["canary-changed", RECORDED, withCanary(RECORDED, { sourceSha256: SOURCE_AFTER })],
    ["fonts-changed", RECORDED, withCanary(RECORDED, { fontSha256: FONTS_AFTER })],
    ["renderer-changed", RECORDED, AFTER_OS_UPDATE],
  ] as const;

  /** Every verdict's message for one kind of run, read as prose. */
  const toldTo = (run: RunKind) =>
    verdicts.map(
      ([verdict, recorded, current]) =>
        [
          verdict,
          prose(
            rendererMismatchMessage(verdict, recorded, current, BASELINE_RENDERER_PATH, { run }),
          ),
        ] as const,
    );

  test("a gate, that it stopped before seeding", () => {
    for (const [verdict, text] of toldTo("gate")) {
      expect(text, verdict).toMatch(/The gate stopped here, before seeding/);
      expect(text, verdict).not.toMatch(/This run goes on/);
    }
  });

  test("any other run, that it goes on, and that only its comparisons with a baseline stop", () => {
    for (const [verdict, text] of toldTo("compare")) {
      expect(text, verdict).toMatch(
        /This run goes on, but compares no screenshot with a committed baseline/,
      );
      expect(text, verdict).toMatch(/Specs that compare no baseline run as usual/);
      expect(text, verdict).not.toMatch(/stopped here/);
    }
  });

  /**
   * Redrawn on a moved renderer, a baseline carries the Mac's drift with the change under test,
   * and neither its diff nor crop-visual-diff can tell the two apart: that is the premise an
   * update run is stopped on, not "would now fail".
   */
  test("an update run, that it redraws none, and why", () => {
    for (const [verdict, text] of toldTo("update")) {
      expect(text, verdict).toMatch(/This run goes on, but redraws no baseline/);
      expect(text, verdict).toMatch(/no diff could tell the two apart/);
    }
  });

  /** An agent mid-change would otherwise meet the command's guards only once it ran it. */
  test("the re-base fix says it needs a clean tree and runs the suite twice", () => {
    for (const [verdict, text] of toldTo("gate")) {
      if (verdict === "fonts-changed") continue;
      expect(text, verdict).toMatch(/runs the whole suite twice/);
      expect(text, verdict).toMatch(
        /needs a clean tree, so commit or stash work in progress first/,
      );
    }
  });
});

describe("rendererRefusal", () => {
  test("it names the verdict and the record, points at the top of the run, gives the fix", () => {
    const refusal = rendererRefusal("renderer-changed", "e2e/elsewhere.json");
    expect(refusal).toContain("(renderer-changed)");
    expect(refusal).toContain("e2e/elsewhere.json");
    expect(refusal).toContain("no screenshot is compared with, or redrawn over, a committed");
    expect(refusal).toMatch(/at the top of this run/);
    expect(refusal).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
  });

  test("changed fonts are fixed by the redraw, not by the re-base", () => {
    const refusal = rendererRefusal("fonts-changed");
    expect(refusal).toContain(`${RENDERER_CHECK_ENV}=skip pnpm e2e:update`);
    expect(refusal).not.toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
  });

  test("the specs read what global setup hands them, and nothing when it hands none", () => {
    expect(RENDERER_REFUSAL_ENV).toBe("E2E_RENDERER_REFUSAL");
    expect(baselineRefusal({})).toBeNull();
    expect(baselineRefusal({ [RENDERER_REFUSAL_ENV]: "" })).toBeNull();
    expect(baselineRefusal({ [RENDERER_REFUSAL_ENV]: "e2e: no" })).toBe("e2e: no");
  });
});

describe("describeRendererCheck", () => {
  test("a skipped check says a spread of visual failures may be the machine", () => {
    expect(describeRendererCheck({ verdict: "skipped" })).toMatch(
      /SKIPPED.*E2E_RENDERER_CHECK=skip/,
    );
  });

  test("a match names the canary and the renderer it matched", () => {
    const line = describeRendererCheck({ verdict: "match", recorded: RECORDED, current: RECORDED });
    expect(line).toContain("a7e111bb233f");
    expect(line).toContain("macOS 27.2 (26B5091g)");
    expect(line).toContain("chromium r1228");
  });

  test("a mismatch a run goes on through says so on its first line, then the whole message", () => {
    const text = describeRendererCheck({
      verdict: "renderer-changed",
      run: "compare",
      message: "e2e: THE RENDERER CHANGED — and the rest",
      refusal: "e2e: no screenshot",
    });
    const [first, ...rest] = text.split("\n");
    expect(first).toMatch(/^\[e2e setup\] renderer canary: renderer-changed, and this run goes on/);
    expect(rest.join("\n")).toBe("e2e: THE RENDERER CHANGED — and the rest");
  });
});

describe("currentEnvironment", () => {
  /** Only the shape: the values are whatever this machine is, which is the point. */
  test("reads the macOS version, Playwright and the headless shell's revision", () => {
    const env = currentEnvironment();
    expect(env.playwright).toMatch(/^\d+\.\d+\.\d+/);
    expect(env.chromiumRevision).toMatch(/^\d+$/);
    if (process.platform === "darwin") {
      expect(env.macos.productVersion).toMatch(/^\d+(\.\d+)*$/);
      expect(env.macos.buildVersion).toMatch(/^[0-9A-Za-z]+$/);
    }
  });
});
