/**
 * The decisions behind `pnpm e2e:rebase-renderer`, apart from the git, browser and file work so
 * each can be tested alone: what the flags mean, which baseline pairs with which twin, what the
 * verdicts add up to, and the words the command refuses or commits with.
 *
 * The rule it enforces is the one the 2026-09-28 session followed by hand: nothing is re-based
 * unless EVERY committed baseline was drawn again at a green HEAD and each one came back
 * identical or renderer drift. One changed glyph, one missing file, one extra file, and nothing
 * is written. Then only the drift the gate itself fails is re-based (withinGateTolerance): a
 * file whose pixels moved within the gate's tolerance is counted and left as it is. And while
 * the Geist files the app ships differ from the record, no drift is re-based at all: a font
 * change is the app's own, and its baselines are redrawn by the change that made it.
 */
import type { DiffVerdict } from "./diff-verdict";
import {
  BASELINE_RENDERER_PATH,
  macosLabel,
  oneLineRenderer,
  versionMoves,
  versionWindow,
  type RendererRecord,
  type RendererVerdict,
} from "./fingerprint";
import type { GateAnswer } from "./gate-comparator";
import { baselineForTwin, baselineKey, twinKey } from "./snapshot-root";
import type { RerunScope } from "./suite-run";

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
  "  --confirm          re-base the drift the gate fails, record the renderer, re-run the gate",
  "  --allow-unpushed   on a HEAD no gate passed, copy twins on diffVerdict's word alone",
].join("\n");

export class UsageError extends Error {}

/**
 * `--only <spec>` / `--only=<spec>` and `-g <pattern>` take a value; the rest are switches, which
 * refuse one. A switch is on by being there, so `--confirm=false` read as on would write the
 * baselines of someone who spelled out a dry run, and `--allow-unpushed=false` would waive the
 * guard for someone who spelled out keeping it.
 */
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
    const switchedOn = (): true => {
      if (eq !== -1) {
        throw new UsageError(
          `${flag} is a switch: it takes no value (${arg}); leave it out for off`,
        );
      }
      return true;
    };
    if (flag === "--confirm") confirm = switchedOn();
    else if (flag === "--allow-unpushed") allowUnpushed = switchedOn();
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
  /**
   * What the gate's own comparator says of a renderer-only pair ("unknown" when it could not be
   * asked). Absent on the verdicts it is not asked about: identical, and content, which refuses
   * whatever the gate would say.
   */
  gate?: GateAnswer;
}

/**
 * THE RE-BASE RULE for renderer drift: a renderer-only file is re-based when the gate itself
 * would fail it, and left as it is when the gate passes it, its pixels having moved within the
 * tolerance the gate has always had (see gate-comparator.ts). One the comparator could not judge,
 * or was never asked about, is re-based as though the gate failed it; never the reverse. Leaving
 * a file the gate does fail would turn the verifying gate red and undo the whole re-base, while
 * copying one it passes only redraws renderer drift with the renderer the record names.
 */
export function withinGateTolerance(judged: Judged): boolean {
  return judged.verdict.verdict === "renderer-only" && judged.gate === "passes";
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
  /** the renderer-only files a re-base copies: the gate fails them, or could not judge them */
  toRebase: Judged[];
  /** the renderer-only files the gate passes: moved within its tolerance, left as they are */
  tolerated: Judged[];
  /** over all the renderer-only pairs; null when there are none */
  medianChangedFraction: number | null;
  worst: Judged | null;
  /** the renderer-only pair that came nearest an ink limit */
  closest: InkMargin | null;
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
  return {
    identical: of("identical"),
    rendererOnly,
    content: of("content"),
    toRebase: rendererOnly.filter((j) => !withinGateTolerance(j)),
    tolerated: rendererOnly.filter(withinGateTolerance),
    medianChangedFraction: median(rendererOnly.map(fraction)),
    worst,
    closest,
  };
}

/* ── What the command does ─────────────────────────────────────────────────────────────────── */

export type Plan =
  | { action: "refuse-unpaired"; missing: string[]; extra: string[] }
  | { action: "refuse-content"; content: Judged[] }
  /**
   * The Geist files the app ships are not the recorded ones, so these files may have moved by the
   * font, which is a UI change: their baselines belong to the commit that changed it
   */
  | { action: "refuse-fonts"; files: string[] }
  /** HEAD was never pushed as origin/main's tip, so only --allow-unpushed may copy these twins */
  | { action: "refuse-unpushed"; files: string[] }
  /**
   * copy the twins of `files` over their baselines (none: write the record only), then verify;
   * `tolerated` moved within the gate's tolerance and are left as they are
   */
  | { action: "rebase"; files: string[]; tolerated: string[]; bootstrap: boolean };

export type RebasePlan = Extract<Plan, { action: "rebase" }>;

/** What vouches for HEAD's committed baselines being its UI, before any verdict is read. */
export interface PushProof {
  /**
   * HEAD was origin/main's tip, so it passed the gate. Being on origin/main is not enough: a push
   * carries every commit since the last, and only its tip was gated (pushProof).
   */
  pushed: boolean;
  /** --allow-unpushed: let diffVerdict's verdicts stand alone for a HEAD no gate passed */
  allowUnpushed: boolean;
}

/**
 * Every verdict counts before any file is chosen: a missing or extra twin, or one content
 * verdict, refuses the lot, whatever the gate would say of it. Only then does the gate's answer
 * pick which renderer-only files are re-based.
 *
 * When the fonts the app ships changed since the record (`verdict` "fonts-changed", a Geist
 * upgrade), no twin is copied at all, whatever vouched for HEAD: every baseline with text moved
 * by the font, which is the app's change, and diffVerdict can take a font's small outline changes
 * for a renderer's. Those baselines are redrawn by the commit that changed the font. The record
 * alone may still be written, once the gate's comparator passes every baseline drawn with them.
 *
 * A HEAD never pushed as origin/main's tip passed no gate (one on origin/main that a push carried
 * past is no exception), so nothing proves its committed baselines are its UI, and the control,
 * which redraws every screenshot, proves none. The renderer alone may still be recorded: when the
 * gate's own comparator passes every baseline the control drew, that is HEAD passing the gate
 * here. Copying a twin rests on diffVerdict alone, so it needs --allow-unpushed.
 */
export function planRebase(
  verdict: RendererVerdict,
  pairing: Pairing,
  counts: Tally,
  push: PushProof,
): Plan {
  if (pairing.missing.length > 0 || pairing.extra.length > 0) {
    return { action: "refuse-unpaired", missing: pairing.missing, extra: pairing.extra };
  }
  if (counts.content.length > 0) return { action: "refuse-content", content: counts.content };
  const files = counts.toRebase.map((j) => j.baseline);
  if (verdict === "fonts-changed" && files.length > 0) return { action: "refuse-fonts", files };
  if (!push.pushed && !push.allowUnpushed && files.length > 0) {
    return { action: "refuse-unpushed", files };
  }
  return {
    action: "rebase",
    files,
    tolerated: counts.tolerated.map((j) => j.baseline),
    bootstrap: verdict === "unrecorded" && files.length === 0,
  };
}

/* ── Words ─────────────────────────────────────────────────────────────────────────────────── */

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** A count the way the house writes one: 1,234. */
const num = (n: number) => n.toLocaleString("en-US");

function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** "is" or "are", "it" or "them", "it is" or "they are": the words that agree with a count. */
const isAre = (n: number) => (n === 1 ? "is" : "are");
const itThem = (n: number) => (n === 1 ? "it" : "them");
const asTheyAre = (n: number) => (n === 1 ? "as it is" : "as they are");

function marginLine(m: InkMargin): string {
  const under = (m.limit / m.value).toFixed(2);
  return `${m.scale} ${m.value.toFixed(4)} of ${m.limit} (${under}x under)`;
}

/** How the gate's own comparator split the renderer-only files. */
function gateSplit(counts: Tally): { failing: number; unknown: number; tolerated: number } {
  const failing = counts.toRebase.filter((j) => j.gate === "fails").length;
  return { failing, unknown: counts.toRebase.length - failing, tolerated: counts.tolerated.length };
}

/** A file the gate passes is counted in the report, never listed: this is its line. */
export function toleratedLine(n: number): string {
  return `${num(n)} moved within the gate's tolerance, left ${asTheyAre(n)}`;
}

/**
 * The renderer-only files by the gate's own answer, a line a kind that has any: the ones it
 * fails and the ones it could not judge are re-based, the ones it passes are left as they are.
 * The gate is not pixel-exact (see gate-comparator.ts), so on a quiet update that last kind can
 * be every renderer-only file there is.
 */
export function gateLines(counts: Tally): string[] {
  const { failing, unknown, tolerated } = gateSplit(counts);
  const couldNot =
    `${num(unknown)} the gate's comparator could not judge: re-based as though the gate ` +
    `failed ${itThem(unknown)}`;
  return [
    ...(failing === 0 ? [] : [`${plural(failing, "fails", "fail")} the gate itself: re-based`]),
    ...(unknown === 0 ? [] : [couldNot]),
    ...(tolerated === 0 ? [] : [toleratedLine(tolerated)]),
  ];
}

export function describeTally(counts: Tally, notRun: number): string[] {
  const lines = [
    `identical      ${counts.identical.length}`,
    `renderer-only  ${counts.rendererOnly.length}`,
    ...gateLines(counts).map((line) => `  ${line}`),
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
  if (notRun > 0) {
    lines.push(`${plural(notRun, "committed baseline")} outside this rehearsal, not judged`);
  }
  return lines;
}

/** What --confirm does, for the dry run to say: copies, leaves, records, then verifies. */
export function describePlan(plan: RebasePlan, current: RendererRecord): string[] {
  const n = plan.files.length;
  const left = plan.tolerated.length;
  const bootstrap = plan.bootstrap ? " (the bootstrap: nothing had been recorded)" : "";
  const over = n === 1 ? "its baseline" : "their baselines";
  const leave = `leave the ${num(left)} that moved within the gate's tolerance ${asTheyAre(left)};`;
  return [
    n === 0
      ? `copy no baseline, and write ${BASELINE_RENDERER_PATH}${bootstrap};`
      : `copy ${plural(n, "twin")} over ${over}, and write ${BASELINE_RENDERER_PATH};`,
    ...(left === 0 ? [] : [leave]),
    `record ${oneLineRenderer(current)};`,
    "then run the gate with the renderer check on, and put every file back if it is red.",
  ];
}

/**
 * Where e2e/ stands after a --confirm that wrote and did not keep it (a red gate, an error, a
 * signal): `left` is what git still shows changed there, `markKept` whether the pending mark
 * outlived the restore, in which case the next run puts those files back before anything else.
 */
export function describeLeft(left: readonly string[], markKept: boolean): string[] {
  return [
    left.length === 0 ? "e2e/ matches HEAD again." : `NOT AS HEAD HAS IT: ${left.join("; ")}`,
    ...(markKept
      ? ["The next pnpm e2e:rebase-renderer puts back what this run wrote before anything else."]
      : []),
  ];
}

const LISTED_FILES = 30;

/** The files a re-base would move, most changed first, so a reader sees which pages drifted. */
export function describeRebased(toRebase: readonly Judged[]): string[] {
  const fraction = (j: Judged) => j.verdict.metrics.changedFraction;
  const sorted = [...toRebase].sort((a, b) => fraction(b) - fraction(a));
  const lines = sorted
    .slice(0, LISTED_FILES)
    .map((j) => `${percent(fraction(j)).padStart(6)}  ${j.baseline}`);
  if (sorted.length > LISTED_FILES) lines.push(`… and ${sorted.length - LISTED_FILES} more`);
  return lines;
}

/**
 * Every verdict, one tab-separated row a file, for the scratch directory: the full record behind
 * the counts, readable by a person or a spreadsheet without re-running an eight-minute suite.
 * `gate` is the comparator's answer on a renderer-only row, so the files the report only counts
 * as within its tolerance ("passes") are named here.
 */
export function verdictTable(judged: readonly Judged[]): string {
  const header = [
    "baseline",
    "verdict",
    "gate",
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
    // an unasked renderer-only row is re-based as unknown (withinGateTolerance), so it says so
    const gate = j.verdict.verdict === "renderer-only" ? (j.gate ?? "unknown") : "";
    return [
      j.baseline,
      j.verdict.verdict,
      gate,
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
  plan: RebasePlan;
  counts: Tally;
  total: number;
  verdict: RendererVerdict;
  recorded: RendererRecord | null;
  current: RendererRecord;
  /** the last run on this machine whose canary matched the record, which dates what moved */
  lastMatch: RendererRecord | null;
  head: { sha: string; subject: string };
  /** HEAD was pushed as origin/main's tip; when not, the commit says what vouched for it instead */
  pushed: boolean;
  /** `rerun`: what the one re-run ran again, or null when the first run was green */
  control: SuiteFacts;
  gate: SuiteFacts;
}

interface SuiteFacts {
  passed: number;
  rerun: RerunScope | null;
}

const RERAN: Record<RerunScope, string> = {
  "what-failed": ", after one re-run of what failed first",
  "whole-suite": ", on one re-run of the whole suite after the first run failed",
};

interface Moved {
  /** the moves, "macOS 27.2 -> 27.3, chromium r1228 -> r1240", or that none moved */
  moves: string;
  /** the day the canary last matched on this machine, when that match was against the record */
  lastMatchedOn: string | null;
}

/**
 * The versions that moved, read since the canary last matched on this machine when that match was
 * against this record, else since the record, which is rewritten only when the canary moves.
 */
function movedSince(recorded: RendererRecord, facts: CommitFacts): Moved {
  const window = versionWindow(recorded, facts.lastMatch);
  const versions = versionMoves(window.since, facts.current)
    .filter((m) => m.before !== m.after)
    .map((m) => `${m.label} ${m.before} -> ${m.after}`);
  return {
    moves: versions.length === 0 ? "no recorded version moved" : versions.join(", "),
    lastMatchedOn: window.lastMatched ? window.since.recordedOn.slice(0, 10) : null,
  };
}

/** The same, as a clause: dated by the last match, or said to be read since the record. */
function movedClause({ moves, lastMatchedOn }: Moved): string {
  if (lastMatchedOn !== null) {
    return `since it last matched on this machine, ${lastMatchedOn}: ${moves}`;
  }
  return (
    `${moves}, since the record was written (it is rewritten only when the canary moves, so a ` +
    "version may have moved long before the canary did)"
  );
}

function whatMoved(facts: CommitFacts): string {
  const { recorded, current, verdict } = facts;
  if (recorded === null) {
    return (
      "No renderer had been recorded (e2e/baseline-renderer.json did not exist), so every " +
      "gate run stopped with NO RENDERER RECORD before seeding."
    );
  }
  const moved = movedSince(recorded, facts);
  const which = movedClause(moved);
  const sha = (record: RendererRecord) => record.canary.pixelSha256.slice(0, 12);
  const canary = `${sha(recorded)} -> ${sha(current)}`;
  const on = recorded.recordedOn.slice(0, 10);
  if (verdict === "fonts-changed") {
    const fonts = (record: RendererRecord) => record.canary.fontSha256.slice(0, 12);
    return (
      `The Geist files the app ships (node_modules/geist) changed since ${on} ` +
      `(${fonts(recorded)} -> ${fonts(current)}; ${which}), so the canary's recorded pixels ` +
      `could no longer be compared (canary ${canary}). A font change is the app's own: its ` +
      "baselines are redrawn by the change that moved the font, and no twin is copied here."
    );
  }
  if (verdict === "canary-changed") {
    return (
      `The renderer canary itself (scripts/e2e-renderer/canary.ts) changed since ${on}, its ` +
      `fonts did not (${which}), so its recorded pixels could no longer be compared ` +
      `(canary ${canary}).`
    );
  }
  const stopped = `This Mac stopped drawing the renderer canary recorded on ${on}`;
  if (moved.lastMatchedOn === null) return `${stopped}: ${which}; canary ${canary}.`;
  return (
    `${stopped}. Since it last matched on this machine, ${moved.lastMatchedOn}: ` +
    `${moved.moves}; canary ${canary}.`
  );
}

/**
 * The commit's account of the gate's split, or null when nothing drifted. Every file the gate
 * passed is counted as left, so a re-base smaller than the drift reads as the rule rather than as
 * files forgotten.
 */
function gateParagraph(counts: Tally): string | null {
  const n = counts.rendererOnly.length;
  if (n === 0) return null;
  const { failing, unknown, tolerated } = gateSplit(counts);
  const couldNot =
    `${num(unknown)} could not be put to it and ${isAre(unknown)} re-based as though the gate ` +
    `failed ${itThem(unknown)}`;
  const left =
    `${num(tolerated)} moved within the gate's tolerance and ${isAre(tolerated)} left ` +
    asTheyAre(tolerated);
  const clauses = [
    ...(failing + unknown === 0 ? ["none fails it"] : []),
    ...(failing === 0
      ? []
      : [`${plural(failing, "fails", "fail")} it and ${isAre(failing)} re-based`]),
    ...(unknown === 0 ? [] : [couldNot]),
    ...(tolerated === 0 ? [] : [left]),
  ];
  const files = n === 1 ? "the one renderer-only file" : `the ${num(n)} renderer-only files`;
  return (
    "Only what the gate itself fails is re-based, asked of Playwright's own comparator with the " +
    `gate's options (scripts/e2e-renderer/gate-comparator.ts). Of ${files}, ` +
    `${clauses.join("; ")}.`
  );
}

/**
 * What vouched for a HEAD never pushed as origin/main's tip, which no gate had passed; null for
 * one that was. The words hold both for commits origin/main lacks and for one a push carried
 * past. A copy happens there only under --allow-unpushed (planRebase).
 */
function unpushedParagraph(facts: CommitFacts): string | null {
  if (facts.pushed) return null;
  const sha = facts.head.sha.slice(0, 7);
  const at = `${sha} was never pushed as origin/main's tip, so no gate had passed it`;
  const n = facts.plan.files.length;
  if (n === 0) {
    return (
      `${at}; the control did, as far as a record needs: the gate's own comparator passed every ` +
      "committed baseline it drew, and no baseline was copied."
    );
  }
  return (
    `${at} (--allow-unpushed). Nothing proved the committed baselines were its UI, so ` +
    `diffVerdict's content check alone vouches that the ${plural(n, "re-based file")} moved by ` +
    "the renderer alone."
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
  const reran = (run: SuiteFacts) => (run.rerun === null ? "" : RERAN[run.rerun]);
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
  const unpushed = unpushedParagraph(facts);
  if (unpushed !== null) body.push("", unpushed);
  const split = gateParagraph(counts);
  if (split !== null) body.push("", split);
  if (counts.worst !== null && counts.medianChangedFraction !== null && counts.closest !== null) {
    const middle = percent(counts.medianChangedFraction);
    body.push(
      "",
      `Changed pixels of the renderer-only files: median ${middle}, worst ` +
        `${percent(counts.worst.verdict.metrics.changedFraction)} (${counts.worst.baseline}). ` +
        `Closest to a limit: ${marginLine(counts.closest)} in ${counts.closest.baseline}.`,
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
