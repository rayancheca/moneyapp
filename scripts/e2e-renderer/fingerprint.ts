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

const CANARY_SOURCE = "scripts/e2e-renderer/canary.ts";
/** Enough of a sha256 to tell two apart in a message; the record keeps all 64. */
const SHORT_SHA = 12;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase sha256");
const RendererRecordSchema = z.object({
  canary: z.object({
    pixelSha256: sha256Hex,
    sourceSha256: sha256Hex,
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
export type RendererVerdict = "match" | "renderer-changed" | "canary-changed" | "unrecorded";
export type RendererCheck =
  | { verdict: "skipped" }
  | { verdict: "match"; recorded: RendererRecord; current: RendererRecord };

function parseRecord(value: unknown, file: string): RendererRecord {
  const parsed = RendererRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file} is not a renderer record: ${issues}`);
  }
  return parsed.data;
}

/** The recorded renderer, or null when none has been recorded yet. */
export function readRecord(file: string = BASELINE_RENDERER_PATH): RendererRecord | null {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return null;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${reason}`);
  }
  return parseRecord(json, file);
}

/** Validates before writing, so a record that could never match does not reach the disk. */
export function writeRecord(record: RendererRecord, file: string = BASELINE_RENDERER_PATH): void {
  const valid = parseRecord(record, file);
  // Rebuilt field by field so the file always reads in the same order, whatever the caller built.
  const ordered: RendererRecord = {
    canary: {
      pixelSha256: valid.canary.pixelSha256,
      sourceSha256: valid.canary.sourceSha256,
      width: valid.canary.width,
      height: valid.canary.height,
    },
    recordedOn: valid.recordedOn,
    macos: { productVersion: valid.macos.productVersion, buildVersion: valid.macos.buildVersion },
    playwright: valid.playwright,
    chromiumRevision: valid.chromiumRevision,
  };
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(ordered, null, 2)}\n`);
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
 */
export function compareRecord(
  recorded: RendererRecord | null,
  current: RendererRecord,
): RendererVerdict {
  if (recorded === null) return "unrecorded";
  const a = recorded.canary;
  const b = current.canary;
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

interface VersionRows {
  rows: string[];
  moved: boolean;
}

/** One row per version the record names, and whether any of them moved at all. */
function versionRows(recorded: RendererRecord, current: RendererRecord): VersionRows {
  const pairs: [string, string, string][] = [
    ["macOS", macosLabel(recorded.macos), macosLabel(current.macos)],
    ["chromium", `r${recorded.chromiumRevision}`, `r${current.chromiumRevision}`],
    ["playwright", recorded.playwright, current.playwright],
  ];
  return {
    rows: pairs.map(([label, before, after]) => row(label, fromTo(before, after))),
    moved: pairs.some(([, before, after]) => before !== after),
  };
}

/** The house shape (see quiet-box.ts): a headline, then continuation lines six spaces in. */
function message(headline: string, body: readonly string[]): string {
  return [headline, ...body.map((line) => `      ${line}`)].join("\n");
}

const RUN_ANYWAY =
  `To run the suite anyway and see the churn for yourself, set ${RENDERER_CHECK_ENV}=skip.`;

export function rendererMismatchMessage(
  verdict: Exclude<RendererVerdict, "match">,
  recorded: RendererRecord | null,
  current: RendererRecord,
  file: string = BASELINE_RENDERER_PATH,
): string {
  if (recorded === null || verdict === "unrecorded") {
    return message(`e2e: NO RENDERER RECORD — ${file} does not exist.`, [
      "Nothing says which renderer drew the baselines, so an OS or Chromium update would",
      "surface as a wide spread of unrelated visual failures instead of this one message.",
      `This Mac now: ${oneLineRenderer(current)}`,
      `Fix: ${REBASE_RENDERER_COMMAND} — it records the renderer after a green control run.`,
      RUN_ANYWAY,
    ]);
  }

  const { rows, moved } = versionRows(recorded, current);
  const recordedOn = recorded.recordedOn.slice(0, 10);
  if (verdict === "canary-changed") {
    const before = short(recorded.canary.sourceSha256);
    const after = short(current.canary.sourceSha256);
    return message(
      "e2e: THE RENDERER CANARY ITSELF CHANGED — its pixels cannot be compared with the record.",
      [
        `${file} (recorded ${recordedOn}) holds the canary built from source ${before};`,
        `this checkout builds it from ${after}. Either ${CANARY_SOURCE} or the Geist`,
        "font files it embeds (node_modules/geist) are not what was recorded.",
        ...rows,
        "An edit to the canary moves no baseline; a Geist upgrade moves every baseline with",
        "text. Until the canary is recorded again the gate cannot tell which one this is.",
        `Fix: ${REBASE_RENDERER_COMMAND}`,
        RUN_ANYWAY,
      ],
    );
  }

  const pixels = `${short(recorded.canary.pixelSha256)} → ${short(current.canary.pixelSha256)}`;
  return message(
    "e2e: THE RENDERER CHANGED — this Mac no longer draws the pixels the baselines were drawn with.",
    [
      `The renderer canary (${CANARY_SOURCE}: one frozen page, no app code, no`,
      `server) does not match ${file}, recorded ${recordedOn}:`,
      ...rows,
      row("canary", `${pixels}  (${canarySize(recorded.canary, current.canary)})`),
      ...(moved
        ? []
        : [
            "None of the versions it records moved, so something beneath them did: a system font,",
            "a text-rendering setting or a graphics driver. The canary's pixels are the arbiter.",
          ]),
      "Nearly every baseline with text in it would now fail at maxDiffPixels 0, and that is",
      "NOT the change under test. On 2026-09-28 exactly this failed 107 baselines after a",
      "9-minute run in which no UI had changed; the suite stopped here instead.",
      `Fix: ${REBASE_RENDERER_COMMAND}`,
      RUN_ANYWAY,
    ],
  );
}

/** Renders the canary in a fresh headless Chromium, the same launch the test runner makes. */
export async function measureCurrentRenderer(now: Date = new Date()): Promise<RendererRecord> {
  // Loaded here rather than at the top so that reading or comparing a record, which is all the
  // unit tests do, never loads a browser driver.
  const { chromium } = await import("@playwright/test");
  const { renderCanary } = await import("./canary");
  const browser = await chromium.launch();
  try {
    const canary = await renderCanary(browser);
    return {
      canary: {
        pixelSha256: canary.pixelSha256,
        sourceSha256: canary.sourceSha256,
        width: canary.width,
        height: canary.height,
      },
      recordedOn: now.toISOString(),
      ...currentEnvironment(),
    };
  } finally {
    await browser.close();
  }
}

export interface RendererCheckOptions {
  file?: string;
  /** A plain record, not `NodeJS.ProcessEnv`, so a test can hand it exactly the one key it reads. */
  env?: Readonly<Record<string, string | undefined>>;
  measure?: () => Promise<RendererRecord>;
}

/**
 * Throws one message on anything but a match. It runs before the database is seeded: the
 * answer takes about a second, and every minute the suite spends after a renderer change is a
 * minute spent producing failures that are not about the change under test.
 */
export async function assertRendererMatchesBaselines(
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
  if (recorded === null) {
    throw new Error(rendererMismatchMessage("unrecorded", null, current, file));
  }
  const verdict = compareRecord(recorded, current);
  if (verdict !== "match") {
    throw new Error(rendererMismatchMessage(verdict, recorded, current, file));
  }
  return { verdict, recorded, current };
}

/** The one line global-setup prints, so the log says which renderer a run was judged on. */
export function describeRendererCheck(check: RendererCheck): string {
  if (check.verdict === "skipped") {
    return (
      `[e2e setup] renderer check SKIPPED (${RENDERER_CHECK_ENV}=skip): a wide spread of visual ` +
      "failures in this run may be the machine, not the change."
    );
  }
  return `[e2e setup] renderer matches the baselines' — ${oneLineRenderer(check.current)}`;
}
