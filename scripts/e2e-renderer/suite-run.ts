/**
 * The two whole-suite runs `pnpm e2e:rebase-renderer` makes — the control before it writes and
 * the gate after — and what it does with their answers. The Playwright process itself is the
 * caller's; everything here takes it as a function, so the re-run rule and the restore on a red
 * gate are tested without a browser.
 */
import { z } from "zod";

export interface FailedTest {
  /** "visual.spec.ts › accounts › dark 1440", the way the list reporter prints it */
  title: string;
  project: string;
  /** the first line of the first error */
  error: string;
}

export interface SuiteOutcome {
  exitCode: number | null;
  passed: number;
  flaky: number;
  skipped: number;
  failed: FailedTest[];
  /** errors outside any test: global setup, the web server, a spec that failed to load */
  globalErrors: string[];
}

/* ── The JSON reporter's file ──────────────────────────────────────────────────────────────── */

const ErrorSchema = z.object({ message: z.string().optional(), value: z.string().optional() });
const ResultSchema = z.object({ errors: z.array(ErrorSchema).default([]) });
const TestSchema = z.object({
  projectName: z.string().default(""),
  status: z.enum(["expected", "unexpected", "flaky", "skipped"]),
  results: z.array(ResultSchema).default([]),
});
const SpecSchema = z.object({ title: z.string(), tests: z.array(TestSchema).default([]) });

interface Suite {
  title: string;
  specs: z.infer<typeof SpecSchema>[];
  suites: Suite[];
}
const SuiteSchema: z.ZodType<Suite> = z.lazy(() =>
  z.object({
    title: z.string(),
    specs: z.array(SpecSchema).default([]),
    suites: z.array(SuiteSchema).default([]),
  }),
);
const ReportSchema = z.object({
  suites: z.array(SuiteSchema).default([]),
  errors: z.array(ErrorSchema).default([]),
  stats: z.object({
    expected: z.number().int(),
    unexpected: z.number().int(),
    flaky: z.number().int(),
    skipped: z.number().int(),
  }),
});

function firstLine(error: z.infer<typeof ErrorSchema> | undefined): string {
  const text = error?.message ?? error?.value ?? "no error message";
  // the reporter colours its messages; a log line is read without a terminal
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  return plain.split("\n").find((line) => line.trim() !== "")?.trim() ?? "no error message";
}

function failedTests(suites: readonly Suite[], path: readonly string[]): FailedTest[] {
  return suites.flatMap((suite) => {
    const here = suite.title === "" ? path : [...path, suite.title];
    const own = suite.specs.flatMap((spec) =>
      spec.tests
        .filter((test) => test.status === "unexpected")
        .map((test) => ({
          title: [...here, spec.title].join(" › "),
          project: test.projectName,
          error: firstLine(test.results.at(-1)?.errors[0]),
        })),
    );
    return [...own, ...failedTests(suite.suites, here)];
  });
}

/**
 * Reads what the JSON reporter wrote. A missing or unreadable report is itself the answer: the
 * run died before it could say what happened, which is never green.
 */
export function outcomeFromReport(exitCode: number | null, report: unknown): SuiteOutcome {
  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) {
    const why = parsed.error.issues[0]?.message ?? "?";
    return {
      exitCode,
      passed: 0,
      flaky: 0,
      skipped: 0,
      failed: [],
      globalErrors: [
        report === null
          ? "Playwright wrote no JSON report: it stopped before any test could report"
          : `the JSON report is not one Playwright writes: ${why}`,
      ],
    };
  }
  const { stats, errors, suites } = parsed.data;
  return {
    exitCode,
    passed: stats.expected,
    flaky: stats.flaky,
    skipped: stats.skipped,
    failed: failedTests(suites, []),
    globalErrors: errors.map((e) => firstLine(e)),
  };
}

/**
 * Green means Playwright said so AND ran something AND nothing failed. A run that drew no test
 * at all (a filter that matched nothing, a setup that threw) has proved nothing either way.
 */
export function isGreen(outcome: SuiteOutcome): boolean {
  return (
    outcome.exitCode === 0 &&
    outcome.failed.length === 0 &&
    outcome.globalErrors.length === 0 &&
    outcome.passed > 0
  );
}

/* ── One re-run, never two ─────────────────────────────────────────────────────────────────── */

export interface Attempt {
  /** re-run only the tests that failed in the attempt before, with Playwright's --last-failed */
  lastFailed: boolean;
}

export interface Runs {
  green: boolean;
  attempts: SuiteOutcome[];
}

/**
 * A test that fails, then passes when run again alone, is a machine that was busy for a moment
 * rather than a regression, and the 2026-09-11 load flakes cost hours of re-running to learn it.
 * So a failure gets exactly one re-run of what failed. A run that failed outside any test — a
 * global setup that refused, a web server that never came up — is not re-run: Playwright's
 * --last-failed with nothing recorded as failed would run the whole suite again, and the cause
 * is still there.
 */
export async function runWithOneRerun(
  run: (attempt: Attempt) => Promise<SuiteOutcome>,
): Promise<Runs> {
  const first = await run({ lastFailed: false });
  if (isGreen(first)) return { green: true, attempts: [first] };
  if (first.globalErrors.length > 0 || first.failed.length === 0) {
    return { green: false, attempts: [first] };
  }
  const second = await run({ lastFailed: true });
  return { green: isGreen(second), attempts: [first, second] };
}

/** How many passed in the end: the first run's passes plus whatever the re-run rescued. */
export function passedInTheEnd(runs: Runs): number {
  const [first, second] = runs.attempts;
  if (first === undefined) return 0;
  return second === undefined ? first.passed : first.passed + second.passed;
}

const LISTED_FAILURES = 25;

/** What went wrong in the last attempt, one test or error a line. */
export function describeRed(runs: Runs): string[] {
  const last = runs.attempts.at(-1);
  if (last === undefined) return ["the suite never ran"];
  const lines: string[] = [];
  if (runs.attempts.length > 1) {
    const first = runs.attempts[0]!;
    lines.push(
      `${first.failed.length} failed; the one re-run of those still failed ${last.failed.length}:`,
    );
  } else if (last.failed.length > 0) lines.push(`${last.failed.length} failed:`);
  for (const t of last.failed.slice(0, LISTED_FAILURES)) {
    lines.push(`  ✗ [${t.project}] ${t.title}`, `      ${t.error}`);
  }
  if (last.failed.length > LISTED_FAILURES) {
    lines.push(`  … and ${last.failed.length - LISTED_FAILURES} more`);
  }
  for (const e of last.globalErrors) lines.push(`  ✗ ${e}`);
  if (last.failed.length === 0 && last.globalErrors.length === 0) {
    lines.push(
      last.passed === 0
        ? `  ✗ no test ran (exit ${last.exitCode ?? "signal"})`
        : `  ✗ Playwright exited ${last.exitCode ?? "on a signal"} with no failed test to name`,
    );
  }
  return lines;
}

/* ── Write, verify, or put everything back ─────────────────────────────────────────────────── */

export interface ApplyEffects {
  /** copies one baseline's twin over it */
  copyTwin(baseline: string): void;
  writeRecord(): void;
  /** the gate with the renderer check on */
  runGate(attempt: Attempt): Promise<SuiteOutcome>;
  /** returns every given baseline, and the record, to what HEAD holds */
  restore(baselines: readonly string[]): void;
}

export interface Applied {
  verified: boolean;
  gate: Runs;
}

/**
 * A re-base is only kept once the gate it was made for passes on it. Anything else — a red gate
 * after its one re-run, or an error part way through the copying — puts every file back as HEAD
 * has it, so what is left is either verified or untouched, never half of each. The restore
 * covers the whole list rather than only what was copied: the tree was clean when the run
 * started, so restoring an uncopied file is a no-op.
 */
export async function applyAndVerify(files: readonly string[], fx: ApplyEffects): Promise<Applied> {
  let gate: Runs;
  try {
    for (const file of files) fx.copyTwin(file);
    fx.writeRecord();
    gate = await runWithOneRerun((attempt) => fx.runGate(attempt));
  } catch (error) {
    fx.restore(files);
    throw error;
  }
  if (!gate.green) fx.restore(files);
  return { verified: gate.green, gate };
}
