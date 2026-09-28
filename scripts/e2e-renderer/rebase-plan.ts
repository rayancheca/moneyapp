/**
 * The decisions behind `pnpm e2e:rebase-renderer`, apart from the git, browser and file work so
 * each can be tested alone: what the flags mean, which baseline pairs with which twin, what the
 * verdicts add up to, and the words the command refuses or commits with.
 *
 * The rule it enforces is the one the 2026-09-28 session followed by hand: a baseline is only
 * re-based when EVERY committed baseline was drawn again at a green HEAD and each one came back
 * identical or renderer drift. One changed glyph, one missing file, one extra file, and nothing
 * is written.
 */
import type { DiffVerdict } from "./diff-verdict";
import {
  macosLabel,
  oneLineRenderer,
  type RendererRecord,
  type RendererVerdict,
} from "./fingerprint";
import { baselineForTwin, baselineKey, twinKey } from "./snapshot-root";

/* ── Arguments ─────────────────────────────────────────────────────────────────────────────── */

export interface RebaseArgs {
  confirm: boolean;
  allowUnpushed: boolean;
  /** A rehearsal on part of the suite. Hidden: a partial run can prove nothing about the rest. */
  only: { spec: string; grep: string | null } | null;
}

export const USAGE = [
  "usage: pnpm e2e:rebase-renderer [--confirm] [--allow-unpushed]",
  "  (no flag)          dry run: prove the drift is the renderer, write nothing",
  "  --confirm          re-base the renderer-only baselines, record the renderer, re-run the gate",
  "  --allow-unpushed   accept a HEAD that is not on origin/main, and say so",
].join("\n");

export class UsageError extends Error {}

/** `--only <spec>` / `--only=<spec>` and `-g <pattern>` take a value; the rest are switches. */
export function parseRebaseArgs(argv: readonly string[]): RebaseArgs {
  let confirm = false;
  let allowUnpushed = false;
  let spec: string | null = null;
  let grep: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm passes a separating `--` through to the script on some versions
    if (arg === "--") continue;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const takeValue = (): string => {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError(`${flag} needs a value`);
      }
      return value;
    };
    if (flag === "--confirm") confirm = true;
    else if (flag === "--allow-unpushed") allowUnpushed = true;
    else if (flag === "--only") {
      if (spec !== null) throw new UsageError("--only was given twice");
      spec = takeValue();
    } else if (flag === "-g" || flag === "--grep") {
      if (grep !== null) throw new UsageError(`${flag} was given twice`);
      grep = takeValue();
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (grep !== null && spec === null) {
    throw new UsageError("-g narrows a rehearsal, so it needs --only <spec>");
  }
  if (confirm && spec !== null) {
    throw new UsageError(
      "--only rehearses a dry run on part of the suite; --confirm re-bases on the whole " +
        "suite and verifies it with the whole gate, so the two cannot be combined",
    );
  }
  return { confirm, allowUnpushed, only: spec === null ? null : { spec, grep } };
}

/* ── Pairing ───────────────────────────────────────────────────────────────────────────────── */

export interface Pairing {
  /** each committed baseline with its twin, the twin as a path relative to the scratch root */
  pairs: { baseline: string; twin: string }[];
  /** committed baselines the control drew no twin for */
  missing: string[];
  /** twins with no committed baseline, named as the baseline they would be */
  extra: string[];
  /** a rehearsal's committed baselines outside the part of the suite it ran: not judged */
  notRun: string[];
}

/**
 * A missing twin is a baseline the suite no longer draws (a stale file, a skipped test) and an
 * extra one is a screenshot nobody committed: either way the control did not draw the set the
 * gate checks, so the verdicts would not cover it. A rehearsal ran only part of the suite, so
 * there a missing twin only means "not in this part".
 */
export function pairBaselines(
  committed: readonly string[],
  twins: readonly string[],
  partial: boolean,
): Pairing {
  const byKey = new Map(twins.map((twin) => [twinKey(twin), twin]));
  const pairs: Pairing["pairs"] = [];
  const unpaired: string[] = [];
  for (const baseline of [...committed].sort()) {
    const key = baselineKey(baseline);
    const twin = byKey.get(key);
    if (twin === undefined) unpaired.push(baseline);
    else {
      pairs.push({ baseline, twin });
      byKey.delete(key);
    }
  }
  const extra = [...byKey.values()].map(baselineForTwin).sort();
  return {
    pairs,
    missing: partial ? [] : unpaired,
    extra,
    notRun: partial ? unpaired : [],
  };
}

/* ── Verdicts ──────────────────────────────────────────────────────────────────────────────── */

export interface Judged {
  baseline: string;
  verdict: DiffVerdict;
  /** what the gate's own comparator says of the pair; absent when it could not be asked */
  gate?: "fails" | "passes";
}

export interface InkMargin {
  baseline: string;
  scale: string;
  value: number;
  limit: number;
}

export interface Tally {
  identical: Judged[];
  rendererOnly: Judged[];
  content: Judged[];
  /** over the renderer-only pairs; null when there are none */
  medianChangedFraction: number | null;
  worst: Judged | null;
  /** the renderer-only pair that came nearest an ink limit */
  closest: InkMargin | null;
  /** how many renderer-only pairs the gate itself fails; null when any went unasked */
  gateFails: number | null;
}

/** "ink-fine 0.0982 <= 0.18 at (12,40)" — the line diffVerdict writes for every ink scale. */
const INK_LINE = /^(ink-[a-z]+) (\d+(?:\.\d+)?) (?:<=|>) (\d+(?:\.\d+)?) /;

/** Every ink scale a verdict measured, read back from its reasons as the calibration does. */
export function inkMargins(judged: Judged): InkMargin[] {
  return judged.verdict.reasons.flatMap((reason) => {
    const hit = INK_LINE.exec(reason);
    if (hit === null) return [];
    const [, scale, value, limit] = hit;
    return [{ baseline: judged.baseline, scale: scale!, value: +value!, limit: +limit! }];
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function tally(judged: readonly Judged[]): Tally {
  const of = (v: DiffVerdict["verdict"]) => judged.filter((j) => j.verdict.verdict === v);
  const rendererOnly = of("renderer-only");
  const fraction = (j: Judged) => j.verdict.metrics.changedFraction;
  const worst = rendererOnly.reduce<Judged | null>(
    (best, j) => (best === null || fraction(j) > fraction(best) ? j : best),
    null,
  );
  const closest = rendererOnly
    .flatMap(inkMargins)
    .reduce<InkMargin | null>(
      (best, m) => (best === null || m.value / m.limit > best.value / best.limit ? m : best),
      null,
    );
  const asked = rendererOnly.every((j) => j.gate !== undefined);
  return {
    identical: of("identical"),
    rendererOnly,
    content: of("content"),
    medianChangedFraction: median(rendererOnly.map(fraction)),
    worst,
    closest,
    gateFails: asked ? rendererOnly.filter((j) => j.gate === "fails").length : null,
  };
}

/* ── What the command does ─────────────────────────────────────────────────────────────────── */

export type Plan =
  | { action: "refuse-unpaired"; missing: string[]; extra: string[] }
  | { action: "refuse-content"; content: Judged[] }
  /** copy these twins over their baselines (none: write the record only), then verify */
  | { action: "rebase"; files: string[]; bootstrap: boolean };

export function planRebase(verdict: RendererVerdict, pairing: Pairing, counts: Tally): Plan {
  if (pairing.missing.length > 0 || pairing.extra.length > 0) {
    return { action: "refuse-unpaired", missing: pairing.missing, extra: pairing.extra };
  }
  if (counts.content.length > 0) return { action: "refuse-content", content: counts.content };
  const files = counts.rendererOnly.map((j) => j.baseline);
  return { action: "rebase", files, bootstrap: verdict === "unrecorded" && files.length === 0 };
}

/* ── Words ─────────────────────────────────────────────────────────────────────────────────── */

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function marginLine(m: InkMargin): string {
  const under = (m.limit / m.value).toFixed(2);
  return `${m.scale} ${m.value.toFixed(4)} of ${m.limit} (${under}x under)`;
}

export function describeTally(counts: Tally, notRun: number): string[] {
  const lines = [
    `identical      ${counts.identical.length}`,
    `renderer-only  ${counts.rendererOnly.length}`,
    `content        ${counts.content.length}`,
  ];
  if (counts.worst !== null && counts.medianChangedFraction !== null) {
    lines.push(
      `changed pixels of the renderer-only: median ${percent(counts.medianChangedFraction)}, ` +
        `worst ${percent(counts.worst.verdict.metrics.changedFraction)} (${counts.worst.baseline})`,
    );
  }
  if (counts.closest !== null) {
    lines.push(`closest to a limit: ${marginLine(counts.closest)} in ${counts.closest.baseline}`);
  }
  const gate = gateSentence(counts);
  if (gate !== null) lines.push(gate);
  if (notRun > 0) {
    lines.push(`${plural(notRun, "committed baseline")} outside this rehearsal, not judged`);
  }
  return lines;
}

/**
 * The gate is not pixel-exact (see gate-comparator.ts), so a renderer-only file may be one it
 * already passes. Said, so that a re-base touching more files than the gate failed is explained.
 */
export function gateSentence(counts: Tally): string | null {
  const n = counts.rendererOnly.length;
  if (n === 0 || counts.gateFails === null) return null;
  const tolerated = n - counts.gateFails;
  if (tolerated === 0) {
    return n === 1
      ? "the gate itself fails the one renderer-only file"
      : `the gate itself fails all ${n} renderer-only files`;
  }
  return (
    `the gate itself fails ${counts.gateFails} of the ${n} renderer-only files; it passes the ` +
    `other ${tolerated} under Playwright's colour threshold, and they are re-based too, so ` +
    "every baseline is exactly what the recorded renderer draws"
  );
}

const LISTED_FILES = 30;

/** The files a re-base would move, most changed first, so a reader sees which pages drifted. */
export function describeRebased(rendererOnly: readonly Judged[]): string[] {
  const fraction = (j: Judged) => j.verdict.metrics.changedFraction;
  const sorted = [...rendererOnly].sort((a, b) => fraction(b) - fraction(a));
  const lines = sorted
    .slice(0, LISTED_FILES)
    .map((j) => `${percent(fraction(j)).padStart(6)}  ${j.baseline}`);
  if (sorted.length > LISTED_FILES) lines.push(`… and ${sorted.length - LISTED_FILES} more`);
  return lines;
}

/**
 * Every verdict, one tab-separated row a file, for the scratch directory: the full record behind
 * the counts, readable by a person or a spreadsheet without re-running an eight-minute suite.
 */
export function verdictTable(judged: readonly Judged[]): string {
  const header = [
    "baseline",
    "verdict",
    "deciding",
    "changed_px",
    "changed_fraction",
    "max_delta",
    "ink_fine",
    "ink_coarse",
  ];
  const rows = judged.map((j) => {
    const m = j.verdict.metrics;
    const ink = new Map(inkMargins(j).map((margin) => [margin.scale, margin.value]));
    return [
      j.baseline,
      j.verdict.verdict,
      m.decidingMeasure,
      m.changedPixels,
      m.changedFraction.toFixed(6),
      m.maxDelta,
      ink.get("ink-fine") ?? "",
      ink.get("ink-coarse") ?? "",
    ].join("\t");
  });
  return `${[header.join("\t"), ...rows].join("\n")}\n`;
}

/** One entry per content verdict: which measure decided, and where on the page. */
export function describeContent(content: readonly Judged[]): string[] {
  return content.flatMap(({ baseline, verdict }) => {
    const m = verdict.metrics;
    const at = m.bbox === null ? "" : ` in ${m.bbox.w}x${m.bbox.h} at (${m.bbox.x},${m.bbox.y})`;
    return [
      baseline,
      `  ${verdict.reasons[0] ?? m.decidingMeasure}`,
      `  ${m.changedPixels.toLocaleString("en-US")} px changed (${percent(m.changedFraction)}), ` +
        `max delta ${m.maxDelta}${at}`,
    ];
  });
}

export interface CommitFacts {
  plan: Extract<Plan, { action: "rebase" }>;
  counts: Tally;
  total: number;
  verdict: RendererVerdict;
  recorded: RendererRecord | null;
  current: RendererRecord;
  head: { sha: string; subject: string };
  control: { passed: number; rerun: boolean };
  gate: { passed: number; rerun: boolean };
}

function whatMoved(facts: CommitFacts): string {
  const { recorded, current, verdict } = facts;
  if (recorded === null) {
    return (
      "No renderer had been recorded (e2e/baseline-renderer.json did not exist), so every " +
      "gate run stopped with NO RENDERER RECORD before seeding."
    );
  }
  const moved = (label: string, a: string, b: string) => (a === b ? [] : [`${label} ${a} -> ${b}`]);
  const versions = [
    ...moved("macOS", macosLabel(recorded.macos), macosLabel(current.macos)),
    ...moved("chromium", `r${recorded.chromiumRevision}`, `r${current.chromiumRevision}`),
    ...moved("playwright", recorded.playwright, current.playwright),
  ];
  const which = versions.length === 0 ? "no recorded version moved" : versions.join(", ");
  const sha = (record: RendererRecord) => record.canary.pixelSha256.slice(0, 12);
  const canary = `${sha(recorded)} -> ${sha(current)}`;
  const on = recorded.recordedOn.slice(0, 10);
  if (verdict === "canary-changed") {
    return (
      `The renderer canary's own source changed since ${on} ` +
      `(${which}), so its recorded pixels could no longer be compared (canary ${canary}).`
    );
  }
  return (
    `This Mac stopped drawing the renderer canary recorded on ${on}: ` +
    `${which}; canary ${canary}.`
  );
}

/** Ready for `git commit -F`: a subject in the house form, and the numbers that prove it. */
export function commitMessage(facts: CommitFacts): string {
  const { plan, counts, total, current, head, control, gate } = facts;
  const n = plan.files.length;
  const mac = macosLabel(current.macos);
  const subject =
    n === 0
      ? `chore(e2e): record macOS ${mac} as the baselines' renderer — no baseline changed`
      : `chore(e2e): re-base ${plural(n, "baseline")} on macOS ${mac} — no UI changed`;
  const reran = (run: { rerun: boolean }) =>
    run.rerun ? ", after one re-run of what failed first" : "";
  const body = [
    whatMoved(facts),
    "",
    "`pnpm e2e:rebase-renderer --confirm` proved it before writing anything. The whole suite ran " +
      `at ${head.sha.slice(0, 7)} ("${head.subject}") with the renderer check skipped and every ` +
      `screenshot drawn into a scratch root: ${control.passed} passed${reran(control)}. Each of ` +
      `the ${total} committed baselines was then judged against its twin by ` +
      `scripts/e2e-renderer/diff-verdict.ts: ${counts.rendererOnly.length} renderer-only, ` +
      `${counts.identical.length} identical, none content, none missing or extra.`,
  ];
  if (counts.worst !== null && counts.medianChangedFraction !== null && counts.closest !== null) {
    const gateSaid = gateSentence(counts)?.replace(/^the gate itself/, "the gate");
    body.push(
      "",
      `Changed pixels: median ${percent(counts.medianChangedFraction)}, worst ` +
        `${percent(counts.worst.verdict.metrics.changedFraction)} (${counts.worst.baseline}). ` +
        `Closest to a limit: ${marginLine(counts.closest)} in ${counts.closest.baseline}.` +
        (gateSaid === undefined ? "" : ` By its own comparator ${gateSaid}.`),
    );
  }
  body.push(
    "",
    `Gate after, with the renderer check on (E2E_GATE=1): ${gate.passed} passed${reran(gate)}.`,
    `Recorded in e2e/baseline-renderer.json: ${oneLineRenderer(current)}.`,
  );
  return [subject, "", ...wrap(body, 92), ""].join("\n");
}

/** Wraps each paragraph line at `width` columns, leaving blank lines where they are. */
function wrap(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => {
    if (line.length <= width) return [line];
    const out: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      if (current !== "" && current.length + 1 + word.length > width) {
        out.push(current);
        current = word;
      } else current = current === "" ? word : `${current} ${word}`;
    }
    if (current !== "") out.push(current);
    return out;
  });
}
