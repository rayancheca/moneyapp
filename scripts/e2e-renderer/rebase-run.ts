import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decodePng, diffVerdict, type DiffVerdict } from "./diff-verdict";
import { RENDERER_CHECK_ENV } from "./fingerprint";
import { askGate, loadGateComparator, type GateFails, type GateOptions } from "./gate-comparator";
import type { Judged, RebaseArgs } from "./rebase-plan";
import { SNAPSHOT_ROOT_ENV } from "./snapshot-root";
import { outcomeFromReport, type Attempt, type SuiteOutcome } from "./suite-run";

/**
 * The processes `pnpm e2e:rebase-renderer` starts — `next build` and the two kinds of suite run —
 * and the judging of what the control drew. Output streams to the terminal and to a log in the
 * scratch directory, so a refusal can point at the log instead of at scrollback.
 */

/** Streams a child's output to the terminal and to a log file, and resolves with its exit code. */
export function spawnLogged(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.once("error", (error) => log.end(() => reject(error)));
    child.once("close", (code) => log.end(() => resolve(code)));
  });
}

export function buildBundle(logFile: string): Promise<number | null> {
  return spawnLogged("pnpm", ["exec", "next", "build"], process.env, logFile);
}

export type SuiteKind = "control" | "gate";

export interface SuiteContext {
  scratch: string;
  snapshotRoot: string;
  only: RebaseArgs["only"];
}

/**
 * The control draws with the renderer check skipped and --update-snapshots=all into the scratch
 * root; the gate is the owner's own gate, E2E_GATE=1 with the check on, reading e2e/. Each strips
 * the other's switches from the environment, whatever the shell that started it had set.
 */
export function suiteEnv(kind: SuiteKind, n: number, ctx: SuiteContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(ctx.scratch, `${kind}-${n}.json`),
    PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: path.join(ctx.scratch, `${kind}-last-run.json`),
  };
  delete env.E2E_GATE;
  delete env[RENDERER_CHECK_ENV];
  delete env[SNAPSHOT_ROOT_ENV];
  if (kind === "control") {
    env[RENDERER_CHECK_ENV] = "skip";
    env[SNAPSHOT_ROOT_ENV] = ctx.snapshotRoot;
  } else env.E2E_GATE = "1";
  return env;
}

export function suiteArgs(kind: SuiteKind, attempt: Attempt, only: RebaseArgs["only"]): string[] {
  return [
    "exec",
    "playwright",
    "test",
    ...(only === null ? [] : [only.spec]),
    ...(only?.grep == null ? [] : ["-g", only.grep]),
    kind === "control" ? "--update-snapshots=all" : "--update-snapshots=none",
    ...(attempt.lastFailed ? ["--last-failed"] : []),
    "--reporter=list,json",
  ];
}

export async function runSuite(
  kind: SuiteKind,
  attempt: Attempt,
  ctx: SuiteContext,
  announce: (title: string) => void,
): Promise<SuiteOutcome> {
  const n = attempt.lastFailed ? 2 : 1;
  const env = suiteEnv(kind, n, ctx);
  const report = env.PLAYWRIGHT_JSON_OUTPUT_FILE!;
  const log = path.join(ctx.scratch, `${kind}.log`);
  const again = n === 2 ? ", re-running what failed" : "";
  announce(`${kind === "control" ? "Control" : "Gate"}${again} (log: ${log})`);
  fs.rmSync(report, { force: true });
  const code = await spawnLogged("pnpm", suiteArgs(kind, attempt, ctx.only), env, log);
  let json: unknown = null;
  try {
    json = JSON.parse(fs.readFileSync(report, "utf8"));
  } catch {
    json = null;
  }
  return outcomeFromReport(code, json);
}

/* ── Judging what the control drew ────────────────────────────────────────────────────────── */

export function walkFiles(root: string, dir: string = root): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(root, full);
    return entry.isFile() ? [path.relative(root, full)] : [];
  });
}

async function gateOptions(): Promise<GateOptions> {
  const config = (await import("../../playwright.config")).default;
  const shot = config.expect?.toHaveScreenshot ?? {};
  return {
    maxDiffPixels: shot.maxDiffPixels,
    maxDiffPixelRatio: shot.maxDiffPixelRatio,
    threshold: shot.threshold,
  };
}

/**
 * The gate's own screenshot options, read from playwright.config.ts so that asking "would the
 * gate fail this?" uses exactly what the gate uses; or why the comparator cannot be reached.
 * The config is read in this process, under whatever the shell left set, and refuses to load for
 * a gate's E2E_GATE beside a snapshot root (snapshot-root.ts): that is the comparator unavailable
 * too, never a crash after the control.
 */
export async function gateComparator(): Promise<{ fails: GateFails } | { unavailable: string }> {
  let options: GateOptions;
  try {
    options = await gateOptions();
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { unavailable: `playwright.config.ts did not load: ${why}` };
  }
  return loadGateComparator(options);
}

const BYTE_IDENTICAL: DiffVerdict = {
  verdict: "identical",
  reasons: ["the two files are byte-identical"],
  metrics: {
    changedPixels: 0,
    changedFraction: 0,
    maxDelta: 0,
    meanDelta: 0,
    bbox: null,
    decidingMeasure: "pixels",
  },
};

/**
 * Every pair through diffVerdict. A renderer-only one is also put to the gate's comparator, whose
 * answer decides whether it is re-based (withinGateTolerance in rebase-plan.ts). With no
 * comparator (`gateFails` null, which the caller says once) every such answer is "unknown"; a
 * comparator that throws on one pair makes that one "unknown", and `unjudged` hears why.
 */
export async function judgeAll(
  pairs: readonly { baseline: string; twin: string }[],
  root: string,
  gateFails: GateFails | null,
  progress: (done: number, of: number) => void,
  unjudged: (baseline: string, why: string) => void,
): Promise<Judged[]> {
  const judged: Judged[] = [];
  for (const { baseline, twin } of pairs) {
    const committed = fs.readFileSync(baseline);
    const drawn = fs.readFileSync(path.join(root, twin));
    const verdict = committed.equals(drawn)
      ? BYTE_IDENTICAL
      : diffVerdict(await decodePng(committed), await decodePng(drawn));
    if (verdict.verdict !== "renderer-only") judged.push({ baseline, verdict });
    else {
      const asked = gateFails === null ? null : askGate(gateFails, committed, drawn);
      if (asked?.why !== undefined) unjudged(baseline, asked.why);
      judged.push({ baseline, verdict, gate: asked?.answer ?? "unknown" });
    }
    if (judged.length % 25 === 0) progress(judged.length, pairs.length);
  }
  return judged;
}
