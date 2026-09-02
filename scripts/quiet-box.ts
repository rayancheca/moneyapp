import { execFileSync } from "node:child_process";
import os from "node:os";

/**
 * Refuse to start a timing-sensitive suite on a machine that is already busy.
 *
 * 🔴 THE RUN THIS EXISTS TO PREVENT, measured 2026-09-01. `BTLEServer` had been
 * pegged at 100% CPU for 35 days, with `mds` and `mobileassetd` alongside it and
 * two other agent sessions live. `uptime` read **44.65** on a 15-core box.
 * Under that:
 *
 *   - the e2e gate took **2.9 hours** instead of 8.4 minutes, and reported 57
 *     failures of which ~17 were pure 30-second timeouts;
 *   - three consecutive full unit runs failed a DIFFERENT set of files each
 *     time — 4, then 8, then 9 — and every one of them passed alone, each as a
 *     uniform 208.7-second stall;
 *   - the reported test COUNT moved between runs (4,349 / 4,396 / 4,408),
 *     because a file that dies in `beforeEach` never registers its tests at
 *     all, so a green-looking total was smaller than the truth.
 *
 * ⛔ None of that looks like an environment problem while it is happening. It
 * looks like flaky tests, and the cost is measured in hours of re-running and
 * in baselines regenerated from diffs that were never real. A guard that says
 * so up front is worth more than any amount of retry logic, because a retry
 * spends MORE of the CPU that is already the problem.
 *
 * ⚠️ Deliberately measured BEFORE the workers spawn, so it sees the load the
 * suite is about to compete with rather than the load it creates.
 */

/** Above this many runnable processes per core, a run is not worth starting. */
export const LOAD_PER_CORE_REFUSE = 1.5;
/** Above this, the run proceeds but says the timings cannot be trusted. */
export const LOAD_PER_CORE_WARN = 0.8;

export interface BoxLoad {
  load1: number;
  cores: number;
  perCore: number;
  verdict: "quiet" | "busy" | "overloaded";
}

export function readBoxLoad(load1: number, cores: number): BoxLoad {
  // a zero or missing core count would make every box look infinitely loaded
  const safeCores = Math.max(1, cores);
  const perCore = load1 / safeCores;
  return {
    load1,
    cores: safeCores,
    perCore,
    verdict:
      perCore >= LOAD_PER_CORE_REFUSE ? "overloaded" : perCore >= LOAD_PER_CORE_WARN ? "busy" : "quiet",
  };
}

/**
 * The three processes burning the most CPU, so the message is ACTIONABLE.
 *
 * Diagnosing this by hand cost most of an hour: the failures pointed at tests,
 * `uptime` pointed at a number, and only `ps` pointed at the daemon that had
 * been spinning for 35 days. Best-effort — a suite must never fail because a
 * diagnostic did.
 */
export function topCpuProcesses(): string[] {
  try {
    const out = execFileSync("/bin/ps", ["-eo", "pcpu,etime,comm"], { encoding: "utf8", timeout: 3_000 });
    return out
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => {
        const [pcpu = "", etime = "", ...rest] = l.split(/\s+/);
        return { pcpu: Number(pcpu), text: `${pcpu}% ${etime.padEnd(12)} ${rest.join(" ").split("/").pop()}` };
      })
      .filter((p) => Number.isFinite(p.pcpu) && p.pcpu >= 20)
      .sort((a, b) => b.pcpu - a.pcpu)
      .slice(0, 3)
      .map((p) => p.text);
  } catch {
    return [];
  }
}

export function quietBoxMessage(load: BoxLoad, suite: string, escapeHatch: string): string {
  const top = topCpuProcesses();
  const busiest = top.length === 0 ? "" : `\n      busiest right now:\n${top.map((t) => `        ${t}`).join("\n")}`;
  return (
    `${suite}: THE BOX IS ALREADY BUSY — load average ${load.load1.toFixed(1)} across ${load.cores} cores ` +
    `(${load.perCore.toFixed(1)} per core).\n` +
    "      A timing-sensitive suite started here does not fail honestly: it stalls, times out, and blames a\n" +
    "      different set of tests every run. The last time this was ignored the e2e gate took 2.9 HOURS\n" +
    `      instead of 8.4 minutes and reported 57 failures, most of them nothing.${busiest}\n` +
    `      Quieten the machine and try again, or set ${escapeHatch}=1 to run anyway.`
  );
}

/**
 * Throws when the box is too busy to trust; returns the reading either way so a
 * caller can print the "busy but proceeding" note itself.
 */
export function assertQuietBox(opts: {
  suite: string;
  escapeHatch: string;
  load1?: number;
  cores?: number;
  /** ⛔ A plain record, not `NodeJS.ProcessEnv`: this reads ONE key, and a test
   *  should be able to hand it exactly that key without inventing a NODE_ENV. */
  env?: Readonly<Record<string, string | undefined>>;
}): BoxLoad {
  const env = opts.env ?? process.env;
  const load = readBoxLoad(opts.load1 ?? os.loadavg()[0]!, opts.cores ?? os.cpus().length);
  if (load.verdict === "overloaded" && env[opts.escapeHatch] !== "1") {
    throw new Error(quietBoxMessage(load, opts.suite, opts.escapeHatch));
  }
  return load;
}
