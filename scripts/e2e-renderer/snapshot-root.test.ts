import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  baselineForTwin,
  baselineKey,
  describeSnapshotRoot,
  isBaselinePath,
  scratchSnapshotTemplate,
  SNAPSHOT_ROOT_ENV,
  twinPath,
} from "./snapshot-root";

const REPO = "/work/MoneyApp";
const ROOT = "/tmp/e2e-rebase-renderer-abc/snapshots";

/**
 * Playwright 1.61's `_applyPathTemplate`, for the placeholders the two layouts use. Written out
 * here so the test shows the claim the pairing rests on: a twin lands at the same path under the
 * root as its baseline does under e2e/.
 */
function applyTemplate(template: string, testFile: string, name: string): string {
  const relative = path.parse(path.relative(path.join(REPO, "e2e"), testFile));
  const out = template
    .replace(/\{(.)?snapshotDir\}/g, `$1${path.join(REPO, "e2e")}`)
    .replace(/\{(.)?snapshotSuffix\}/g, "$1darwin")
    .replace(/\{(.)?testFileDir\}/g, `$1${relative.dir}`)
    .replace(/\{(.)?projectName\}/g, "$1chromium")
    .replace(/\{(.)?testFileName\}/g, `$1${relative.base}`)
    .replace(/\{(.)?arg\}/g, `$1${name}`)
    .replace(/\{(.)?ext\}/g, "$1.png");
  return path.normalize(path.resolve(REPO, out));
}
const PLAYWRIGHT_DEFAULT =
  "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}";

describe("scratchSnapshotTemplate", () => {
  test("no root, no template: every other run keeps Playwright's default layout", () => {
    expect(scratchSnapshotTemplate({}, REPO)).toBeUndefined();
    expect(scratchSnapshotTemplate({ [SNAPSHOT_ROOT_ENV]: "" }, REPO)).toBeUndefined();
  });

  test("a relative root is refused: it would resolve against wherever Playwright started", () => {
    expect(() => scratchSnapshotTemplate({ [SNAPSHOT_ROOT_ENV]: "tmp/snapshots" }, REPO)).toThrow(
      /absolute/,
    );
  });

  test("a root inside e2e/ is refused: the control would write among the baselines", () => {
    for (const root of [`${REPO}/e2e`, `${REPO}/e2e/visual.spec.ts-snapshots`, `${REPO}/e2e/x`]) {
      const env = { [SNAPSHOT_ROOT_ENV]: root };
      expect(() => scratchSnapshotTemplate(env, REPO)).toThrow(/inside e2e/);
    }
  });

  test("a sibling whose name only starts like a parent path is still outside", () => {
    expect(scratchSnapshotTemplate({ [SNAPSHOT_ROOT_ENV]: `${REPO}/e2e-scratch` }, REPO)).toMatch(
      /^\/work\/MoneyApp\/e2e-scratch\//,
    );
  });

  /**
   * A gate compares with the committed baselines and nothing else. A root left in a shell (say,
   * exported to run a spec against the control's twins) would point it at the control's drawings,
   * and it would pass on them. Any non-empty E2E_GATE is a gate, as playwright.config.ts reads it.
   */
  test("a gate refuses a root: it compares with e2e/, whatever the shell left set", () => {
    for (const gate of ["1", "true", "0"]) {
      const env = { E2E_GATE: gate, [SNAPSHOT_ROOT_ENV]: ROOT };
      expect(() => scratchSnapshotTemplate(env, REPO), gate).toThrow(
        `${SNAPSHOT_ROOT_ENV}=${ROOT} would point a gate (E2E_GATE=${gate}) at a scratch root`,
      );
    }
    expect(scratchSnapshotTemplate({ E2E_GATE: "1" }, REPO)).toBeUndefined();
    expect(scratchSnapshotTemplate({ E2E_GATE: "1", [SNAPSHOT_ROOT_ENV]: "" }, REPO)).toBe(
      undefined,
    );
    expect(scratchSnapshotTemplate({ E2E_GATE: "", [SNAPSHOT_ROOT_ENV]: ROOT }, REPO)).toMatch(
      /^\/tmp\/e2e-rebase-renderer-abc\/snapshots\//,
    );
  });

  test("a twin lands at its baseline's path, relative to the root instead of e2e/", () => {
    const template = scratchSnapshotTemplate({ [SNAPSHOT_ROOT_ENV]: ROOT }, REPO)!;
    for (const spec of ["visual.spec.ts", "sub/dir/deep.spec.ts"]) {
      const testFile = path.join(REPO, "e2e", spec);
      const baseline = applyTemplate(PLAYWRIGHT_DEFAULT, testFile, "accounts-dark-1440");
      const twin = applyTemplate(template, testFile, "accounts-dark-1440");
      const committed = path.relative(REPO, baseline);
      expect(committed).toBe(`e2e/${spec}-snapshots/accounts-dark-1440-chromium-darwin.png`);
      expect(twin).toBe(twinPath(committed, ROOT));
      expect(baselineForTwin(path.relative(ROOT, twin))).toBe(committed);
    }
  });
});

describe("playwright.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("points snapshotPathTemplate at the root only when the root is set", async () => {
    vi.stubEnv("E2E_GATE", "");
    vi.stubEnv(SNAPSHOT_ROOT_ENV, ROOT);
    const redirected = (await import("../../playwright.config")).default;
    expect(redirected.snapshotPathTemplate).toBe(
      `${ROOT}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}`,
    );

    vi.resetModules();
    vi.stubEnv(SNAPSHOT_ROOT_ENV, "");
    const normal = (await import("../../playwright.config")).default;
    expect("snapshotPathTemplate" in normal).toBe(false);
  });

  test("a gate with a root set stops at the config, before a screenshot is compared", async () => {
    vi.stubEnv("E2E_GATE", "1");
    vi.stubEnv(SNAPSHOT_ROOT_ENV, ROOT);
    await expect(import("../../playwright.config")).rejects.toThrow(/would point a gate/);
  });
});

describe("describeSnapshotRoot", () => {
  test("no root, no line", () => {
    expect(describeSnapshotRoot({})).toBeNull();
    expect(describeSnapshotRoot({ [SNAPSHOT_ROOT_ENV]: "" })).toBeNull();
  });

  test("a root is said: where screenshots go, and that no committed baseline is checked", () => {
    const line = describeSnapshotRoot({ [SNAPSHOT_ROOT_ENV]: ROOT })!;
    expect(line).toContain(`${SNAPSHOT_ROOT_ENV}=${ROOT}`);
    expect(line).toMatch(/compared with and written to that root, not e2e\//);
    expect(line).toMatch(/checks no committed baseline/);
    expect(line).toMatch(/unset it for any other run/);
  });
});

/**
 * Every run honours the root, so every run that does says so, and first: a run stopped part way
 * through setup has still said it, and nothing else in its log would.
 */
describe("e2e/global-setup.ts", () => {
  afterEach(() => {
    vi.doUnmock("../quiet-box");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function setupUntilTheLoadCheck(): Promise<unknown[][]> {
    vi.doMock("../quiet-box", () => ({
      assertQuietBox: () => {
        throw new Error("stopped at the load check");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { default: globalSetup } = await import("../../e2e/global-setup");
    await expect(globalSetup()).rejects.toThrow("stopped at the load check");
    return warn.mock.calls;
  }

  test("a redirected run says so before anything that can stop it", async () => {
    vi.stubEnv(SNAPSHOT_ROOT_ENV, ROOT);
    expect(await setupUntilTheLoadCheck()).toEqual([
      [describeSnapshotRoot({ [SNAPSHOT_ROOT_ENV]: ROOT })],
    ]);
  });

  test("a run that reads e2e/ says nothing about it", async () => {
    vi.stubEnv(SNAPSHOT_ROOT_ENV, "");
    expect(await setupUntilTheLoadCheck()).toEqual([]);
  });
});

describe("baseline paths", () => {
  test("a baseline is any file in a spec's -snapshots directory under e2e/", () => {
    expect(isBaselinePath("e2e/visual.spec.ts-snapshots/a-chromium-darwin.png")).toBe(true);
    expect(isBaselinePath("e2e/sub/x.spec.ts-snapshots/b.png")).toBe(true);
    expect(isBaselinePath("e2e/visual.spec.ts")).toBe(false);
    expect(isBaselinePath("e2e/baseline-renderer.json")).toBe(false);
    expect(isBaselinePath("scripts/x-snapshots/a.png")).toBe(false);
  });

  test("the pairing key drops e2e/, and a twin names its baseline back", () => {
    const baseline = "e2e/visual.spec.ts-snapshots/a-chromium-darwin.png";
    expect(baselineKey(baseline)).toBe("visual.spec.ts-snapshots/a-chromium-darwin.png");
    expect(baselineForTwin(baselineKey(baseline))).toBe(baseline);
    expect(() => baselineKey("e2e/visual.spec.ts")).toThrow(/not a committed baseline/);
  });
});
