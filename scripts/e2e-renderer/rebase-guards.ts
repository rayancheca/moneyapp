import net from "node:net";
import { assertQuietBox } from "../quiet-box";
import type { PushProof, RebaseArgs } from "./rebase-plan";
import { git, gitSucceeds, lines } from "./rebase-repo";

/**
 * The checks `pnpm e2e:rebase-renderer` makes before it spends eight minutes on a control run.
 * Each answers with a line in the house guard shape; any ✗ is a refusal, a ⚠ is said and allowed.
 * They only look: the one guard that may act, building .next, is the caller's.
 */

/** playwright.config.ts serves the app here, and refuses to reuse a server already on it. */
export const E2E_PORT = 3111;

export type Mark = "✓" | "✗" | "⚠";

export interface GuardLine {
  mark: Mark;
  what: string;
  saw: string;
}

/** Whether anything answers on the port, on either loopback address `localhost` can mean. */
export async function portAnswers(port: number): Promise<string | null> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(1_000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  for (const host of ["127.0.0.1", "::1"]) if (await answers(host)) return host;
  return null;
}

function treeGuards(): GuardLine[] {
  const head = git(["rev-parse", "--short", "HEAD"]).trim();
  const dirty = lines(git(["status", "--porcelain", "--untracked-files=no"])).map((l) => l.trim());
  const untracked = lines(
    git(["ls-files", "--others", "--exclude-standard", "--", "src", "e2e", "public"]),
  );
  const changed = `${dirty.length} changed: ${dirty.slice(0, 4).join("; ")}`;
  return [
    {
      mark: dirty.length === 0 ? "✓" : "✗",
      what: "the tracked tree is clean",
      saw: dirty.length === 0 ? `HEAD ${head}` : changed,
    },
    {
      mark: untracked.length === 0 ? "✓" : "✗",
      what: "no untracked files under src/ e2e/ public/",
      saw: untracked.length === 0 ? "none" : untracked.slice(0, 4).join(", "),
    },
  ];
}

const ORIGIN_MAIN = "refs/remotes/origin/main";

/**
 * Where HEAD stands against origin/main. main is pushed only after a green gate, but one push
 * carries every commit since the last and only its tip was gated: 4e1c1c4..a119119 carried 16,
 * and between 6d30ef4's UI change and f8daf91, which re-drew its 16 baselines, sat commits on
 * origin/main whose committed baselines were not their UI.
 */
export type PushState = { head: string } & (
  | { at: "no-origin-main" }
  /** a commit origin/main has pointed at: now, or before, in this clone's reflog of it */
  | { at: "a-pushed-tip" }
  /** on origin/main, but only inside a push: the reflog never names it as the tip */
  | { at: "inside-a-push" }
  /** with commits origin/main does not have */
  | { at: "unpushed"; unpushed: number }
);

/**
 * Every commit origin/main has pointed at, as far as this clone's reflog of it goes back (a push
 * or a fetch logs each move; a ref with no reflog gives its tip alone), and its tip now.
 */
function originMainTips(cwd?: string): Set<string> {
  const now = git(["rev-parse", "--verify", `${ORIGIN_MAIN}^{commit}`], cwd).trim();
  const logged = git(["log", "--walk-reflogs", "--format=%H", ORIGIN_MAIN, "--"], cwd);
  return new Set([now, ...lines(logged)]);
}

export function pushState(cwd?: string): PushState {
  const head = git(["rev-parse", "--short", "HEAD"], cwd).trim();
  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", ORIGIN_MAIN], cwd)) {
    return { head, at: "no-origin-main" };
  }
  if (originMainTips(cwd).has(git(["rev-parse", "HEAD"], cwd).trim())) {
    return { head, at: "a-pushed-tip" };
  }
  const unpushed = Number(git(["rev-list", "--count", `${ORIGIN_MAIN}..HEAD`], cwd).trim());
  return unpushed === 0 ? { head, at: "inside-a-push" } : { head, at: "unpushed", unpushed };
}

/**
 * What planRebase is told, from the same state the guard line reads: only a tip origin/main has
 * held passed a gate, so only such a HEAD vouches for its committed baselines.
 */
export function pushProof(state: PushState, allowUnpushed: boolean): PushProof {
  return { pushed: state.at === "a-pushed-tip", allowUnpushed };
}

/**
 * A tip origin/main has held is this project's "passed the gate": main is pushed only after a
 * green one, so that commit's committed baselines are its UI. Any other HEAD is never refused
 * here, because a missing record, a canary edit or a Geist bump is always an unpushed commit, and
 * until the renderer is recorded no gate can pass for it to be pushed. What it may do is decided
 * after the control (planRebase): record the renderer alone, which the control proves when the
 * gate's own comparator passes every baseline, or copy twins, which only --allow-unpushed
 * permits. The control proves no baseline itself: it redraws every screenshot rather than
 * comparing one.
 */
export function pushedGuard(state: PushState, allowUnpushed: boolean): GuardLine {
  const { head } = state;
  const what = "HEAD was pushed as origin/main's tip";
  if (state.at === "no-origin-main") {
    return { mark: "✗", what, saw: "there is no origin/main to compare with" };
  }
  if (state.at === "a-pushed-tip") {
    return { mark: "✓", what, saw: `${head} was origin/main's tip, so it passed the gate` };
  }
  const where =
    state.at === "inside-a-push"
      ? `${head} is on origin/main, but a push carried it past: this clone's reflog of ` +
        "origin/main never names it as the tip, and a push's tip is all a gate ran at"
      : `${head} has ${state.unpushed} commit${state.unpushed === 1 ? "" : "s"} not on origin/main`;
  const not = "HEAD was NOT pushed as origin/main's tip";
  if (allowUnpushed) {
    return {
      mark: "⚠",
      what: not,
      saw:
        `${where}; --allow-unpushed accepts it. Nothing proves the committed baselines are its ` +
        "UI, and the control redraws every screenshot rather than comparing one: diffVerdict's " +
        "content check is all that stands between a UI change no gate saw and a re-base",
    };
  }
  return {
    mark: "⚠",
    what: not,
    saw:
      `${where}, so nothing proves the committed baselines are its UI. Recording the renderer ` +
      "alone goes ahead, proved by the control when the gate's own comparator passes every " +
      "baseline; copying a twin over one is refused unless --allow-unpushed",
  };
}

async function machineGuards(): Promise<GuardLine[]> {
  const listener = await portAnswers(E2E_PORT);
  const port: GuardLine = {
    mark: listener === null ? "✓" : "✗",
    what: `port ${E2E_PORT} is free`,
    saw:
      listener === null
        ? "nothing answers"
        : `something answers on ${listener}:${E2E_PORT} (lsof -ti:${E2E_PORT} names it)`,
  };
  try {
    const load = assertQuietBox({ suite: "e2e:rebase-renderer", escapeHatch: "E2E_ALLOW_LOAD" });
    const busy = load.verdict === "quiet" ? "" : ", busy";
    const saw = `load ${load.load1.toFixed(1)} on ${load.cores} cores${busy}`;
    return [port, { mark: busy === "" ? "✓" : "⚠", what: "the box is quiet", saw }];
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
    return [port, { mark: "✗", what: "the box is quiet", saw: first }];
  }
}

/**
 * E2E_ALLOW_STALE=1 skips global-setup's freshness rule. A rehearsal on a borrowed .next needs
 * it; a --confirm must judge HEAD's own build, so there it is refused.
 */
function staleBundleGuard(confirm: boolean): GuardLine | null {
  if (process.env.E2E_ALLOW_STALE !== "1") return null;
  if (confirm) {
    const saw = "--confirm judges HEAD's own build: unset E2E_ALLOW_STALE";
    return { mark: "✗", what: ".next is built from HEAD", saw };
  }
  const saw = "E2E_ALLOW_STALE=1 (a dry run only): nothing proves it is HEAD's";
  return { mark: "⚠", what: ".next is trusted as current", saw };
}

export async function checkGuards(args: RebaseArgs, push: PushState): Promise<GuardLine[]> {
  const stale = staleBundleGuard(args.confirm);
  return [
    ...treeGuards(),
    pushedGuard(push, args.allowUnpushed),
    ...(await machineGuards()),
    ...(stale === null ? [] : [stale]),
  ];
}
