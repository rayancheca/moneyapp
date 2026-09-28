import path from "node:path";

/**
 * Where `pnpm e2e:rebase-renderer`'s control run draws its screenshots: a scratch root laid out
 * exactly like e2e/, so every committed baseline has a twin at the same relative path and the
 * classification can pair them without the control ever writing into e2e/*-snapshots.
 *
 * Shared by playwright.config.ts (which points snapshotPathTemplate at the root) and the command
 * (which pairs the files), so the two cannot disagree about where a twin lives.
 */

export const SNAPSHOT_ROOT_ENV = "E2E_SNAPSHOT_ROOT";

/** playwright.config.ts's testDir, which is also its snapshotDir: the committed baselines. */
export const BASELINE_DIR = "e2e";

/**
 * Playwright's own default below `{snapshotDir}`, spelled out. With the root in place of the
 * snapshotDir, e2e/visual.spec.ts-snapshots/x-chromium-darwin.png has its twin at
 * <root>/visual.spec.ts-snapshots/x-chromium-darwin.png.
 */
const DEFAULT_LAYOUT =
  "{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}";

/** A file under a spec's snapshot directory, at any depth of e2e/. */
const BASELINE_PATH = /^e2e\/(?:[^/]+\/)*[^/]+-snapshots\/.+$/;

/**
 * The template for a run whose snapshots go to the scratch root, or undefined for every other
 * run. A relative root would resolve against wherever Playwright was started, and a root inside
 * e2e/ would put the control's files among the baselines it is meant to leave alone.
 */
export function scratchSnapshotTemplate(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string | undefined {
  const root = env[SNAPSHOT_ROOT_ENV];
  if (root === undefined || root === "") return undefined;
  if (!path.isAbsolute(root)) {
    throw new Error(`${SNAPSHOT_ROOT_ENV} must be an absolute path, got "${root}"`);
  }
  const fromBaselines = path.relative(path.resolve(cwd, BASELINE_DIR), root);
  const outside = fromBaselines === ".." || fromBaselines.startsWith(`..${path.sep}`);
  if (!outside && !path.isAbsolute(fromBaselines)) {
    throw new Error(`${SNAPSHOT_ROOT_ENV}=${root} is inside ${BASELINE_DIR}/, among the baselines`);
  }
  return `${root}/${DEFAULT_LAYOUT}`;
}

export function isBaselinePath(file: string): boolean {
  return BASELINE_PATH.test(file);
}

/** "e2e/visual.spec.ts-snapshots/x.png" -> "visual.spec.ts-snapshots/x.png", the pairing key. */
export function baselineKey(baseline: string): string {
  if (!isBaselinePath(baseline)) throw new Error(`${baseline} is not a committed baseline path`);
  return baseline.slice(BASELINE_DIR.length + 1);
}

/** A twin's path relative to the root, with forward slashes: the pairing key. */
export function twinKey(twinRelative: string): string {
  return twinRelative.split(path.sep).join("/");
}

/** The committed baseline a twin stands for, from the twin's path relative to the root. */
export function baselineForTwin(twinRelative: string): string {
  return `${BASELINE_DIR}/${twinKey(twinRelative)}`;
}

export function twinPath(baseline: string, root: string): string {
  return path.join(root, ...baselineKey(baseline).split("/"));
}
