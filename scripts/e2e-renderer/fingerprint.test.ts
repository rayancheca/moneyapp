import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertRendererMatchesBaselines,
  BASELINE_RENDERER_PATH,
  compareRecord,
  currentEnvironment,
  describeRendererCheck,
  readRecord,
  REBASE_RENDERER_COMMAND,
  RENDERER_CHECK_ENV,
  rendererMismatchMessage,
  writeRecord,
  type RendererRecord,
} from "./fingerprint";

const PIXELS_BEFORE = "a7e111bb233faec6f7e1151efdc15b886b1f78209bcb54827664f3cd8320ad1f";
const PIXELS_AFTER = "3df6722d28b970ee0123456789abcdef0123456789abcdef0123456789abcdef";
const SOURCE_BEFORE = "34640c8f9377bb56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_AFTER = "84cf666e46613878bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The renderer the baselines were re-based on, 2026-09-28. */
const RECORDED: RendererRecord = {
  canary: { pixelSha256: PIXELS_BEFORE, sourceSha256: SOURCE_BEFORE, width: 1280, height: 720 },
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

  test("it says the failures would not be the change under test, and gives the fix", () => {
    const message = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE);
    expect(message).toMatch(/nearly every baseline with text/i);
    expect(message).toMatch(/NOT the change under test/);
    expect(message).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
    expect(message).toContain(`${RENDERER_CHECK_ENV}=skip`);
  });

  test("when no version moved it says the change is beneath them", () => {
    const sameVersions = withCanary(RECORDED, { pixelSha256: PIXELS_AFTER });
    const message = rendererMismatchMessage("renderer-changed", RECORDED, sameVersions);
    expect(message).toMatch(/none of the versions it records moved/i);
    expect(message).toContain("macOS       27.2 (26B5091g)  (unchanged)");
  });

  test("a changed canary names both sources and what can change them", () => {
    const current = withCanary(RECORDED, { sourceSha256: SOURCE_AFTER });
    const message = rendererMismatchMessage("canary-changed", RECORDED, current);
    expect(message).toMatch(/THE RENDERER CANARY ITSELF CHANGED/);
    expect(message).toContain("34640c8f9377");
    expect(message).toContain("84cf666e4661");
    expect(message).toContain("scripts/e2e-renderer/canary.ts");
    expect(message).toContain("node_modules/geist");
    expect(message).toContain(`Fix: ${REBASE_RENDERER_COMMAND}`);
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

describe("assertRendererMatchesBaselines", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-check-"));
    file = path.join(dir, "baseline-renderer.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("skip bypasses the check without launching a browser", async () => {
    const measure = vi.fn(async () => RECORDED);
    const check = await assertRendererMatchesBaselines({
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
    await expect(
      assertRendererMatchesBaselines({ file, env, measure: measured(RECORDED) }),
    ).rejects.toThrow(`${RENDERER_CHECK_ENV}=off`);
  });

  test("a matching renderer passes and returns both sides", async () => {
    writeRecord(RECORDED, file);
    const measure = measured(RECORDED);
    const check = await assertRendererMatchesBaselines({ file, env: {}, measure });
    expect(check).toEqual({ verdict: "match", recorded: RECORDED, current: RECORDED });
  });

  test("a changed renderer throws exactly the one message", async () => {
    writeRecord(RECORDED, file);
    const expected = rendererMismatchMessage("renderer-changed", RECORDED, AFTER_OS_UPDATE, file);
    await expect(
      assertRendererMatchesBaselines({ file, env: {}, measure: measured(AFTER_OS_UPDATE) }),
    ).rejects.toThrow(expected);
  });

  test("no record throws, pointing at the command that records one", async () => {
    await expect(
      assertRendererMatchesBaselines({ file, env: {}, measure: measured(RECORDED) }),
    ).rejects.toThrow(/NO RENDERER RECORD/);
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
