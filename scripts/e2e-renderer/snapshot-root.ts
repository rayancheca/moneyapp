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

/** A gate run, as playwright.config.ts reads it: any non-empty value. */
const GATE_ENV = "E2E_GATE";

type Env = Readonly<Record<string, string | undefined>>;

function rootOf(env: Env): string | null {
  const root = env[SNAPSHOT_ROOT_ENV];
  return root === undefined || root === "" ? null : root;
}

/**
 * The template for a run whose snapshots go to the scratch root, or undefined for every other
 * run. A relative root would resolve against wherever Playwright was started, and a root inside
 * e2e/ would put the control's files among the baselines it is meant to leave alone.
 *
 * A gate compares with the committed baselines and nothing else, so it refuses a root outright:
 * one left in a shell (exported, say, to run a spec against the control's twins) would have it
 * compare with the control's drawings, and pass on them. The command's own gate strips the root
 * (suiteEnv); this refuses it for every other.
 */
export function scratchSnapshotTemplate(env: Env, cwd: string = process.cwd()): string | undefined {
  const root = rootOf(env);
  if (root === null) return undefined;
  const gate = env[GATE_ENV];
  if (gate !== undefined && gate !== "") {
    throw new Error(
      `${SNAPSHOT_ROOT_ENV}=${root} would point a gate (${GATE_ENV}=${gate}) at a scratch root: ` +
        `a gate compares with the committed baselines in ${BASELINE_DIR}/. ` +
        `Unset ${SNAPSHOT_ROOT_ENV} and run it again.`,
    );
  }
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

/**
 * The line global-setup prints first on a run whose snapshots go to a root, or null on one that
 * reads e2e/. Such a run can pass without comparing one committed baseline, and nothing else in
 * its log would say so.
 */
export function describeSnapshotRoot(env: Env): string | null {
  const root = rootOf(env);
  if (root === null) return null;
  return (
    `[e2e setup] snapshots REDIRECTED (${SNAPSHOT_ROOT_ENV}=${root}): every screenshot is ` +
    `compared with and written to that root, not ${BASELINE_DIR}/, so this run checks no ` +
    "committed baseline. Only pnpm e2e:rebase-renderer's control means to; unset it for any " +
    "other run."
  );
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
