import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pushedGuard, pushState } from "./rebase-guards";

/** Against a real repository in a temp directory, with origin/main set as a ref. */
let repo: string;

function gitIn(...args: string[]): void {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, ...args], { cwd: repo, stdio: "pipe" });
}
function commit(message: string): void {
  gitIn("commit", "-q", "--allow-empty", "-m", message);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-guards-test-"));
  gitIn("init", "-q");
  commit("pushed");
  gitIn("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("the pushed guard", () => {
  test("a HEAD on origin/main passed the gate", () => {
    const state = pushState(repo);
    expect(state).toMatchObject({ onOriginMain: true, unpushed: 0 });
    expect(pushedGuard(state, false).mark).toBe("✓");
  });

  /**
   * No record, a canary edit, a Geist bump: each is an unpushed commit, and until the renderer
   * is recorded no gate can pass, so "push it after a green gate" could never be done. Recording
   * alone needs no proof the control does not give, so it is said, not refused; only a copied
   * twin needs --allow-unpushed, and that is decided after the control (planRebase).
   */
  test("an unpushed HEAD without the flag is said, not refused: the record may go ahead", () => {
    commit("the merge that brought the canary");
    commit("a second");
    const state = pushState(repo);
    expect(state).toMatchObject({ onOriginMain: false, unpushed: 2 });
    const line = pushedGuard(state, false);
    expect(line.mark).toBe("⚠");
    expect(line.saw).toMatch(/2 commits not on origin\/main/);
    expect(line.saw).toMatch(/the renderer alone/);
    expect(line.saw).toMatch(/refused unless --allow-unpushed/);
    expect(line.saw).not.toMatch(/Push it after a green gate/);
  });

  /**
   * The control runs with --update-snapshots=all, so it compares no baseline: under the flag,
   * diffVerdict's content verdicts are the only thing between a UI change and a re-base.
   */
  test("under --allow-unpushed it names diffVerdict, not the control, as the check left", () => {
    commit("unpushed");
    const line = pushedGuard(pushState(repo), true);
    expect(line.mark).toBe("⚠");
    expect(line.saw).toMatch(/diffVerdict's content check is all that stands between/);
    expect(line.saw).not.toMatch(/only proof/);
  });

  test("with no origin/main there is nothing to compare with, flag or not", () => {
    gitIn("update-ref", "-d", "refs/remotes/origin/main");
    const state = pushState(repo);
    expect(state.onOriginMain).toBeNull();
    expect(pushedGuard(state, true).mark).toBe("✗");
  });
});
