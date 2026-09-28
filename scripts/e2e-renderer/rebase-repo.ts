import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { bundleStaleness } from "../../e2e/global-setup";
import { BASELINE_RENDERER_PATH } from "./fingerprint";
import { BASELINE_DIR, isBaselinePath } from "./snapshot-root";

/**
 * What `pnpm e2e:rebase-renderer` reads from, and puts back into, the repository: git's view of
 * the tree, the committed baselines, and which sources .next was built from. Every function takes
 * the repository as `cwd`, so the restore that a red gate depends on is tested against real git.
 */

export function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function gitSucceeds(args: readonly string[], cwd?: string): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

/** Every committed baseline, from git's index rather than the disk. */
export function committedBaselines(cwd?: string): string[] {
  return git(["ls-files", "-z", "--", BASELINE_DIR], cwd).split("\0").filter(isBaselinePath);
}

/** What `git status` shows under a directory, untracked files included, one path a line. */
export function uncommittedUnder(dir: string, cwd?: string): string[] {
  return lines(git(["status", "--porcelain", "--untracked-files=all", "--", dir], cwd)).map(
    (line) => line.slice(3),
  );
}

/**
 * Puts the given baselines and the renderer record back as HEAD has them. A record HEAD does not
 * hold is deleted: the guards refused any untracked file under e2e/ before anything was written,
 * so a record that is not committed is one this run wrote.
 */
export function restoreFromHead(baselines: readonly string[], cwd?: string): void {
  const fromHead = (paths: readonly string[]) =>
    git(["restore", "--source=HEAD", "--worktree", "--", ...paths], cwd);
  if (baselines.length > 0) fromHead(baselines);
  if (gitSucceeds(["cat-file", "-e", `HEAD:${BASELINE_RENDERER_PATH}`], cwd)) {
    fromHead([BASELINE_RENDERER_PATH]);
  } else {
    fs.rmSync(path.join(cwd ?? ".", BASELINE_RENDERER_PATH), { force: true });
  }
}

/* ── Which sources .next was built from ───────────────────────────────────────────────────── */

/** Written beside the build by this command; `next build` wipes it with everything else. */
export const BUNDLE_SOURCE_MARK = path.join(".next", "e2e-rebase-renderer-source.json");

/** Top-level entries of HEAD that never reach `next build`: the specs and baselines, and docs. */
const NOT_BUILD_INPUTS = new Set(["e2e", "docs"]);

/**
 * HEAD's tree minus what cannot reach the bundle, so committing a re-base (which touches e2e/
 * only) does not force a rebuild, while any other commit does. Everything else counts, scripts
 * included: a rebuild too many costs a minute, a rebuild too few photographs other code.
 */
export function bundleSourceKey(cwd?: string): string {
  const kept = lines(git(["ls-tree", "HEAD"], cwd)).filter(
    (entry) => !NOT_BUILD_INPUTS.has(entry.split("\t")[1] ?? ""),
  );
  return crypto.createHash("sha256").update(kept.join("\n")).digest("hex");
}

const BundleMarkSchema = z.object({ buildId: z.string(), source: z.string(), commit: z.string() });

function readBuildId(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".next", "BUILD_ID"), "utf8").trim();
}

/** Called right after this command's own `next build` succeeded. */
export function markBundleBuilt(cwd: string = "."): void {
  const mark = {
    buildId: readBuildId(cwd),
    source: bundleSourceKey(cwd),
    commit: git(["rev-parse", "HEAD"], cwd).trim(),
  };
  fs.writeFileSync(path.join(cwd, BUNDLE_SOURCE_MARK), `${JSON.stringify(mark, null, 2)}\n`);
}

/**
 * .next carries no trace of what it was built from (its BUILD_ID is random), and a bundle built
 * from other sources would make the control photograph other code. So only a build this command
 * made and marked counts, and it must also pass global-setup's own freshness rule, or the control
 * would be refused part way in by a file that was touched without changing.
 */
export function bundleFromHead(cwd: string = "."): { fromHead: boolean; saw: string } {
  const stale = bundleStaleness(path.resolve(cwd));
  if (stale?.reason === "no-build") return { fromHead: false, saw: "there is no .next build" };
  if (stale?.reason === "stale") {
    const saw = `${stale.file} is newer than the build, so global-setup would refuse it`;
    return { fromHead: false, saw };
  }
  const buildId = readBuildId(cwd);
  let mark: z.infer<typeof BundleMarkSchema>;
  try {
    const text = fs.readFileSync(path.join(cwd, BUNDLE_SOURCE_MARK), "utf8");
    mark = BundleMarkSchema.parse(JSON.parse(text));
  } catch {
    return { fromHead: false, saw: `.next ${buildId} records no commit it was built from` };
  }
  if (mark.buildId !== buildId) {
    return { fromHead: false, saw: `.next ${buildId} was built since this command last built it` };
  }
  if (mark.source !== bundleSourceKey(cwd)) {
    const saw = `.next was built from ${mark.commit.slice(0, 7)}, not from HEAD's sources`;
    return { fromHead: false, saw };
  }
  return { fromHead: true, saw: `.next ${buildId} was built from HEAD's sources` };
}
