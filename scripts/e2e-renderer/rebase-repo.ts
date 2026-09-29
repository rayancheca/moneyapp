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

function firstLineOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? text;
}

/**
 * One file as HEAD has it, read from HEAD's blob (with the checkout filters) and written with
 * plain file I/O. A file already equal to it is left alone; one HEAD does not hold is deleted.
 * `ls-tree` says "not held" with an empty answer and throws on anything else, so a git that
 * cannot answer deletes nothing.
 */
function restoreOne(file: string, cwd?: string): void {
  const absolute = path.join(cwd ?? ".", file);
  if (!lines(git(["ls-tree", "--name-only", "HEAD", "--", file], cwd)).includes(file)) {
    fs.rmSync(absolute, { force: true });
    return;
  }
  const bytes = execFileSync("git", ["cat-file", "--filters", `HEAD:${file}`], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (fs.existsSync(absolute) && fs.readFileSync(absolute).equals(bytes)) return;
  fs.writeFileSync(absolute, bytes);
}

/**
 * Puts the renderer record and the given baselines back as HEAD has them, and throws naming every
 * file it could not. A file HEAD does not hold is deleted: the guards refused any untracked file
 * under e2e/ before anything was written, so one that is not committed is one this run wrote.
 *
 * The record goes first, because it is what lets the next run say "Nothing to do": no failure
 * below may leave it behind. A file that cannot be put back does not stop the rest. And none of it
 * goes through `git restore`, which takes .git/index.lock and, while any other git process holds
 * it (an editor's status poll), exits 128 having touched nothing.
 */
export function restoreFromHead(baselines: readonly string[], cwd?: string): void {
  const failed: string[] = [];
  for (const file of [BASELINE_RENDERER_PATH, ...baselines]) {
    try {
      restoreOne(file, cwd);
    } catch (error) {
      failed.push(`${file} (${firstLineOf(error)})`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} file(s) could not be put back as HEAD has them: ${failed.join("; ")}`,
    );
  }
}

/* ── A re-base no gate has passed yet ─────────────────────────────────────────────────────── */

/**
 * Left by --confirm before it writes anything, and removed once its gate passes or every file is
 * back as HEAD has it. A run stopped in between by what no handler hears (SIGKILL, a session
 * closed without a signal) or by a restore that failed leaves it, and the next run, finding it,
 * puts back what that run wrote before the canary can match its record and call the unverified
 * twins "Nothing to do". It lives in the git directory, so it is never committed, never shows in
 * `git status`, and belongs to this worktree alone.
 */
const PENDING_MARK = "e2e-rebase-renderer-pending.json";

const PendingSchema = z.object({
  head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "must be a full commit id"),
  files: z.array(z.string()),
  startedOn: z.string().min(1),
});

export type PendingReBase = z.infer<typeof PendingSchema>;

export function pendingMarkPath(cwd?: string): string {
  return path.resolve(cwd ?? ".", git(["rev-parse", "--git-path", PENDING_MARK], cwd).trim());
}

/**
 * Before the first file is written: the baselines about to be copied, and HEAD they came from.
 * Written whole or not at all (a rename), so a kill part way through never leaves half a mark.
 */
export function markPendingReBase(files: readonly string[], cwd?: string, now = new Date()): void {
  const mark: PendingReBase = {
    head: git(["rev-parse", "HEAD"], cwd).trim(),
    files: [...files],
    startedOn: now.toISOString(),
  };
  const file = pendingMarkPath(cwd);
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(mark, null, 2)}\n`);
  fs.renameSync(partial, file);
}

export function readPendingReBase(cwd?: string): PendingReBase | null {
  const file = pendingMarkPath(cwd);
  if (!fs.existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${firstLineOf(error)}`);
  }
  const parsed = PendingSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file} is not a pending re-base: ${issues}`);
  }
  return parsed.data;
}

export function clearPendingReBase(cwd?: string): void {
  fs.rmSync(pendingMarkPath(cwd), { force: true });
}

export type Settled =
  | { settled: "nothing-pending" }
  | { settled: "put-back"; pending: PendingReBase }
  | { settled: "committed-since"; pending: PendingReBase; touched: string[] };

/**
 * What a run does first with a mark it finds: the restore a red gate makes, of what that run
 * wrote, and the mark removed. HEAD may have moved since; when no commit in between changed one of
 * those files, HEAD's copy is still the one that run started from. When one did, that commit may
 * carry the unverified twins, and putting back from it would bless them: then nothing is touched,
 * the mark stays, and the caller says which. A restore that fails throws, and the mark stays.
 */
export function settlePendingReBase(cwd?: string): Settled {
  const pending = readPendingReBase(cwd);
  if (pending === null) return { settled: "nothing-pending" };
  const written = [BASELINE_RENDERER_PATH, ...pending.files];
  const touched = lines(git(["diff", "--name-only", pending.head, "HEAD", "--", ...written], cwd));
  if (touched.length > 0) return { settled: "committed-since", pending, touched };
  restoreFromHead(pending.files, cwd);
  clearPendingReBase(cwd);
  return { settled: "put-back", pending };
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
