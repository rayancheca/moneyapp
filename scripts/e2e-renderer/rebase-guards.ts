import net from "node:net";
import { assertQuietBox } from "../quiet-box";
import type { RebaseArgs } from "./rebase-plan";
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

export interface PushState {
  /** HEAD, short */
  head: string;
  /** null when there is no origin/main to compare with */
  onOriginMain: boolean | null;
  /** HEAD's commits that origin/main does not have */
  unpushed: number;
}

export function pushState(cwd?: string): PushState {
  const head = git(["rev-parse", "--short", "HEAD"], cwd).trim();
  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", "origin/main"], cwd)) {
    return { head, onOriginMain: null, unpushed: 0 };
  }
  const unpushed = Number(git(["rev-list", "--count", "origin/main..HEAD"], cwd).trim());
  return { head, onOriginMain: unpushed === 0, unpushed };
}

/**
 * Pushed is this project's word for "passed the gate": main is pushed only after a green one, so
 * a pushed HEAD's committed baselines are its UI. An unpushed HEAD is never refused here, because
 * a missing record, a canary edit or a Geist bump is always an unpushed commit, and until the
 * renderer is recorded no gate can pass for it to be pushed. What it may do is decided after the
 * control (planRebase): record the renderer alone, which the control proves when the gate's own
 * comparator passes every baseline, or copy twins, which only --allow-unpushed permits. The
 * control proves no baseline itself: it redraws every screenshot rather than comparing one.
 */
export function pushedGuard(state: PushState, allowUnpushed: boolean): GuardLine {
  const { head } = state;
  const what = "HEAD is on origin/main";
  if (state.onOriginMain === null) {
    return { mark: "✗", what, saw: "there is no origin/main to compare with" };
  }
  if (state.onOriginMain) {
    return { mark: "✓", what, saw: `${head} was pushed, so it passed the gate` };
  }
  const commits = `${state.unpushed} commit${state.unpushed === 1 ? "" : "s"} not on origin/main`;
  if (allowUnpushed) {
    return {
      mark: "⚠",
      what: "HEAD is NOT on origin/main",
      saw:
        `${head} has ${commits}; --allow-unpushed accepts it. Nothing proves the committed ` +
        "baselines are its UI, and the control redraws every screenshot rather than comparing " +
        "one: diffVerdict's content check is all that stands between a UI change in those " +
        "commits and a re-base",
    };
  }
  return {
    mark: "⚠",
    what: "HEAD is NOT on origin/main",
    saw:
      `${head} has ${commits}, so nothing proves the committed baselines are its UI. Recording ` +
      "the renderer alone goes ahead, proved by the control when the gate's own comparator " +
      "passes every baseline; copying a twin over one is refused unless --allow-unpushed",
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
