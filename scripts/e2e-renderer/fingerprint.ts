import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Which renderer drew the e2e baselines, and whether this machine is still it.
 *
 * The baselines are compared at maxDiffPixels 0, so they are only evidence while the machine
 * rasterises text exactly as it did when they were drawn. When it stops, nearly every baseline
 * with text fails at once, and on 2026-09-28 that cost a 9-minute run and 107 failures that
 * all turned out to be a macOS update rather than a regression. The record below pins the
 * renderer by what it DRAWS (the canary's pixels), with the versions beside it only to say
 * what moved.
 *
 * The record is written by `pnpm e2e:rebase-renderer --confirm` after a green control run,
 * never by hand and never by the gate: a gate that recorded whatever it saw would bless the
 * very change it exists to catch.
 */

export const BASELINE_RENDERER_PATH = "e2e/baseline-renderer.json";
export const RENDERER_CHECK_ENV = "E2E_RENDERER_CHECK";
export const REBASE_RENDERER_COMMAND = "pnpm e2e:rebase-renderer --confirm";
/**
 * What global setup hands the workers when the canary does not match and the run goes on: the
 * refusal every comparison with a committed baseline throws (e2e/expect-baseline.ts). Set or
 * cleared by every global setup, whatever the shell had, since the workers inherit its env.
 */
export const RENDERER_REFUSAL_ENV = "E2E_RENDERER_REFUSAL";

const CANARY_SOURCE = "scripts/e2e-renderer/canary.ts";
/** Where the Geist files come from: the package the app's next/font loaders read. */
const GEIST_FILES = "node_modules/geist";
/** Enough of a sha256 to tell two apart in a message; the record keeps all 64. */
const SHORT_SHA = 12;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase sha256");
const RendererRecordSchema = z.object({
  canary: z.object({
    pixelSha256: sha256Hex,
    /** everything but the machine that decides its pixels: canary.ts's code, page and fonts */
    sourceSha256: sha256Hex,
    /** the Geist files alone, which the app ships too: a change here moves the app's baselines */
    fontSha256: sha256Hex,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  recordedOn: z.string().min(1),
  macos: z.object({ productVersion: z.string().min(1), buildVersion: z.string() }),
  playwright: z.string().min(1),
  chromiumRevision: z.string().min(1),
});

export type RendererRecord = z.infer<typeof RendererRecordSchema>;
export type CanaryFingerprint = RendererRecord["canary"];
export type RendererEnvironment = Pick<RendererRecord, "macos" | "playwright" | "chromiumRevision">;
/**
 * - "fonts-changed": the Geist files the app ships are not the recorded ones. That is the app's
 *   own change, a UI change: it moves every baseline with text, and those belong to the commit
 *   that changed the font. `pnpm e2e:rebase-renderer` copies no twin while it holds.
 * - "canary-changed": the canary's page or context was edited, the fonts are as recorded. An
 *   edit to the canary moves no baseline.
 * - "renderer-changed": the same canary, drawn differently: the Mac or Chromium moved.
 */
export type RendererVerdict =
  | "match"
  | "renderer-changed"
  | "canary-changed"
  | "fonts-changed"
  | "unrecorded";
export type Mismatch = Exclude<RendererVerdict, "match">;

/**
 * How a run uses the committed baselines, which decides what a mismatch stops:
 * - "gate": E2E_GATE set. It compares every baseline, and is stopped outright, before seeding.
 * - "update": --update-snapshots, bare (changed) or all. It redraws baselines rather than
 *   comparing them; each redraw is refused, since it would carry the Mac's drift.
 * - "compare": any other run. Each comparison with a committed baseline is refused; a spec that
 *   compares none runs as usual.
 */
export type RunKind = "gate" | "compare" | "update";

export type RendererCheck =
  | { verdict: "skipped" }
  | { verdict: "match"; recorded: RendererRecord; current: RendererRecord }
  /** a run that is not a gate goes on; `refusal` is what each comparison with a baseline throws */
  | { verdict: Mismatch; run: Exclude<RunKind, "gate">; message: string; refusal: string };

type Env = Readonly<Record<string, string | undefined>>;

/** E2E_GATE as playwright.config.ts reads it (any non-empty value), then the snapshot mode. */
export function runKindOf(env: Env, updateSnapshots?: string): RunKind {
  const gate = env.E2E_GATE;
  if (gate !== undefined && gate !== "") return "gate";
  return updateSnapshots === "all" || updateSnapshots === "changed" ? "update" : "compare";
}

function parseRecord(value: unknown, file: string): RendererRecord {
  const parsed = RendererRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file} is not a renderer record: ${issues}`);
  }
  return parsed.data;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A record read from `file`, null when there is no such file; anything else in it throws. */
function readRecordFile(file: string): RendererRecord | null {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return null;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${messageOf(error)}`);
  }
  return parseRecord(json, file);
}

/** Validated, then rebuilt field by field so a file always reads in the same order. */
function serializeRecord(record: RendererRecord, file: string): string {
  const valid = parseRecord(record, file);
  const ordered: RendererRecord = {
    canary: {
      pixelSha256: valid.canary.pixelSha256,
      sourceSha256: valid.canary.sourceSha256,
      fontSha256: valid.canary.fontSha256,
      width: valid.canary.width,
      height: valid.canary.height,
    },
    recordedOn: valid.recordedOn,
    macos: { productVersion: valid.macos.productVersion, buildVersion: valid.macos.buildVersion },
    playwright: valid.playwright,
    chromiumRevision: valid.chromiumRevision,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The recorded renderer, or null when none has been recorded yet. */
export function readRecord(file: string = BASELINE_RENDERER_PATH): RendererRecord | null {
  return readRecordFile(file);
}

/** Validates before writing, so a record that could never match does not reach the disk. */
export function writeRecord(record: RendererRecord, file: string = BASELINE_RENDERER_PATH): void {
  fs.writeFileSync(path.resolve(file), serializeRecord(record, file));
}

/* ── The last match ────────────────────────────────────────────────────────────────────────── */

/**
 * The last run on this machine whose canary matched the record. The record is written only when
 * the canary moves, so its versions go stale on every update that draws the canary identically,
 * and "what moved" read against it would list a Chromium roll that matched for weeks beside the
 * update that actually moved the canary. Global setup and the re-base command note every match
 * here, and a mismatch reads what moved since. It lives in git's common directory: it belongs to
 * this machine and its node_modules, which every worktree shares, and never to a commit.
 */
export const LAST_MATCH_NAME = "e2e-renderer-last-match.json";

export function lastMatchPath(cwd?: string): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return path.resolve(cwd ?? ".", common, LAST_MATCH_NAME);
}

/** The last match noted, or null when none was; a note that is not a record throws, naming it. */
export function readLastMatch(file: string = lastMatchPath()): RendererRecord | null {
  return readRecordFile(file);
}

/** Notes a match whole or not at all: written beside the note, then renamed over it. */
export function rememberMatch(record: RendererRecord, file: string = lastMatchPath()): void {
  const text = serializeRecord(record, file);
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, text);
  fs.renameSync(partial, file);
}

/**
 * The last match, or null when there is none or it cannot be read, which `say` hears: a note
 * never stops a run, and without it what moved is read since the record, which the message says.
 */
export function lastMatchOrSay(say: (line: string) => void, file?: string): RendererRecord | null {
  try {
    return readLastMatch(file);
  } catch (error) {
    say(`the renderer's last-match note cannot be read (${messageOf(error)})`);
    return null;
  }
}

/** Notes a match, or says why it could not: a note never stops a run. */
export function rememberMatchOrSay(
  record: RendererRecord,
  say: (line: string) => void,
  file?: string,
): void {
  try {
    rememberMatch(record, file);
  } catch (error) {
    say(`this match could not be noted (${messageOf(error)})`);
  }
}

function readMacosVersion(): RendererRecord["macos"] {
  // The gate only runs on the owner's Mac; anywhere else says so rather than guessing.
  if (process.platform !== "darwin") {
    return { productVersion: `not macOS (${process.platform} ${os.release()})`, buildVersion: "" };
  }
  const swVers = (flag: string): string =>
    execFileSync("/usr/bin/sw_vers", [flag], { encoding: "utf8", timeout: 5_000 }).trim();
  return { productVersion: swVers("-productVersion"), buildVersion: swVers("-buildVersion") };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Resolved the way the test runner resolves them: @playwright/test → playwright →
 * playwright-core, whose browsers.json names the builds this Playwright downloads. The
 * revision is the headless shell's, because that is the binary a headless launch runs whenever
 * no channel is set, so it is what draws the baselines. It rolls in lockstep with chromium.
 */
function readInstalledPlaywright(): Pick<RendererRecord, "playwright" | "chromiumRevision"> {
  const testPackage = createRequire(import.meta.url).resolve("@playwright/test/package.json");
  const runnerPackage = createRequire(testPackage).resolve("playwright/package.json");
  const corePackage = createRequire(runnerPackage).resolve("playwright-core/package.json");

  const { version } = z.object({ version: z.string().min(1) }).parse(readJson(testPackage));
  const { browsers } = z
    .object({ browsers: z.array(z.object({ name: z.string(), revision: z.string() })) })
    .parse(readJson(path.join(path.dirname(corePackage), "browsers.json")));
  const shell = browsers.find((b) => b.name === "chromium-headless-shell");
  if (shell === undefined) {
    throw new Error(`playwright-core ${corePackage} lists no chromium-headless-shell build`);
  }
  return { playwright: version, chromiumRevision: shell.revision };
}

export function currentEnvironment(): RendererEnvironment {
  return { macos: readMacosVersion(), ...readInstalledPlaywright() };
}

/**
 * The canary's pixels decide; the versions never do. Chromium 147, 148, 149 and 151 drew the
 * canary identically on 2026-09-28, so refusing a run because a version string moved would cry
 * wolf on exactly the updates that change nothing. A changed source is checked first: the
 * recorded pixels then belong to another page, and comparing them proves nothing either way.
 * Changed fonts come before any other change to the source, because they are the one change of
 * the app's own that the canary sees, and a re-base must not take it for the renderer's.
 */
export function compareRecord(
  recorded: RendererRecord | null,
  current: RendererRecord,
): RendererVerdict {
  if (recorded === null) return "unrecorded";
  const a = recorded.canary;
  const b = current.canary;
  if (a.fontSha256 !== b.fontSha256) return "fonts-changed";
  if (a.sourceSha256 !== b.sourceSha256) return "canary-changed";
  const samePixels =
    a.pixelSha256 === b.pixelSha256 && a.width === b.width && a.height === b.height;
  return samePixels ? "match" : "renderer-changed";
}

function short(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

function fromTo(before: string, after: string): string {
  return before === after ? `${before}  (unchanged)` : `${before} → ${after}`;
}

function canarySize(recorded: CanaryFingerprint, current: CanaryFingerprint): string {
  const before = `${recorded.width}×${recorded.height}`;
  const after = `${current.width}×${current.height}`;
  return before === after ? before : `${before} → ${after}`;
}

/** "27.2 (26B5091g)", or the product version alone when there is no build to name. */
export function macosLabel(macos: RendererRecord["macos"]): string {
  if (macos.buildVersion === "") return macos.productVersion;
  return `${macos.productVersion} (${macos.buildVersion})`;
}

/** The renderer a record names, on one line: what the gate and the re-base command print. */
export function oneLineRenderer(record: RendererRecord): string {
  return (
    `macOS ${macosLabel(record.macos)} · chromium r${record.chromiumRevision} · ` +
    `playwright ${record.playwright} · canary ${short(record.canary.pixelSha256)}`
  );
}

/** A row of the what-changed table, two deeper than the message's own continuation lines. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
}

/**
 * Where "what moved" is read from: the last match on this machine when it matched this record,
 * else the record itself, whose versions may be long stale (LAST_MATCH_NAME says why).
 */
export interface VersionWindow {
  since: RendererRecord;
  lastMatched: boolean;
}

function sameCanary(a: CanaryFingerprint, b: CanaryFingerprint): boolean {
  return (
    a.pixelSha256 === b.pixelSha256 &&
    a.sourceSha256 === b.sourceSha256 &&
    a.fontSha256 === b.fontSha256 &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * A last match counts only when it matched this record, its canary the record's. One noted against
 * another canary (re-recorded since, or another branch's) says nothing about when this one held.
 */
export function versionWindow(
  recorded: RendererRecord,
  lastMatch: RendererRecord | null,
): VersionWindow {
  return lastMatch !== null && sameCanary(lastMatch.canary, recorded.canary)
    ? { since: lastMatch, lastMatched: true }
    : { since: recorded, lastMatched: false };
}

export interface VersionMove {
  label: string;
  before: string;
  after: string;
}

/** Each version the record names, from the window's start to this Mac now. */
export function versionMoves(since: RendererRecord, current: RendererRecord): VersionMove[] {
  return [
    { label: "macOS", before: macosLabel(since.macos), after: macosLabel(current.macos) },
    {
      label: "chromium",
      before: `r${since.chromiumRevision}`,
      after: `r${current.chromiumRevision}`,
    },
    { label: "playwright", before: since.playwright, after: current.playwright },
  ];
}

interface VersionRows {
  rows: string[];
  moved: boolean;
}

/** The window's label, one row per version, and whether any of them moved in the window. */
function versionRows(window: VersionWindow, current: RendererRecord): VersionRows {
  const on = window.since.recordedOn.slice(0, 10);
  const label = window.lastMatched
    ? [`Versions since the canary last matched on this machine, ${on}:`]
    : [
        `Versions since the record was written, ${on}. It is rewritten only when the canary`,
        "moves, so a version shown moving may have moved long before the canary did:",
      ];
  const moves = versionMoves(window.since, current);
  return {
    rows: [...label, ...moves.map((m) => row(m.label, fromTo(m.before, m.after)))],
    moved: moves.some((m) => m.before !== m.after),
  };
}

/** The house shape (see quiet-box.ts): a headline, then continuation lines six spaces in. */
function message(headline: string, body: readonly string[]): string {
  return [headline, ...body.map((line) => `      ${line}`)].join("\n");
}

const RUN_ANYWAY =
  `To run the suite anyway and see the churn for yourself, set ${RENDERER_CHECK_ENV}=skip.`;

/**
 * The canary is a tripwire, not a count: it says the pixels under the baselines moved, never how
 * many the gate would now fail, which the re-base command measures.
 */
const TOLERANCE = [
  "The canary is compared pixel for pixel and the gate is not: maxDiffPixels 0 counts a pixel",
  "only past a colour threshold, and never one it takes for anti-aliasing. So how many",
  "baselines this moves past the gate is not known until they are drawn: none, some or nearly",
  "all. On 2026-09-28 macOS 27.2 failed 107 of the 202, and 20 dark pages it moved by 931 to",
  "6,394 pixels still passed.",
];

/**
 * What the run does about it. Only a gate is stopped outright: it compares every committed
 * baseline. Any other run may be a spec that compares none, and goes on; each comparison with a
 * committed baseline stops instead, through e2e/expect-baseline.ts.
 */
const CONSEQUENCE: Record<RunKind, readonly string[]> = {
  gate: [
    "The gate stopped here, before seeding: it compares every committed baseline, and a",
    "failure among them could be the Mac's doing, NOT the change under test's.",
  ],
  compare: [
    "This run goes on, but compares no screenshot with a committed baseline: each such",
    "comparison stops, pointing here, since a failure could be the Mac's doing and NOT the",
    "change under test's. Specs that compare no baseline run as usual.",
  ],
  update: [
    "This run goes on, but redraws no baseline: redrawn now, one would carry this Mac's drift",
    "beside the change under test, and no diff could tell the two apart. Each such screenshot",
    "stops, pointing here; specs that compare no baseline run as usual.",
  ],
};

const FIX_BY_REBASE = [
  `Fix: ${REBASE_RENDERER_COMMAND}. It draws the whole suite at HEAD, re-bases only the`,
  "baselines the gate itself fails, and records the renderer alone when the gate fails none.",
  "It runs the whole suite twice, a control and then the gate, and it needs a clean tree,",
  "so commit or stash work in progress first.",
];

const FONTS_REDRAW = `pnpm build && ${RENDERER_CHECK_ENV}=skip pnpm e2e:update`;

/** What the message is told beyond the two records. */
export interface MismatchContext {
  /** the last match on this machine, which dates what moved */
  lastMatch?: RendererRecord | null;
  /** how the run uses the baselines, which decides what it is told happens now; a gate unsaid */
  run?: RunKind;
}

export function rendererMismatchMessage(
  verdict: Mismatch,
  recorded: RendererRecord | null,
  current: RendererRecord,
  file: string = BASELINE_RENDERER_PATH,
  context: MismatchContext = {},
): string {
  const consequence = CONSEQUENCE[context.run ?? "gate"];
  if (recorded === null || verdict === "unrecorded") {
    return message(`e2e: NO RENDERER RECORD — ${file} does not exist.`, [
      "Nothing says which renderer drew the baselines, so an OS or Chromium update would",
      "surface as a wide spread of unrelated visual failures instead of this one message.",
      `This Mac now: ${oneLineRenderer(current)}`,
      ...consequence,
      ...FIX_BY_REBASE,
      RUN_ANYWAY,
    ]);
  }

  const { rows, moved } = versionRows(versionWindow(recorded, context.lastMatch ?? null), current);
  const recordedOn = recorded.recordedOn.slice(0, 10);
  if (verdict === "fonts-changed") {
    const before = short(recorded.canary.fontSha256);
    const after = short(current.canary.fontSha256);
    return message(
      `e2e: THE APP'S FONTS CHANGED — ${GEIST_FILES} is not the Geist the baselines were ` +
        "drawn with.",
      [
        `${file} (recorded ${recordedOn}) holds Geist files ${before};`,
        `this checkout ships ${after}.`,
        ...rows,
        "The app draws its text with these files, so this is a UI change and not the renderer's:",
        "it moves every baseline with text, and those are redrawn, read and committed with the",
        "change that moved the font, like any other UI change:",
        `  ${FONTS_REDRAW}`,
        `Once they are, record the renderer with ${REBASE_RENDERER_COMMAND}.`,
        "It copies no twin while the fonts differ from the record, so it cannot re-base the",
        "font's own drift as though the Mac had moved.",
        ...consequence,
        RUN_ANYWAY,
      ],
    );
  }
  if (verdict === "canary-changed") {
    const before = short(recorded.canary.sourceSha256);
    const after = short(current.canary.sourceSha256);
    return message(
      "e2e: THE RENDERER CANARY ITSELF CHANGED — its pixels cannot be compared with the record.",
      [
        `${file} (recorded ${recordedOn}) holds the canary built from source ${before};`,
        `this checkout builds it from ${after}. The Geist files are the ones recorded, so`,
        `${CANARY_SOURCE} itself was edited, and an edit to the canary moves no baseline.`,
        ...rows,
        "Until the canary is recorded again the gate cannot tell whether the renderer moved too.",
        ...consequence,
        ...FIX_BY_REBASE,
        RUN_ANYWAY,
      ],
    );
  }

  const pixels = `${short(recorded.canary.pixelSha256)} → ${short(current.canary.pixelSha256)}`;
  return message(
    "e2e: THE RENDERER CHANGED — this Mac no longer draws the renderer canary as the record says.",
    [
      `The renderer canary (${CANARY_SOURCE}: one frozen page, no app code, no`,
      `server) does not match ${file}, recorded ${recordedOn}.`,
      ...rows,
      row("canary", `${pixels}  (${canarySize(recorded.canary, current.canary)})`),
      ...(moved
        ? []
        : [
            "None of those versions moved, so something beneath them did: a system font, a",
            "text-rendering setting or a graphics driver. The canary's pixels are the arbiter.",
          ]),
      ...TOLERANCE,
      ...consequence,
      ...FIX_BY_REBASE,
      RUN_ANYWAY,
    ],
  );
}

/**
 * What each comparison with a committed baseline throws in a run that went on past a mismatch:
 * short, since a run can make dozens, and pointing at the message global setup printed once.
 */
export function rendererRefusal(verdict: Mismatch, file: string = BASELINE_RENDERER_PATH): string {
  const fix =
    verdict === "fonts-changed"
      ? `redraw the baselines with the font (${FONTS_REDRAW}), then ${REBASE_RENDERER_COMMAND}`
      : REBASE_RENDERER_COMMAND;
  return (
    "e2e: no screenshot is compared with, or redrawn over, a committed baseline while this " +
    `Mac's renderer canary does not match ${file} (${verdict}). Global setup's message at the ` +
    `top of this run says what moved and why. Fix: ${fix}.`
  );
}

/** The refusal global setup handed the workers, or null when it handed none. */
export function baselineRefusal(env: Env): string | null {
  const refusal = env[RENDERER_REFUSAL_ENV];
  return refusal === undefined || refusal === "" ? null : refusal;
}

/**
 * Renders the canary in a fresh headless Chromium, launched by canary.ts (measureCanary) so that
 * its source hash covers the launch too: this file launches nothing of its own.
 */
export async function measureCurrentRenderer(now: Date = new Date()): Promise<RendererRecord> {
  // Loaded here rather than at the top so that reading or comparing a record, which is all the
  // unit tests do, never loads a browser driver.
  const { measureCanary } = await import("./canary");
  const canary = await measureCanary();
  return {
    canary: {
      pixelSha256: canary.pixelSha256,
      sourceSha256: canary.sourceSha256,
      fontSha256: canary.fontSha256,
      width: canary.width,
      height: canary.height,
    },
    recordedOn: now.toISOString(),
    ...currentEnvironment(),
  };
}

export interface RendererCheckOptions {
  file?: string;
  /** A plain record, not `NodeJS.ProcessEnv`, so a test can hand it exactly the keys it reads. */
  env?: Env;
  measure?: () => Promise<RendererRecord>;
  /** Playwright's resolved config.updateSnapshots: "all" or "changed" redraws baselines. */
  updateSnapshots?: string;
  /** The last match on this machine, asked only on a mismatch, to date what moved. */
  lastMatch?: () => RendererRecord | null;
}

/**
 * The canary against the record, before the database is seeded: about a second. A gate is
 * stopped here on a mismatch, by a throw of the one message: it compares every committed
 * baseline, and every minute it spent after a renderer change would produce failures that are
 * not about the change under test. Any other run is not stopped: it may be a spec that compares
 * no baseline at all. It gets the message to print and the refusal each of its comparisons with
 * a committed baseline throws (e2e/expect-baseline.ts).
 */
export async function checkRendererForRun(
  options: RendererCheckOptions = {},
): Promise<RendererCheck> {
  const env = options.env ?? process.env;
  const mode = env[RENDERER_CHECK_ENV];
  if (mode === "skip") return { verdict: "skipped" };
  if (mode !== undefined && mode !== "") {
    throw new Error(
      `e2e: ${RENDERER_CHECK_ENV}=${mode} is not a mode. Set it to "skip" to bypass the renderer ` +
        "check, or leave it unset.",
    );
  }

  const file = options.file ?? BASELINE_RENDERER_PATH;
  const recorded = readRecord(file);
  const current = await (options.measure ?? measureCurrentRenderer)();
  const found = { recorded, current, file, env, options };
  if (recorded === null) return stopOrGoOn("unrecorded", found);
  const verdict = compareRecord(recorded, current);
  if (verdict === "match") return { verdict, recorded, current };
  return stopOrGoOn(verdict, found);
}

interface Found {
  recorded: RendererRecord | null;
  current: RendererRecord;
  file: string;
  env: Env;
  options: RendererCheckOptions;
}

/** A mismatch: the gate's throw, or what a run that goes on prints and hands its workers. */
function stopOrGoOn(verdict: Mismatch, found: Found): RendererCheck {
  const { recorded, current, file, env, options } = found;
  const run = runKindOf(env, options.updateSnapshots);
  const lastMatch = (options.lastMatch ?? (() => null))();
  const text = rendererMismatchMessage(verdict, recorded, current, file, { lastMatch, run });
  if (run === "gate") throw new Error(text);
  return { verdict, run, message: text, refusal: rendererRefusal(verdict, file) };
}

/** What global-setup prints, so the log says which renderer a run was judged on. */
export function describeRendererCheck(check: RendererCheck): string {
  if (check.verdict === "skipped") {
    return (
      `[e2e setup] renderer check SKIPPED (${RENDERER_CHECK_ENV}=skip): a wide spread of visual ` +
      "failures in this run may be the machine, not the change."
    );
  }
  if (check.verdict === "match") {
    return `[e2e setup] renderer matches the baselines' — ${oneLineRenderer(check.current)}`;
  }
  return (
    `[e2e setup] renderer canary: ${check.verdict}, and this run goes on, since it is not a ` +
    `gate (E2E_GATE); every comparison with a committed baseline stops instead:\n${check.message}`
  );
}
