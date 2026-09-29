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
 *   1. guards: a clean tree, HEAD on origin/main (pushed = the last green gate), port 3111
 *      free, a quiet box, and .next built from HEAD (built here when it is not);
 *   2. a control run of the whole suite at HEAD, renderer check skipped, every screenshot drawn
 *      into a scratch root rather than e2e/ (E2E_SNAPSHOT_ROOT); a failure gets one re-run of
 *      what failed, and a second failure is a refusal: HEAD is not green here, or the box is busy;
 *   3. every committed baseline judged against its twin by scripts/e2e-renderer/diff-verdict.ts:
 *      a missing or extra twin, or one "content" verdict, and nothing is written. Of the
 *      renderer drift, only what the gate itself would fail is re-based, asked of Playwright's
 *      own comparator with the gate's options (gate-comparator.ts). The gate is not pixel-exact,
 *      so a file whose pixels moved within its tolerance is left as it is and only counted; one
 *      the comparator cannot judge is re-based as though the gate failed it;
 *   4. --confirm only: the twins of the files the gate fails copied over their baselines (none:
 *      the record alone), the renderer recorded, and the gate run with the check on. Red after
 *      one re-run puts every file back as HEAD has it. Green writes a ready commit message. It
 *      never commits.
 *
 *     pnpm e2e:rebase-renderer                  # dry run: proves it, writes nothing
 *     pnpm e2e:rebase-renderer --confirm        # re-bases, records, verifies
 *     pnpm e2e:rebase-renderer --allow-unpushed # a HEAD not on origin/main, said loudly
 *
 * A hidden `--only <spec> [-g <pattern>]` rehearses the dry run on part of the suite; --confirm
 * refuses it, because a partial control cannot license re-basing the rest.
 *
 * Exit 0: nothing to do, a dry run that found only renderer drift, or a verified re-base.
 * Exit 1: a refusal. Exit 2: a flag it does not know.
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
import { checkGuards, type GuardLine } from "./e2e-renderer/rebase-guards";
import {
  commitMessage,
  describeContent,
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
  type RebaseArgs,
  type RebasePlan,
  type Tally,
} from "./e2e-renderer/rebase-plan";
import {
  bundleFromHead,
  committedBaselines,
  git,
  markBundleBuilt,
  restoreFromHead,
  uncommittedUnder,
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
  passedInTheEnd,
  runWithOneRerun,
  type Applied,
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

function summarizeRuns(runs: Runs): string {
  const rerun = runs.attempts[1];
  const rescued = rerun === undefined ? "" : `, ${rerun.passed} of them on the re-run`;
  return `${passedInTheEnd(runs)} passed${rescued}`;
}

/* ── The phases ────────────────────────────────────────────────────────────────────────────── */

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
async function guardAndPrepare(args: RebaseArgs): Promise<string> {
  section("Guards");
  const results = await checkGuards(args);
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
  const plan = planRebase(renderer.verdict, pairing, counts);
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

/**
 * Only here is anything in e2e/ written. A red gate, an error or a signal part way through puts
 * every file back as HEAD has it, so what is left is either verified or untouched.
 */
async function confirm(
  ctx: SuiteContext,
  found: Classified,
  renderer: Renderer,
  controlRuns: Runs,
): Promise<void> {
  const { plan } = found;
  const onSignal = (signal: NodeJS.Signals) => {
    restoreFromHead(plan.files);
    console.error(`\n${signal}: every file in e2e/ is back as HEAD has it.`);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  section(`Writing ${plan.files.length} baseline(s) and the record`);
  let applied: Applied;
  try {
    applied = await applyAndVerify(plan.files, {
      copyTwin: (baseline) => fs.copyFileSync(twinPath(baseline, ctx.snapshotRoot), baseline),
      writeRecord: () => writeRecord(renderer.current),
      runGate: (attempt) => runSuite("gate", attempt, ctx, section),
      restore: restoreFromHead,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (!applied.verified) {
    const left = uncommittedUnder(BASELINE_DIR);
    refuse(
      "the gate is red on the re-based baselines, so every file is back as HEAD has it",
      [...describeRed(applied.gate), `The gate's log: ${path.join(ctx.scratch, "gate.log")}`],
      left.length === 0 ? "e2e/ matches HEAD again." : `NOT AS HEAD HAS IT: ${left.join("; ")}`,
    );
  }
  writeCommitMessage(ctx, found, renderer, controlRuns, applied.gate);
}

function writeCommitMessage(
  ctx: SuiteContext,
  found: Classified,
  renderer: Renderer,
  controlRuns: Runs,
  gateRuns: Runs,
): void {
  const message = commitMessage({
    ...found,
    ...renderer,
    head: {
      sha: git(["rev-parse", "HEAD"]).trim(),
      subject: git(["log", "-1", "--format=%s"]).trim(),
    },
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
  const renderer = await checkRenderer();
  if (renderer === null) return;
  const scratch = await guardAndPrepare(args);
  const snapshotRoot = path.join(scratch, "snapshots");
  const ctx: SuiteContext = { scratch, snapshotRoot, only: args.only };
  const controlRuns = await control(ctx);
  const found = await classify(ctx, renderer, args.only !== null);
  if (args.confirm) await confirm(ctx, found, renderer, controlRuns);
  else dryRunSummary(args, found, renderer, scratch);
}

await main();
