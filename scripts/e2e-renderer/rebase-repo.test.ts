import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BASELINE_RENDERER_PATH } from "./fingerprint";
import {
  bundleFromHead,
  committedBaselines,
  markBundleBuilt,
  restoreFromHead,
  uncommittedUnder,
} from "./rebase-repo";

/**
 * Against a real repository in a temp directory: the restore is what stands between a red gate
 * and a half-re-based tree, so it is proved on git itself rather than on a fake of it.
 */
let repo: string;

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
