import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RENDERER_REFUSAL_ENV, type RendererCheck, type RendererRecord } from "./fingerprint";

/**
 * A renderer canary that does not match stops a gate outright in global setup. Any other run goes
 * on: of 60 spec files only four compare a committed baseline, and the rest (zz-budgets, a11y,
 * keyboard, hydration) must not be stopped for a Mac they never ask about. What stops instead is
 * each comparison with a committed baseline, through e2e/expect-baseline.ts, which reads the
 * refusal global setup handed the workers. These hold the three parts together.
 */

const E2E = "e2e";

const RECORD: RendererRecord = {
  canary: {
    pixelSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    fontSha256: "c".repeat(64),
    width: 1280,
    height: 720,
  },
  recordedOn: "2026-09-28T19:02:11.000Z",
  macos: { productVersion: "27.2", buildVersion: "26B5091g" },
  playwright: "1.61.1",
  chromiumRevision: "1228",
};

const REFUSAL = "e2e: no screenshot is compared with, or redrawn over, a committed baseline";

const MISMATCH: RendererCheck = {
  verdict: "renderer-changed",
  run: "compare",
  message: "e2e: THE RENDERER CHANGED — the whole message",
  refusal: REFUSAL,
};

describe("expectBaseline", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("refuses before comparing, with the refusal global setup handed on", async () => {
    vi.stubEnv(RENDERER_REFUSAL_ENV, REFUSAL);
    const { expectBaseline } = await import("../../e2e/expect-baseline");
    expect(() => expectBaseline({} as Page)).toThrow(REFUSAL);
  });

  test("is Playwright's own expect when there is no refusal", async () => {
    vi.stubEnv(RENDERER_REFUSAL_ENV, "");
    const { expectBaseline } = await import("../../e2e/expect-baseline");
    expect(typeof expectBaseline({} as Page).toHaveScreenshot).toBe("function");
  });
});

/** A call's receiver, one level of parentheses deep: `expectBaseline(page)`, `expect(card)`. */
const SCREENSHOT_CALL =
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\s*(?:[^()]|\([^()]*\))*\)\s*\.toHaveScreenshot\(/g;
/** Every call, whatever its receiver: a comment names the matcher without the dot. */
const ANY_SCREENSHOT = /\.toHaveScreenshot\(/g;

describe("the specs", () => {
  const specs = fs.readdirSync(E2E).filter((file) => file.endsWith(".spec.ts"));
  const source = (spec: string) => fs.readFileSync(path.join(E2E, spec), "utf8");

  /** A bare expect(…).toHaveScreenshot compares, or redraws, whatever the renderer. */
  test("compare with a committed baseline only through expectBaseline", () => {
    const astray = specs.flatMap((spec) => {
      const text = source(spec);
      const calls = [...text.matchAll(SCREENSHOT_CALL)].map((m) => m[1]);
      const all = text.match(ANY_SCREENSHOT)?.length ?? 0;
      const other = calls.filter((receiver) => receiver !== "expectBaseline");
      const unread = all - calls.length;
      return [
        ...other.map((receiver) => `${spec}: ${receiver}(…).toHaveScreenshot`),
        ...(unread === 0 ? [] : [`${spec}: ${unread} toHaveScreenshot call(s) this cannot read`]),
      ];
    });
    expect(astray).toEqual([]);
  });

  test("every spec with committed baselines takes them through expectBaseline", () => {
    const owners = fs
      .readdirSync(E2E)
      .filter((entry) => entry.endsWith(".spec.ts-snapshots"))
      .map((dir) => dir.replace(/-snapshots$/, ""));
    expect(owners.sort()).toEqual([
      "interaction-states.spec.ts",
      "visual.spec.ts",
      "zz-golden-path.spec.ts",
      "zz-zz-intraday.spec.ts",
    ]);
    const unguarded = owners.filter((spec) => !/\bexpectBaseline\(/.test(source(spec)));
    expect(unguarded).toEqual([]);
  });
});

describe("e2e/global-setup.ts, on the renderer", () => {
  afterEach(() => {
    vi.doUnmock("./fingerprint");
    vi.doUnmock("../quiet-box");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  interface Setup {
    asked: { updateSnapshots?: string }[];
    remembered: RendererRecord[];
    warned: string;
    logged: string;
    checkRenderer: (typeof import("../../e2e/global-setup"))["checkRenderer"];
  }

  /** global-setup with the canary's answer given, so nothing launches, seeds or deletes. */
  async function setupWith(answer: () => Promise<RendererCheck>): Promise<Setup> {
    const asked: { updateSnapshots?: string }[] = [];
    const remembered: RendererRecord[] = [];
    vi.doMock("./fingerprint", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./fingerprint")>()),
      checkRendererForRun: async (options: { updateSnapshots?: string }) => {
        asked.push({ updateSnapshots: options.updateSnapshots });
        return answer();
      },
      rememberMatchOrSay: (record: RendererRecord) => {
        remembered.push(record);
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { checkRenderer } = await import("../../e2e/global-setup");
    return {
      asked,
      remembered,
      get warned() {
        return warn.mock.calls.flat().join("\n");
      },
      get logged() {
        return log.mock.calls.flat().join("\n");
      },
      checkRenderer,
    };
  }

  test("a mismatch stops no run but a gate; the workers get the refusal", async () => {
    vi.stubEnv(RENDERER_REFUSAL_ENV, "");
    const setup = await setupWith(async () => MISMATCH);
    await expect(setup.checkRenderer({ updateSnapshots: "missing" })).resolves.toBeUndefined();
    expect(process.env[RENDERER_REFUSAL_ENV]).toBe(REFUSAL);
    expect(setup.warned).toContain(MISMATCH.message);
    expect(setup.remembered).toEqual([]);
  });

  test("a match hands on no refusal, whatever the shell left, and is noted", async () => {
    vi.stubEnv(RENDERER_REFUSAL_ENV, "left in a shell");
    const setup = await setupWith(async () => ({
      verdict: "match",
      recorded: RECORD,
      current: RECORD,
    }));
    await setup.checkRenderer();
    expect(process.env[RENDERER_REFUSAL_ENV]).toBeUndefined();
    expect(setup.remembered).toEqual([RECORD]);
    expect(setup.logged).toContain("renderer matches");
  });

  test("a skipped check hands on no refusal either", async () => {
    vi.stubEnv(RENDERER_REFUSAL_ENV, "left in a shell");
    const setup = await setupWith(async () => ({ verdict: "skipped" }));
    await setup.checkRenderer();
    expect(process.env[RENDERER_REFUSAL_ENV]).toBeUndefined();
    expect(setup.warned).toContain("SKIPPED");
  });

  /** checkRendererForRun throws for a gate; global setup lets it stop the run. */
  test("a gate's mismatch stops global setup", async () => {
    const setup = await setupWith(async () => {
      throw new Error("e2e: THE RENDERER CHANGED");
    });
    await expect(setup.checkRenderer()).rejects.toThrow("e2e: THE RENDERER CHANGED");
  });

  test("the check is told how the run treats snapshots, from Playwright's own config", async () => {
    const setup = await setupWith(async () => ({ verdict: "skipped" }));
    await setup.checkRenderer({ updateSnapshots: "changed" });
    expect(setup.asked).toEqual([{ updateSnapshots: "changed" }]);
  });

  test("global setup passes Playwright's config on to it", async () => {
    vi.stubEnv("E2E_ALLOW_STALE", "1");
    vi.doMock("../quiet-box", () => ({
      assertQuietBox: () => ({ verdict: "quiet", load1: 0, cores: 8 }),
    }));
    const setup = await setupWith(async () => {
      throw new Error("stopped at the renderer check");
    });
    const { default: globalSetup } = await import("../../e2e/global-setup");
    await expect(globalSetup({ updateSnapshots: "all" })).rejects.toThrow(
      "stopped at the renderer check",
    );
    expect(setup.asked).toEqual([{ updateSnapshots: "all" }]);
  });
});
