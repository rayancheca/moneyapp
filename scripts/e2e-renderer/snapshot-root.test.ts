import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  baselineForTwin,
  baselineKey,
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
