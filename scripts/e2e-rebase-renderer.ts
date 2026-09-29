/**
 * `pnpm e2e:rebase-renderer` — re-base the e2e baselines when, and only when, the Mac's text
 * rendering moved and nothing else did.
 *
 * On 2026-09-28 a macOS update failed 107 of 202 baselines at maxDiffPixels 0 with no UI change.
 * The session proved it by hand: the same gate failed the same files on the last pushed commit,
 * every rewritten file was compared with its committed version, and only then were 111 re-based
 * (c3b9a59) and the gate re-run. This is that procedure, with a refusal wherever the proof fails:
 *
 *   0. the renderer canary against e2e/baseline-renderer.json: a match is "Nothing to do";
 *   1. guards: a clean tree, HEAD pushed as origin/main's tip (a push's tip passed the gate; the
 *      commits a push carried past it did not, and neither did an unpushed one: such a HEAD is
 *      said, and decided at step 3), port 3111 free, a quiet box, and .next built from HEAD
 *      (built here when it is not);
 *   2. a control run of the whole suite at HEAD, renderer check skipped, every screenshot drawn
 *      into a scratch root rather than e2e/ (E2E_SNAPSHOT_ROOT); a failure gets one re-run of
 *      what failed, and a second failure is a refusal: HEAD is not green here, or the box is busy;
 *   3. every committed baseline judged against its twin by scripts/e2e-renderer/diff-verdict.ts:
 *      a missing or extra twin, or one "content" verdict, and nothing is written. Of the
 *      renderer drift, only what the gate itself would fail is re-based, asked of Playwright's
 *      own comparator with the gate's options (gate-comparator.ts). The gate is not pixel-exact,
 *      so a file whose pixels moved within its tolerance is left as it is and only counted; one
 *      the comparator cannot judge is re-based as though the gate failed it. On a HEAD never
 *      pushed as origin/main's tip the renderer alone may be recorded, but a twin is copied only
 *      under --allow-unpushed: nothing but diffVerdict would then vouch for it;
 *   4. --confirm only: the twins of the files the gate fails copied over their baselines (none:
 *      the record alone), the renderer recorded, and the gate run with the check on. Red after
 *      one re-run, an error, SIGINT, SIGTERM or SIGHUP puts every file back as HEAD has it.
 *      Green writes a ready commit message. It never commits.
 *
 * Before step 0, a --confirm that never heard its gate answer (SIGKILL, a session closed without a
 * signal, a restore that failed) is found by the mark it left in .git, and what it wrote is put
 * back as HEAD has it: left, its record would match the canary and read as "Nothing to do".
 *
 *     pnpm e2e:rebase-renderer                  # dry run: proves it, writes nothing
 *     pnpm e2e:rebase-renderer --confirm        # re-bases, records, verifies
 *     pnpm e2e:rebase-renderer --allow-unpushed # copy twins on a HEAD no gate passed
 *
 * A hidden `--only <spec> [-g <pattern>]` rehearses the dry run on part of the suite; --confirm
 * refuses it, because a partial control cannot license re-basing the rest.
 *
 * Exit 0: nothing to do, a dry run that found only renderer drift, or a verified re-base.
 * Exit 1: a refusal. Exit 2: a flag it does not know. 128 + n: --confirm stopped by signal n.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BASELINE_RENDERER_PATH,
  compareRecord,
  measureCurrentRenderer,
  oneLineRenderer,
  readRecord,
  writeRecord,
  type RendererRecord,
  type RendererVerdict,
} from "./e2e-renderer/fingerprint";
import {
  checkGuards,
  pushProof,
  pushState,
  type GuardLine,
  type PushState,
} from "./e2e-renderer/rebase-guards";
import {
  commitMessage,
  describeContent,
  describeLeft,
  describePlan,
  describeRebased,
  describeTally,
  pairBaselines,
  parseRebaseArgs,
  planRebase,
  tally,
  UsageError,
  USAGE,
  verdictTable,
  type PushProof,
  type RebaseArgs,
  type RebasePlan,
  type Tally,
} from "./e2e-renderer/rebase-plan";
import {
  bundleFromHead,
  clearPendingReBase,
  committedBaselines,
  git,
  markBundleBuilt,
  markPendingReBase,
  pendingMarkPath,
  readPendingReBase,
  restoreFromHead,
  settlePendingReBase,
  uncommittedUnder,
  type Settled,
} from "./e2e-renderer/rebase-repo";
import {
  buildBundle,
  gateComparator,
  judgeAll,
  runSuite,
  walkFiles,
  type SuiteContext,
} from "./e2e-renderer/rebase-run";
import { BASELINE_DIR, twinPath } from "./e2e-renderer/snapshot-root";
import {
  applyAndVerify,
  describeRed,
  onStopSignal,
  passedInTheEnd,
  putBack,
  runWithOneRerun,
  type Applied,
  type ApplyEffects,
  type Runs,
} from "./e2e-renderer/suite-run";

/* ── Output ────────────────────────────────────────────────────────────────────────────────── */

/** The house shape (quiet-box.ts, fingerprint.ts): a headline, continuation lines six in. */
function say(headline: string, body: readonly string[] = []): void {
  console.log([headline, ...body.map((line) => `      ${line}`)].join("\n"));
}

const NOTHING_WRITTEN = "Nothing in e2e/ was written.";

function refuse(headline: string, body: readonly string[], footer = NOTHING_WRITTEN): never {
  const all = [...body, ...(footer === "" ? [] : [footer])];
  console.error([`\nREFUSED — ${headline}`, ...all.map((line) => `      ${line}`)].join("\n"));
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

function guardLine({ mark, what, saw }: GuardLine): void {
  console.log(`  ${mark} ${what} — ${saw}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where e2e/ stands after a --confirm that did not keep what it wrote, read from git and the mark
 * rather than assumed: a restore that failed is exactly when an assumption would be wrong.
 */
function whereE2eStands(): string[] {
  try {
    return describeLeft(uncommittedUnder(BASELINE_DIR), readPendingReBase() !== null);
  } catch (error) {
    return [`e2e/ could not be read back (${messageOf(error)}): check it with git status`];
  }
}

function summarizeRuns(runs: Runs): string {
  const rerun = runs.attempts[1];
  const rescued = rerun === undefined ? "" : `, ${rerun.passed} of them on the re-run`;
  return `${passedInTheEnd(runs)} passed${rescued}`;
}

/* ── The phases ────────────────────────────────────────────────────────────────────────────── */

/**
 * First of all. A --confirm stopped where no handler hears it (SIGKILL, a session closed without a
 * signal), or whose restore failed, left its mark, and the twins and the record it wrote may still
 * be in e2e/. The record would match the canary and read as "Nothing to do", so what that run
 * wrote is put back as HEAD has it before anything is asked, in a dry run too: it is that run's
 * unfinished restore, not a re-base of this one.
 */
function settleInterrupted(): void {
  let settled: Settled;
  try {
    settled = settlePendingReBase();
  } catch (error) {
    refuse(
      "an earlier --confirm stopped before its gate answered, and what it wrote cannot be put back",
      [
        ...messageOf(error).split("\n"),
        ...describeLeft(uncommittedUnder(BASELINE_DIR), false),
        `Its mark stays (${pendingMarkPath()}), so the next run tries again first.`,
      ],
      "",
    );
  }
  if (settled.settled === "nothing-pending") return;
  const { pending } = settled;
  const run =
    `The --confirm started ${pending.startedOn} at ${pending.head.slice(0, 7)} wrote ` +
    `${pending.files.length} baseline(s) and the record`;
  if (settled.settled === "committed-since") {
    refuse(
      "an earlier --confirm never heard its gate pass, and a commit since changed what it wrote",
      [
        `${run}, then stopped. Changed by a commit since:`,
        ...settled.touched.map((file) => `  ${file}`),
        "Such a commit may carry what no gate passed, so nothing was put back. Once it is",
        `settled, remove ${pendingMarkPath()} and run this again.`,
      ],
      "",
    );
  }
  section("An earlier --confirm stopped before its gate answered");
  console.log(`  ${run}, then stopped: killed, or its restore failed.`);
  console.log("  ✓ all of it is back as HEAD has it");
}

interface Renderer {
  recorded: RendererRecord | null;
  current: RendererRecord;
  verdict: RendererVerdict;
}

/**
 * The canary comes before the guards on purpose. A match needs nothing checked or written, and a
 * second run straight after --confirm (whose re-base is not committed yet, and so not pushed)
 * must say "Nothing to do" rather than refuse the tree it just wrote.
 */
async function checkRenderer(): Promise<Renderer | null> {
  let recorded: RendererRecord | null;
  let current: RendererRecord;
  try {
    recorded = readRecord();
  } catch (error) {
    refuse("the renderer record cannot be read", [messageOf(error)]);
  }
  try {
    current = await measureCurrentRenderer();
  } catch (error) {
    refuse("the renderer canary could not be measured", [messageOf(error)]);
  }
  const verdict = compareRecord(recorded, current);
  if (verdict === "match") {
    const waiting = uncommittedUnder(BASELINE_DIR);
    const note = `${waiting.length} file(s) in e2e/ are uncommitted: a --confirm may be waiting.`;
    say(`\nNothing to do — this Mac draws the renderer canary exactly as the record says.`, [
      `${BASELINE_RENDERER_PATH}: ${oneLineRenderer(current)}`,
      ...(waiting.length === 0 ? [] : [note]),
    ]);
    return null;
  }
  section("Renderer");
  const none = `none — ${BASELINE_RENDERER_PATH} does not exist`;
  console.log(`  record     ${recorded === null ? none : oneLineRenderer(recorded)}`);
  console.log(`  this Mac   ${oneLineRenderer(current)}`);
  console.log(`  verdict    ${verdict}`);
  return { recorded, current, verdict };
}

/** The guards, then the scratch directory, then the one guard that may act: building .next. */
async function guardAndPrepare(args: RebaseArgs, push: PushState): Promise<string> {
  section("Guards");
  const results = await checkGuards(args, push);
  results.forEach(guardLine);
  const failed = results.filter((g) => g.mark === "✗").map((g) => g.what);
  if (failed.length > 0) refuse(`${failed.length} guard(s) failed`, failed);
  // made only once the guards pass, so a refused run leaves nothing behind in the temp dir
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebase-renderer-"));
  // E2E_ALLOW_STALE was said, loudly, by the guards above, and refused under --confirm
  if (process.env.E2E_ALLOW_STALE === "1") return scratch;
  const bundle = bundleFromHead();
  if (bundle.fromHead) {
    guardLine({ mark: "✓", what: ".next is built from HEAD", saw: bundle.saw });
    return scratch;
  }
  guardLine({ mark: "⚠", what: ".next is built from HEAD", saw: `${bundle.saw}; building it now` });
  const log = path.join(scratch, "next-build.log");
  section(`next build at HEAD (log: ${log})`);
  if ((await buildBundle(log)) !== 0) refuse("`next build` failed at HEAD", [`see ${log}`]);
  markBundleBuilt();
  const built = bundleFromHead();
  if (!built.fromHead) refuse("the build this command just made is not HEAD's", [built.saw]);
  guardLine({ mark: "✓", what: ".next is built from HEAD", saw: built.saw });
  return scratch;
}

/**
 * ⚠️ A re-run is a new `playwright test`, so global-setup seeds the database afresh: a `zz-` spec
 * re-run alone starts without what the specs before it did (Detect now, the renames). A flake
 * there can therefore come back as a second failure or a content verdict, never as a false pass.
 */
async function control(ctx: SuiteContext): Promise<Runs> {
  const runs = await runWithOneRerun((attempt) => runSuite("control", attempt, ctx, section));
  if (!runs.green) {
    refuse("HEAD is not green on this machine, or the box is loaded", [
      ...describeRed(runs),
      `The control's log: ${path.join(ctx.scratch, "control.log")}`,
    ]);
  }
  console.log(`  ✓ control: ${summarizeRuns(runs)}`);
  // The snapshots were redirected; if a file under e2e/ moved anyway, the redirect did not hold
  // and nothing below could be trusted. It never should: this is the proof, on every run.
  const touched = uncommittedUnder(BASELINE_DIR);
  if (touched.length > 0) {
    refuse(
      `the control changed ${touched.length} file(s) in e2e/, though its snapshots were redirected`,
      [
        ...touched.slice(0, 10),
        `git restore --source=HEAD --worktree -- ${BASELINE_DIR} puts the tracked ones back.`,
      ],
      "",
    );
  }
  return runs;
}

interface Classified {
  plan: RebasePlan;
  counts: Tally;
  total: number;
}

async function classify(
  ctx: SuiteContext,
  renderer: Renderer,
  partial: boolean,
  push: PushProof,
): Promise<Classified> {
  section(`Classification — the committed baselines against their twins in ${ctx.snapshotRoot}`);
  const committed = committedBaselines();
  const pairing = pairBaselines(committed, walkFiles(ctx.snapshotRoot), partial);
  if (pairing.missing.length > 0 || pairing.extra.length > 0) {
    refuse("the control did not draw exactly the committed baselines", [
      ...pairing.missing.map((b) => `missing  ${b}  (committed, but the suite drew no twin)`),
      ...pairing.extra.map((b) => `extra    ${b}  (drawn, but never committed)`),
      "A stale baseline, a skipped test or a new uncommitted one: the verdicts would not cover",
      "the set the gate checks. Settle it in a commit of its own, then run this again.",
    ]);
  }
  const gate = await gateComparator();
  if ("unavailable" in gate) {
    console.log(
      `  the gate's own comparator is unavailable (${gate.unavailable}): every renderer-only ` +
        "file is re-based as though the gate failed it",
    );
  }
  const progress = (done: number, of: number) => console.log(`  judged ${done} of ${of}`);
  const unjudged = (baseline: string, why: string) =>
    console.log(
      `  the gate's comparator could not judge ${baseline} (${why}): re-based as though it failed`,
    );
  const gateFails = "fails" in gate ? gate.fails : null;
  const judged = await judgeAll(pairing.pairs, ctx.snapshotRoot, gateFails, progress, unjudged);
  const counts = tally(judged);
  const table = path.join(ctx.scratch, "verdicts.tsv");
  fs.writeFileSync(table, verdictTable(judged));
  for (const line of describeTally(counts, pairing.notRun.length)) console.log(`  ${line}`);
  if (counts.toRebase.length > 0) console.log("  to re-base, most changed first:");
  for (const line of describeRebased(counts.toRebase)) console.log(`    ${line}`);
  console.log(`  every verdict: ${table}`);
  const plan = planRebase(renderer.verdict, pairing, counts, push);
  if (plan.action === "refuse-unpaired") {
    refuse("unpaired baselines", [...plan.missing, ...plan.extra]);
  }
  if (plan.action === "refuse-content") {
    refuse(`${plan.content.length} baseline(s) changed CONTENT, not only rendering`, [
      ...describeContent(plan.content),
      "Each committed baseline is in e2e/; the control's twin is at the same path under",
      `${ctx.snapshotRoot}. A UI change is committed with its baselines by the change`,
      "that made it, never by this command.",
    ]);
  }
  if (plan.action === "refuse-unpushed") {
    const n = plan.files.length;
    refuse(`HEAD was never pushed as origin/main's tip, and ${n} baseline(s) would be re-based`, [
      "No gate has passed HEAD, so nothing proves its committed baselines are its UI, and the",
      "control redrew every screenshot rather than comparing one: only diffVerdict says these",
      "files moved by the renderer alone. Re-base at origin/main's tip, which passed the gate,",
      "with any commits of HEAD's own on top; or pass --allow-unpushed to let diffVerdict's",
      "verdicts stand.",
    ]);
  }
  return { plan, counts, total: committed.length };
}

function dryRunSummary(
  args: RebaseArgs,
  found: Classified,
  renderer: Renderer,
  scratch: string,
): void {
  say(`\nDry run — nothing was written. With --confirm this would:`, [
    ...describePlan(found.plan, renderer.current),
    ...(args.only === null
      ? []
      : ["This rehearsal drew part of the suite (--only): it cannot license --confirm."]),
    `Scratch: ${scratch}`,
  ]);
}

/** 128 plus the signal's number, the exit a shell reports for a process the signal stopped. */
function signalExitCode(signal: NodeJS.Signals): number {
  const signals: Partial<Record<NodeJS.Signals, number>> = os.constants.signals;
  return 128 + (signals[signal] ?? 0);
}

/**
 * Only here is anything in e2e/ written. A red gate, an error or a signal part way through puts
 * every file back as HEAD has it, so what is left is either verified or untouched; and whatever
 * stopped it, the refusal ends on where e2e/ stands, even when the restore itself failed. What no
 * handler hears is covered by the mark (settleInterrupted).
 */
async function confirm(
  ctx: SuiteContext,
  found: Classified,
  renderer: Renderer,
  controlRuns: Runs,
  push: PushProof,
): Promise<void> {
  const { plan } = found;
  const fx: ApplyEffects = {
    markPending: (files) => markPendingReBase(files),
    copyTwin: (baseline) => fs.copyFileSync(twinPath(baseline, ctx.snapshotRoot), baseline),
    writeRecord: () => writeRecord(renderer.current),
    runGate: (attempt) => runSuite("gate", attempt, ctx, section),
    restore: restoreFromHead,
    clearPending: () => clearPendingReBase(),
  };
  const stopListening = onStopSignal((signal) => {
    const notRestored = putBack(plan.files, fx);
    const stopped = `${signal}: stopped before the gate answered`;
    const headline =
      notRestored === null
        ? `${stopped}; every file it wrote is back as HEAD has it.`
        : `${stopped}, and putting e2e/ back failed: ${notRestored}`;
    console.error([`\n${headline}`, ...whereE2eStands().map((l) => `      ${l}`)].join("\n"));
    process.exit(signalExitCode(signal));
  });
  section(`Writing ${plan.files.length} baseline(s) and the record`);
  let applied: Applied;
  try {
    applied = await applyAndVerify(plan.files, fx);
  } catch (error) {
    refuse(
      "the re-base stopped before its gate answered",
      [...messageOf(error).split("\n"), ...whereE2eStands()],
      "",
    );
  } finally {
    stopListening();
  }
  if (!applied.verified) {
    const restored = applied.notRestored === null;
    refuse(
      restored
        ? "the gate is red on the re-based baselines, so every file is back as HEAD has it"
        : "the gate is red on the re-based baselines, and putting them back failed",
      [
        ...describeRed(applied.gate),
        `The gate's log: ${path.join(ctx.scratch, "gate.log")}`,
        ...(restored ? [] : [`The restore: ${applied.notRestored}`]),
        ...whereE2eStands(),
      ],
      "",
    );
  }
  writeCommitMessage(ctx, found, renderer, controlRuns, applied.gate, push);
}

function writeCommitMessage(
  ctx: SuiteContext,
  found: Classified,
  renderer: Renderer,
  controlRuns: Runs,
  gateRuns: Runs,
  push: PushProof,
): void {
  const message = commitMessage({
    ...found,
    ...renderer,
    head: {
      sha: git(["rev-parse", "HEAD"]).trim(),
      subject: git(["log", "-1", "--format=%s"]).trim(),
    },
    pushed: push.pushed,
    control: { passed: passedInTheEnd(controlRuns), rerun: controlRuns.attempts.length > 1 },
    gate: { passed: passedInTheEnd(gateRuns), rerun: gateRuns.attempts.length > 1 },
  });
  const messageFile = path.join(ctx.scratch, "commit-message.txt");
  fs.writeFileSync(messageFile, message);
  const dirs = [...new Set(found.plan.files.map((file) => path.dirname(file)))].sort();
  say(`\n✓ ${message.split("\n")[0]}`, [
    `The gate passed with the renderer check on: ${summarizeRuns(gateRuns)}.`,
    "Nothing is committed. To commit exactly what this wrote:",
    `  git add -- ${[BASELINE_RENDERER_PATH, ...dirs].join(" ")}`,
    `  git commit -F ${messageFile}`,
  ]);
}

function parseArgsOrExit(): RebaseArgs {
  try {
    return parseRebaseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`e2e:rebase-renderer: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = parseArgsOrExit();
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  const rehearsal = args.only === null ? "" : " (a rehearsal: --only)";
  console.log(
    args.confirm
      ? "e2e:rebase-renderer — CONFIRM: re-bases the drift the gate fails, records, verifies"
      : `e2e:rebase-renderer — DRY RUN: nothing is written${rehearsal}`,
  );
  settleInterrupted();
  const renderer = await checkRenderer();
  if (renderer === null) return;
  const push = pushState();
  const scratch = await guardAndPrepare(args, push);
  const snapshotRoot = path.join(scratch, "snapshots");
  const ctx: SuiteContext = { scratch, snapshotRoot, only: args.only };
  const controlRuns = await control(ctx);
  const proof = pushProof(push, args.allowUnpushed);
  const found = await classify(ctx, renderer, args.only !== null, proof);
  if (args.confirm) await confirm(ctx, found, renderer, controlRuns, proof);
  else dryRunSummary(args, found, renderer, scratch);
}

await main();
