import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BASELINE_RENDERER_PATH } from "./fingerprint";
import {
  bundleFromHead,
  clearPendingReBase,
  committedBaselines,
  markBundleBuilt,
  markPendingReBase,
  pendingMarkPath,
  readPendingReBase,
  restoreFromHead,
  settlePendingReBase,
  uncommittedUnder,
} from "./rebase-repo";

/**
 * Against a real repository in a temp directory: the restore is what stands between a red gate
 * and a half-re-based tree, so it is proved on git itself rather than on a fake of it.
 */
let repo: string;

/** Root writes through a read-only file and directory, so a write cannot be made to fail. */
const AS_ROOT = process.getuid?.() === 0;

const A = "e2e/visual.spec.ts-snapshots/a-chromium-darwin.png";
const B = "e2e/visual.spec.ts-snapshots/b-chromium-darwin.png";
const PAGE = "src/app/page.tsx";

function gitIn(...args: string[]): void {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, ...args], { cwd: repo, stdio: "pipe" });
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}
function read(file: string): string {
  return fs.readFileSync(path.join(repo, file), "utf8");
}
function commit(message: string, ...files: string[]): void {
  gitIn("add", "--", ...files);
  gitIn("commit", "-q", "-m", message);
}
/** Sets a file's mtime, so "older than the build" does not depend on how fast the test runs. */
function age(file: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(path.join(repo, file), when, when);
}
function build(id: string): void {
  write(".next/BUILD_ID", id);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-repo-test-"));
  gitIn("init", "-q");
  write(PAGE, "export default 1;\n");
  write("e2e/visual.spec.ts", "// spec\n");
  write(A, "A0");
  write(B, "B0");
  write("docs/notes.md", "notes\n");
  commit("base", PAGE, "e2e/visual.spec.ts", A, B, "docs/notes.md");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("the tree", () => {
  test("the committed baselines are the snapshot files git holds, nothing else under e2e/", () => {
    write("e2e/visual.spec.ts-snapshots/untracked-chromium-darwin.png", "U");
    expect(committedBaselines(repo)).toEqual([A, B]);
  });

  test("what is uncommitted under a directory, untracked files included, and only there", () => {
    write(A, "A1");
    write("e2e/new-chromium-darwin.png", "N");
    write(PAGE, "export default 2;\n");
    expect(uncommittedUnder("e2e", repo).sort()).toEqual(["e2e/new-chromium-darwin.png", A]);
  });
});

describe("restoreFromHead", () => {
  test("puts back exactly the baselines it is given, and deletes a record HEAD never held", () => {
    write(A, "A1");
    write(B, "B1");
    write(BASELINE_RENDERER_PATH, "{}\n");
    restoreFromHead([A], repo);
    expect(read(A)).toBe("A0");
    // not in the list, so not this run's to put back
    expect(read(B)).toBe("B1");
    expect(fs.existsSync(path.join(repo, BASELINE_RENDERER_PATH))).toBe(false);
  });

  test("a record HEAD holds is put back, not deleted", () => {
    write(BASELINE_RENDERER_PATH, "R0");
    commit("record", BASELINE_RENDERER_PATH);
    write(BASELINE_RENDERER_PATH, "R1");
    restoreFromHead([], repo);
    expect(read(BASELINE_RENDERER_PATH)).toBe("R0");
  });

  test("after a restore of everything that was written, e2e/ is exactly HEAD again", () => {
    write(A, "A1");
    write(B, "B1");
    write(BASELINE_RENDERER_PATH, "{}\n");
    restoreFromHead([A, B], repo);
    expect(uncommittedUnder("e2e", repo)).toEqual([]);
  });

  /**
   * `git restore` takes .git/index.lock, and while another git process holds it (an editor's
   * status poll, a `git add` in another terminal) it exits 128 having touched nothing. A red
   * gate's restore cannot wait for that, and must not depend on it.
   */
  test("puts everything back while another git process holds .git/index.lock", () => {
    write(A, "A1");
    write(BASELINE_RENDERER_PATH, "{}\n");
    fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
    restoreFromHead([A], repo);
    expect(read(A)).toBe("A0");
    expect(fs.existsSync(path.join(repo, BASELINE_RENDERER_PATH))).toBe(false);
  });

  /** "HEAD does not hold it" deletes a file, so a git that cannot answer must never mean that. */
  test("a git that cannot answer deletes nothing, and names every file", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-repo-not-a-repo-"));
    try {
      for (const file of [A, BASELINE_RENDERER_PATH]) {
        fs.mkdirSync(path.dirname(path.join(plain, file)), { recursive: true });
        fs.writeFileSync(path.join(plain, file), "written");
      }
      expect(() => restoreFromHead([A], plain)).toThrow(
        new RegExp(`^2 file\\(s\\) could not be put back.*${BASELINE_RENDERER_PATH}.*${A}`),
      );
      expect(fs.existsSync(path.join(plain, A))).toBe(true);
      expect(fs.existsSync(path.join(plain, BASELINE_RENDERER_PATH))).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  /**
   * The record is what lets the next run say "Nothing to do", so it goes first, and a baseline
   * that cannot be put back stops neither it nor the others. The one left is named.
   */
  test.skipIf(AS_ROOT)("a file it cannot put back is named, and the rest still go back", () => {
    const stuck = "e2e/zz.spec.ts-snapshots/stuck-chromium-darwin.png";
    write(stuck, "S0");
    commit("another baseline", stuck);
    write(A, "A1");
    write(B, "B1");
    write(stuck, "S1");
    write(BASELINE_RENDERER_PATH, "{}\n");
    const dir = path.join(repo, path.dirname(stuck));
    fs.chmodSync(path.join(repo, stuck), 0o444);
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => restoreFromHead([A, stuck, B], repo)).toThrow(stuck);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(path.join(repo, stuck), 0o644);
    }
    expect(fs.existsSync(path.join(repo, BASELINE_RENDERER_PATH))).toBe(false);
    expect(read(A)).toBe("A0");
    expect(read(B)).toBe("B0");
    expect(read(stuck)).toBe("S1");
  });
});

/**
 * SIGKILL cannot be caught, and a closed session may not signal at all: a --confirm killed
 * between writing and its gate's answer leaves twins and a record no gate passed, which the next
 * run's canary would match and call "Nothing to do". The mark is how the next run knows.
 */
describe("a re-base no gate has passed yet", () => {
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const status = () =>
    execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });

  /** What a --confirm killed during its gate leaves: the mark, twins, and a record. */
  function killedDuringTheGate(files: string[]): void {
    markPendingReBase(files, repo);
    for (const file of files) write(file, "TWIN");
    write(BASELINE_RENDERER_PATH, "{}\n");
  }

  test("the mark is left inside .git: never committed, never in git status", () => {
    expect(readPendingReBase(repo)).toBeNull();
    markPendingReBase([A, B], repo, new Date("2026-09-29T16:00:00Z"));
    expect(readPendingReBase(repo)).toEqual({
      head: head().trim(),
      files: [A, B],
      startedOn: "2026-09-29T16:00:00.000Z",
    });
    expect(path.relative(repo, pendingMarkPath(repo)).split(path.sep)[0]).toBe(".git");
    expect(status()).toBe("");
    clearPendingReBase(repo);
    expect(readPendingReBase(repo)).toBeNull();
  });

  test("with no mark, nothing is pending and nothing is touched", () => {
    write(A, "A1");
    expect(settlePendingReBase(repo)).toEqual({ settled: "nothing-pending" });
    expect(read(A)).toBe("A1");
  });

  test("the next run puts back what a killed --confirm wrote, and removes the mark", () => {
    killedDuringTheGate([A]);
    const settled = settlePendingReBase(repo);
    expect(settled).toMatchObject({ settled: "put-back", pending: { files: [A] } });
    expect(read(A)).toBe("A0");
    expect(fs.existsSync(path.join(repo, BASELINE_RENDERER_PATH))).toBe(false);
    expect(readPendingReBase(repo)).toBeNull();
    expect(uncommittedUnder("e2e", repo)).toEqual([]);
  });

  /** HEAD's copy of each file is still the one that run started from, so it is exact. */
  test("a commit since that touched none of its files: still put back", () => {
    killedDuringTheGate([A]);
    write(PAGE, "export default 2;\n");
    commit("a UI change of its own", PAGE);
    expect(settlePendingReBase(repo).settled).toBe("put-back");
    expect(read(A)).toBe("A0");
  });

  /** That commit may carry the unverified twins; putting back from it would bless them. */
  test("a commit since that changed one of its files: nothing touched, the mark kept", () => {
    killedDuringTheGate([A, B]);
    commit("the killed run's twin, committed", A);
    const settled = settlePendingReBase(repo);
    expect(settled).toMatchObject({ settled: "committed-since", touched: [A] });
    expect(read(B)).toBe("TWIN");
    expect(readPendingReBase(repo)).not.toBeNull();
  });

  test.skipIf(AS_ROOT)("a restore that fails keeps the mark, so the run after tries again", () => {
    killedDuringTheGate([A]);
    const dir = path.join(repo, path.dirname(A));
    fs.chmodSync(path.join(repo, A), 0o444);
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => settlePendingReBase(repo)).toThrow(A);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(path.join(repo, A), 0o644);
    }
    expect(readPendingReBase(repo)).not.toBeNull();
    expect(settlePendingReBase(repo).settled).toBe("put-back");
    expect(read(A)).toBe("A0");
  });
});

describe("bundleFromHead", () => {
  test("no build, then a build nobody marked, then this command's own build", () => {
    expect(bundleFromHead(repo)).toEqual({ fromHead: false, saw: "there is no .next build" });
    age(PAGE, 60);
    build("first");
    expect(bundleFromHead(repo).saw).toMatch(/records no commit it was built from/);
    markBundleBuilt(repo);
    expect(bundleFromHead(repo)).toEqual({
      fromHead: true,
      saw: ".next first was built from HEAD's sources",
    });
  });

  /** Committing a re-base touches e2e/ only; it must not cost a rebuild. */
  test("a commit to e2e/ or docs/ leaves the build HEAD's; one to the sources does not", () => {
    age(PAGE, 60);
    build("first");
    markBundleBuilt(repo);
    write(A, "A1");
    write("docs/notes.md", "more notes\n");
    commit("re-base", A, "docs/notes.md");
    expect(bundleFromHead(repo).fromHead).toBe(true);

    write(PAGE, "export default 2;\n");
    commit("a UI change", PAGE);
    age(PAGE, 60);
    expect(bundleFromHead(repo).saw).toMatch(/was built from [0-9a-f]{7}, not from HEAD's sources/);
  });

  test("a source touched after the build fails global-setup's rule, even unchanged", () => {
    age(PAGE, 60);
    build("first");
    markBundleBuilt(repo);
    age(PAGE, -60);
    expect(bundleFromHead(repo).saw).toMatch(/src\/app\/page\.tsx is newer than the build/);
  });

  test("a build made since this command marked one is not trusted on the old mark", () => {
    age(PAGE, 60);
    build("first");
    markBundleBuilt(repo);
    build("second");
    expect(bundleFromHead(repo).saw).toMatch(/\.next second was built since/);
  });
});
