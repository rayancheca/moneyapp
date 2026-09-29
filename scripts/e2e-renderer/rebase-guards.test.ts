import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pushedGuard, pushProof, pushState } from "./rebase-guards";

/** Against a real repository in a temp directory, with origin/main set as a ref. */
let repo: string;

function gitIn(...args: string[]): void {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, ...args], { cwd: repo, stdio: "pipe" });
}
function commit(message: string): void {
  gitIn("commit", "-q", "--allow-empty", "-m", message);
}
function headSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}
/** What `git push origin main` does to this clone's origin/main: moves it, and logs the move. */
function push(): void {
  gitIn("update-ref", "-m", "update by push", "refs/remotes/origin/main", "HEAD");
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-guards-test-"));
  gitIn("init", "-q");
  commit("pushed");
  push();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("the pushed guard", () => {
  test("a HEAD that is origin/main's tip passed the gate", () => {
    const state = pushState(repo);
    expect(state).toMatchObject({ at: "a-pushed-tip" });
    const line = pushedGuard(state, false);
    expect(line.mark).toBe("✓");
    expect(line.saw).toMatch(/was origin\/main's tip, so it passed the gate/);
    expect(pushProof(state, false)).toEqual({ pushed: true, allowUnpushed: false });
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
    expect(state).toMatchObject({ at: "unpushed", unpushed: 2 });
    expect(pushProof(state, false).pushed).toBe(false);
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

  /**
   * main is pushed only after a green gate, but one push carries every commit since the last and
   * only its tip was gated. 4e1c1c4..a119119 carried 16: 6d30ef4 changed the recurring page, its
   * 16 baselines were re-drawn 11 commits later in f8daf91, and 980ad69 between them is on
   * origin/main with baselines that are not its UI.
   */
  test("a commit a push carried past, never origin/main's tip, did not pass the gate", () => {
    commit("fix(forecast): the UI change");
    commit("fix(spending): inside the push");
    const inside = headSha();
    commit("chore(e2e): its baselines, re-drawn");
    push();
    gitIn("checkout", "-q", "--detach", inside);
    const state = pushState(repo);
    const line = pushedGuard(state, false);
    expect(line.mark).toBe("⚠");
    expect(line.saw).not.toMatch(/passed the gate/);
    expect(line.saw).toMatch(/on origin\/main, but a push carried it past/);
    expect(line.saw).toMatch(/refused unless --allow-unpushed/);
    expect(pushProof(state, false)).toEqual({ pushed: false, allowUnpushed: false });
    expect(state).toMatchObject({ at: "inside-a-push" });
    const allowed = pushedGuard(state, true);
    expect(allowed.mark).toBe("⚠");
    expect(allowed.saw).toMatch(/a push carried it past/);
    expect(allowed.saw).toMatch(/diffVerdict's content check is all that stands between/);
  });

  /**
   * A clone whose reflog of origin/main is gone (expired, or never written) knows one tip: the
   * one origin/main has now. Every other commit on it is not vouched for, which only ever costs
   * a --allow-unpushed, never a re-base a gate did not pass.
   */
  test("with no reflog of origin/main, its tip now still counts, and nothing before it", () => {
    const parent = headSha();
    commit("the tip");
    push();
    fs.rmSync(path.join(repo, ".git", "logs", "refs", "remotes", "origin", "main"));
    expect(pushState(repo)).toMatchObject({ at: "a-pushed-tip" });
    gitIn("checkout", "-q", "--detach", parent);
    expect(pushState(repo)).toMatchObject({ at: "inside-a-push" });
  });

  /** The reflog is what says so: a tip stays a tip after later pushes move origin/main on. */
  test("an earlier tip, since pushed past, passed the gate when it was the tip", () => {
    const earlier = headSha();
    commit("the next push");
    push();
    gitIn("checkout", "-q", "--detach", earlier);
    const state = pushState(repo);
    expect(state).toMatchObject({ at: "a-pushed-tip" });
    expect(pushedGuard(state, false).mark).toBe("✓");
    expect(pushProof(state, false).pushed).toBe(true);
  });

  test("with no origin/main there is nothing to compare with, flag or not", () => {
    gitIn("update-ref", "-d", "refs/remotes/origin/main");
    const state = pushState(repo);
    expect(state.at).toBe("no-origin-main");
    expect(pushedGuard(state, true).mark).toBe("✗");
    expect(pushProof(state, true).pushed).toBe(false);
  });
});
