/**
 * Re-runs the calibration behind `diffVerdict` and prints the table its limits come from.
 *
 *   tsx scripts/e2e-renderer/calibrate-diff-verdict.ts          # 523 pairs, about 4 minutes
 *   tsx scripts/e2e-renderer/calibrate-diff-verdict.ts --all    # 1,304 pairs, about 7
 *
 * Every pair comes out of git, so any checkout reproduces the same numbers:
 *
 *   renderer   c3b9a59 re-based 111 baselines for macOS 27.2's text antialiasing and nothing
 *              else — proved by failing the same gate on the commit before it, then checked
 *              file by file. Each pair is <c3b9a59~1:path, c3b9a59:path>. All must be
 *              renderer-only.
 *   content    commits that regenerated baselines for a real UI change, every one of them read
 *              before it was committed. Only commits since 803eeb2 count: before it the gate
 *              tolerated a pixel ratio, so a regenerated file could carry unexplained noise.
 *              All must be content.
 *   synthetic  real baselines at c3b9a59 edited the way a UI change edits a page: text moved a
 *              pixel, digits swapped, a money amount's "," and "." swapped, text re-coloured,
 *              dimmed by a tenth (opacity 0.9) or given the next colour token, a region erased,
 *              a panel tinted, a page one pixel taller. Each edit is judged twice: against the
 *              unedited baseline, and against the pre-upgrade one — an OS upgrade and a real
 *              change landing in the same run, which is the case the rebase command exists to
 *              refuse. All must be content.
 *
 * Exits 1 when any pair gets the wrong verdict, so a change to the rule can be gated on it.
 * It reads the measured values out of each verdict's reasons rather than measuring twice.
 */
import { execFileSync } from "node:child_process";
import {
  decodePng,
  diffVerdict,
  INK_MEASURES,
  type DiffVerdict,
  type RawImage,
} from "./diff-verdict";
import { CONTRAST_FLOOR } from "./ink-shift";

const RENDERER_COMMIT = "c3b9a59";
/** The first commit that gated at `maxDiffPixels: 0`; `--all` takes every one from here on. */
const ZERO_TOLERANCE_SINCE = "803eeb2";
/**
 * Ten commits, 242 modified baselines, holding the closest calls in the whole zero-tolerance
 * history — b84b531's notices moved exactly one pixel (1/3, 1.85x the fine limit), 66b5a80's
 * count "9" -> "8" and e818154's re-drawn faint ghost line (1.93x) — and the copy, layout and
 * chart changes around them.
 */
const CONTENT_COMMITS = [
  "66b5a80", "e818154", "b84b531", "14759a7", "803eeb2",
  "d2a94b5", "4c9516b", "991d9dc", "d648ecd", "e94f1ad",
];

type Expect = "renderer-only" | "content";

interface Row {
  set: "renderer" | "content" | "synthetic" | "probe";
  label: string;
  expect: Expect | null;
  verdict: DiffVerdict;
  /** each ink measure's value, read from the verdict's reasons; empty when size decided */
  ink: Map<string, number>;
}

const BASELINE = /^e2e\/.+-snapshots\/.+\.png$/;

function git(args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: 512 * 1024 * 1024 });
}

/** Baselines a commit modified (added and deleted ones have nothing to compare). */
function modifiedBaselines(commit: string): string[] {
  return git(["diff-tree", "-r", "--no-commit-id", "--name-status", commit])
    .toString()
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([status, file]) => status === "M" && BASELINE.test(file ?? ""))
    .map(([, file]) => file!);
}

function zeroToleranceCommits(): string[] {
  const range = `${ZERO_TOLERANCE_SINCE}~1..${RENDERER_COMMIT}~1`;
  return git(["log", "--format=%h", range, "--", "e2e/*-snapshots/*.png"])
    .toString()
    .trim()
    .split("\n");
}

async function atRevision(rev: string, file: string): Promise<RawImage> {
  return decodePng(git(["show", `${rev}:${file}`]));
}

function row(set: Row["set"], label: string, expect: Expect | null, verdict: DiffVerdict): Row {
  const ink = new Map<string, number>();
  for (const reason of verdict.reasons) {
    const hit = /^(ink-\w+) (\d+\.\d+) /.exec(reason);
    if (hit) ink.set(hit[1]!, Number(hit[2]));
  }
  return { set, label, expect, verdict, ink };
}

async function historyRows(set: "renderer" | "content", commits: string[], expect: Expect) {
  const rows: Row[] = [];
  for (const commit of commits) {
    for (const file of modifiedBaselines(commit)) {
      const before = await atRevision(`${commit}~1`, file);
      const verdict = diffVerdict(before, await atRevision(commit, file));
      const name = file.replace(/^e2e\//, "").replace(/-chromium-darwin\.png$/, "");
      rows.push(row(set, `${commit} ${name}`, expect, verdict));
      // a pair of full pages takes about a second; say so often enough to show it is moving
      if (rows.length % 20 === 0) process.stderr.write(`  ${set}: ${rows.length} pairs\n`);
    }
  }
  process.stderr.write(`  ${set}: ${rows.length} pairs from ${commits.length} commits\n`);
  return rows;
}

// ---------------------------------------------------------------- synthetic edits

type Rect = { x: number; y: number; w: number; h: number };
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/**
 * Places on accounts-{dark,light}-1440, which share one layout. Each was measured on the
 * baseline: the faint ones are the page's --ink-faint text, (144,140,133) on (33,28,22) in dark.
 */
const SITES = {
  asOf: { at: rect(266, 325, 199, 17), what: '"as of Jul 5, 2026 · net of what you owe"' },
  cardType: { at: rect(320, 388, 104, 18), what: '"Credit card · ····1111"' },
  footer: { at: rect(17, 1770, 178, 33), what: '"Local-first · your data never leaves this Mac"' },
  amount: { at: rect(1302, 303, 88, 21), what: '"$50,701.47"' },
  heading: { at: rect(245, 97, 112, 30), what: 'the "Accounts" heading' },
  nav: { at: rect(45, 80, 72, 20), what: 'the "Dashboard" nav label' },
  body: { at: rect(245, 134, 596, 58), what: "the intro paragraph" },
  chevrons: { at: rect(294, 375, 12, 24), what: "the faint reorder chevrons" },
  pencil: { at: rect(1366, 374, 26, 26), what: "the edit pencil" },
  card: { at: rect(250, 293, 1156, 60), what: "the Chase card's header band" },
} as const;

/** Two cells of the monospaced "$50,701.47": 5 and 7, then 0 and 1. */
const DIGIT_SWAPS = [
  { a: rect(1313, 304, 8, 19), bx: 1338, what: '"$50,701.47" -> "$70,501.47"' },
  { a: rect(1321, 304, 8, 19), bx: 1355, what: '"$50,701.47" -> "$51,700.47"' },
];

/**
 * The "," and "." cells of two `.figures` amounts, each cell one advance of the monospaced face
 * wide and holding nothing of its neighbours: the 14px "$1,041.29" on accounts, and on
 * transactions (light) the 11px day total "-$2,249.09", whose comma's tail is 1.2 px² of ink.
 */
const SEPARATORS = {
  accounts: { comma: rect(1290, 380, 7, 17), periodX: 1323, what: '"$1,041.29"' },
  transactions: { comma: rect(1346, 1147, 6, 13), periodX: 1372, what: '"-$2,249.09"' },
};
const TRANSACTIONS = "e2e/visual.spec.ts-snapshots/transactions-light-1440-chromium-darwin.png";

/**
 * New ink colours for faint dark-mode text: the theme's accent and negative, a blue of the same
 * luminance as the grey, and the grey 30 levels either way. Four of the five move no pixel
 * further than the 76 levels the renderer drift did, so a per-pixel maximum cannot see them.
 */
const RECOLOURS: [string, number[]][] = [
  ["accent green", [95, 196, 160]],
  ["negative red", [222, 117, 100]],
  ["blue of equal luminance", [120, 140, 190]],
  ["30 levels brighter", [175, 170, 163]],
  ["30 levels dimmer", [115, 110, 103]],
];
/**
 * New ink colours for faint light-mode text: the theme's accent and negative, as
 * src/app/globals.css's oklch renders them in sRGB.
 */
const LIGHT_RECOLOURS: [string, number[]][] = [
  ["accent green", [0, 101, 72]],
  ["negative red", [178, 65, 51]],
];

/**
 * --ink-faint to --ink-muted, the smallest step between two text tokens: 11% more contrast in
 * light, 16% in dark. Rendered in sRGB from src/app/globals.css's oklch.
 */
const FAINT_TO_MUTED: Record<"dark" | "light", [from: number[], to: number[]]> = {
  light: [
    [109, 104, 97],
    [93, 87, 80],
  ],
  dark: [
    [144, 140, 133],
    [162, 158, 151],
  ],
};

/** Text the rule must see re-toned however little ink it has: small and faint up to a heading. */
const TONED = ["asOf", "cardType", "footer", "amount", "heading", "body"] as const;

const copy = (img: RawImage): RawImage => ({ ...img, data: new Uint8Array(img.data) });

/** Sets each pixel of `r` in a copy: `k` is its first byte, in the copy's `out` and in `img`. */
type PixelEdit = (x: number, y: number, out: Uint8Array, k: number) => void;

function edit(img: RawImage, r: Rect, pixel: PixelEdit): RawImage {
  const out = copy(img);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) pixel(x, y, out.data, (y * img.width + x) * 4);
  }
  return out;
}

/** The most common colour in a rectangle: the background text sits on. */
function background(img: RawImage, r: Rect): number[] {
  const counts = new Map<number, number>();
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = (y * img.width + x) * 4;
      const key = (img.data[k]! << 16) | (img.data[k + 1]! << 8) | img.data[k + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const [key] = [...counts.entries()].reduce((p, q) => (q[1] > p[1] ? q : p));
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255];
}

/** Moves the content of `r` by (dx, dy); the strip it leaves is filled from just outside it. */
function shift(img: RawImage, r: Rect, dx: number, dy: number): RawImage {
  return edit(img, r, (x, y, out, k) => {
    const from = ((y - dy) * img.width + x - dx) * 4;
    out.set(img.data.subarray(from, from + 4), k);
  });
}

function swap(img: RawImage, a: Rect, bx: number): RawImage {
  const out = copy(img);
  for (let y = a.y; y < a.y + a.h; y++) {
    const p = (y * img.width + a.x) * 4;
    const q = (y * img.width + bx) * 4;
    out.data.set(img.data.subarray(q, q + a.w * 4), p);
    out.data.set(img.data.subarray(p, p + a.w * 4), q);
  }
  return out;
}

/**
 * Re-inks anti-aliased text the way a colour change of another hue does: each pixel keeps its
 * coverage (its position between the background and the darkest-or-brightest ink pixel) and
 * blends toward the new colour instead.
 */
function recolour(img: RawImage, r: Rect, ink: number[]): RawImage {
  const bg = background(img, r);
  let fg = bg;
  let far = -1;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = (y * img.width + x) * 4;
      const d = Math.hypot(...bg.map((b, c) => img.data[k + c]! - b));
      if (d > far) [far, fg] = [d, [...img.data.subarray(k, k + 3)]];
    }
  }
  const axis = fg.map((f, c) => f - bg[c]!);
  const length2 = axis.reduce((s, t) => s + t * t, 0);
  return edit(img, r, (_x, _y, out, k) => {
    const along = axis.reduce((s, t, c) => s + t * (img.data[k + c]! - bg[c]!), 0) / length2;
    const coverage = Math.max(0, Math.min(1, along));
    for (let c = 0; c < 3; c++) out[k + c] = Math.round(bg[c]! + coverage * (ink[c]! - bg[c]!));
  });
}

/**
 * Moves each pixel's colour toward the background, or away from it, by a factor per channel:
 * what `opacity` does to text, and a token swap of the same hue. Coverage stays exact, where
 * recolour's is relative to the darkest pixel of the rectangle.
 */
function reink(img: RawImage, r: Rect, factor: readonly number[]): RawImage {
  const bg = background(img, r);
  return edit(img, r, (_x, _y, out, k) => {
    for (let c = 0; c < 3; c++) {
      const v = bg[c]! + (img.data[k + c]! - bg[c]!) * factor[c]!;
      out[k + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  });
}

/** The factor per channel that turns `from` into `to` on the background of `r`. */
function tokenFactor(img: RawImage, r: Rect, [from, to]: [number[], number[]]): number[] {
  const bg = background(img, r);
  return [0, 1, 2].map((c) => (to[c]! - bg[c]!) / (from[c]! - bg[c]!));
}

/** Copies the cell at `a` over the cell at `bx` on the same rows: one glyph for another. */
function copyCell(img: RawImage, a: Rect, bx: number): RawImage {
  const out = copy(img);
  for (let y = a.y; y < a.y + a.h; y++) {
    const p = (y * img.width + a.x) * 4;
    out.data.set(img.data.subarray(p, p + a.w * 4), (y * img.width + bx) * 4);
  }
  return out;
}

/** A separator swapped both ways, then each way alone: "1.041,29", "1.041.29", "1,041,29". */
function separatorEdits(sep: (typeof SEPARATORS)[keyof typeof SEPARATORS]): Edit[] {
  const period = { ...sep.comma, x: sep.periodX };
  return [
    [`${sep.what}: "," and "." swapped`, (now) => swap(now, sep.comma, sep.periodX)],
    [`${sep.what}: "," made "."`, (now) => copyCell(now, period, sep.comma.x)],
    [`${sep.what}: "." made ","`, (now) => copyCell(now, sep.comma, sep.periodX)],
  ];
}

function erase(img: RawImage, r: Rect): RawImage {
  const bg = background(img, r);
  return edit(img, r, (_x, _y, out, k) => out.set(bg, k));
}

function tint(img: RawImage, r: Rect, by: number): RawImage {
  return edit(img, r, (_x, _y, out, k) => {
    for (let c = 0; c < 3; c++) out[k + c] = Math.max(0, Math.min(255, img.data[k + c]! + by));
  });
}

/** One row repeated at `at`: everything below moves down a pixel and the page grows by one. */
function tallerAt(img: RawImage, at: number): RawImage {
  const rowBytes = img.width * 4;
  const data = new Uint8Array(img.data.length + rowBytes);
  data.set(img.data.subarray(0, (at + 1) * rowBytes), 0);
  data.set(img.data.subarray(at * rowBytes), (at + 1) * rowBytes);
  return { width: img.width, height: img.height + 1, data };
}

/** An edit is built only when it is judged: each is a full-page copy, 10 MB at 1440x1817. */
type Edit = [what: string, make: (now: RawImage) => RawImage];

function editsFor(theme: "dark" | "light"): Edit[] {
  const toned = TONED.map((s): Edit => [
    `${SITES[s].what} a tenth dimmer (opacity 0.9)`,
    (now) => reink(now, SITES[s].at, [0.9, 0.9, 0.9]),
  ]);
  const muted = (["asOf", "cardType", "footer"] as const).map((s): Edit => [
    `${SITES[s].what} --ink-faint -> --ink-muted`,
    (now) => reink(now, SITES[s].at, tokenFactor(now, SITES[s].at, FAINT_TO_MUTED[theme])),
  ]);
  const edits: Edit[] = [
    ...separatorEdits(SEPARATORS.accounts),
    ...toned,
    ...muted,
    ...(["asOf", "cardType", "footer", "amount", "nav"] as const).map(
      (s): Edit => [`${SITES[s].what} 1px right`, (now) => shift(now, SITES[s].at, 1, 0)],
    ),
    ...(["asOf", "heading", "body"] as const).map(
      (s): Edit => [`${SITES[s].what} 1px down`, (now) => shift(now, SITES[s].at, 0, 1)],
    ),
    ...DIGIT_SWAPS.map((d): Edit => [`digits swapped: ${d.what}`, (now) => swap(now, d.a, d.bx)]),
    ...(["chevrons", "pencil", "nav"] as const).map(
      (s): Edit => [`${SITES[s].what} erased`, (now) => erase(now, SITES[s].at)],
    ),
    [`"what you owe" erased`, (now) => erase(now, rect(386, 326, 78, 15))],
    [`${SITES.card.what} tinted 6 levels`, (now) => tint(now, SITES.card.at, 6)],
    [`${SITES.card.what} tinted -3 levels`, (now) => tint(now, SITES.card.at, -3)],
  ];
  const hues = theme === "light" ? LIGHT_RECOLOURS : RECOLOURS;
  for (const [name, ink] of hues) {
    for (const s of ["asOf", "cardType", "footer"] as const) {
      edits.push([`${SITES[s].what} recoloured ${name}`, (now) => recolour(now, SITES[s].at, ink)]);
    }
  }
  return edits;
}

/**
 * A twentieth dimmer (opacity 0.95): half the smallest re-toning the rule exists to catch. It is
 * printed as the edge of what ink-tone sees and not asserted either way.
 */
const PROBE_DIM = [0.95, 0.95, 0.95];

async function syntheticRows(): Promise<Row[]> {
  const rows: Row[] = [];
  const judge = (label: string, expect: Expect | null, from: RawImage, to: RawImage) => {
    rows.push(row(expect === null ? "probe" : "synthetic", label, expect, diffVerdict(from, to)));
  };
  const judgeEdits = (label: string, now: RawImage, before: RawImage, edits: Edit[]) => {
    for (const [what, make] of edits) {
      const edited = make(now);
      judge(`${label} ${what}`, "content", now, edited);
      judge(`${label} ${what} + OS drift`, "content", before, edited);
    }
  };
  for (const theme of ["dark", "light"] as const) {
    const file = `e2e/visual.spec.ts-snapshots/accounts-${theme}-1440-chromium-darwin.png`;
    const now = await atRevision(RENDERER_COMMIT, file);
    const before = await atRevision(`${RENDERER_COMMIT}~1`, file);
    judgeEdits(theme, now, before, editsFor(theme));
    const taller: [string, number][] = [
      ["a row repeated at y=600", 600],
      ["the last row repeated", now.height - 1],
    ];
    for (const [where, at] of taller) {
      judge(`${theme} 1px taller: ${where}`, "content", now, tallerAt(now, at));
    }
    for (const s of ["asOf", "cardType", "footer"] as const) {
      const edited = reink(now, SITES[s].at, PROBE_DIM);
      judge(`${theme} ${SITES[s].what} a twentieth dimmer (opacity 0.95)`, null, now, edited);
    }
    process.stderr.write(`  synthetic ${theme}: ${rows.length} pairs so far\n`);
  }
  const now = await atRevision(RENDERER_COMMIT, TRANSACTIONS);
  const before = await atRevision(`${RENDERER_COMMIT}~1`, TRANSACTIONS);
  judgeEdits("light transactions", now, before, separatorEdits(SEPARATORS.transactions));
  process.stderr.write(`  synthetic transactions: ${rows.length} pairs so far\n`);
  return rows;
}

// ---------------------------------------------------------------- the table

const LIMIT = new Map(INK_MEASURES.map((m) => [m.id as string, m.limit]));
const fmt = (v: number) => v.toFixed(4);
const pad = (s: string | number, n: number) => String(s).padEnd(n);

/** How far past (>1) or short of (<1) its limit the strongest ink measure of a row is. */
function excess(r: Row): number {
  return Math.max(...[...r.ink].map(([id, v]) => v / LIMIT.get(id)!));
}

const SETS = ["renderer", "content", "synthetic"] as const;

/** One line per set: its verdicts, each measure's worst (renderer) or weakest (content) value. */
function printSummary(rows: Row[]): void {
  const scales = INK_MEASURES.map((m) => `${m.id} ${m.limit} (${m.shape})`);
  const floor = `contrast floor ${CONTRAST_FLOOR}`;
  console.log(`\ndiffVerdict calibration — ${scales.join(", ")}, ${floor}\n`);
  const scaleHeads = INK_MEASURES.map((m) => pad(m.id, 22)).join("");
  console.log(`${pad("set", 10)}${pad("pairs", 7)}${pad("verdicts", 36)}${scaleHeads}max px delta`);
  for (const set of SETS) {
    const of = rows.filter((r) => r.set === set);
    if (of.length === 0) continue;
    const counts = new Map<string, number>();
    for (const r of of) counts.set(r.verdict.verdict, (counts.get(r.verdict.verdict) ?? 0) + 1);
    const bySize = of.filter((r) => r.verdict.metrics.decidingMeasure === "size").length;
    const verdicts = [...counts].map(([v, n]) => `${n} ${v}`).join(", ");
    const measured = of.filter((r) => r.ink.size > 0);
    const verdictCell = pad(verdicts + (bySize ? ` (${bySize} by size)` : ""), 36);
    if (measured.length === 0) {
      console.log(`${pad(set, 10)}${pad(of.length, 7)}${verdictCell}`);
      continue;
    }
    const cells = INK_MEASURES.map((s) => {
      const values = measured.map((r) => r.ink.get(s.id)!);
      if (set !== "renderer") return pad(`min ${fmt(Math.min(...values))}`, 22);
      const worst = Math.max(...values);
      const under = worst === 0 ? "none" : `${(s.limit / worst).toFixed(2)}x`;
      return pad(`max ${fmt(worst)} (${under})`, 22);
    }).join("");
    const deltas = measured.map((r) => r.verdict.metrics.maxDelta);
    const delta = `${Math.min(...deltas)}..${Math.max(...deltas)}`;
    console.log(`${pad(set, 10)}${pad(of.length, 7)}${verdictCell}${cells}${delta}`);
  }
}

/** Each set's margin and the five pairs that came closest to the other verdict. */
function printMargins(rows: Row[]): void {
  console.log("\nmargins — a renderer pair's is limit / value; a content pair's is how far its");
  console.log("strongest measure goes past its limit. Size-decided pairs have none.");
  for (const set of SETS) {
    const measured = rows.filter((r) => r.set === set && r.ink.size > 0);
    if (measured.length === 0) continue;
    const sign = set === "renderer" ? -1 : 1;
    const closest = [...measured].sort((p, q) => sign * (excess(p) - excess(q)));
    const margin = excess(closest[0]!) ** sign;
    console.log(`\n  ${set}: margin ${margin.toFixed(2)}x — closest calls`);
    for (const r of closest.slice(0, 5)) {
      const values = [...r.ink].map(([id, v]) => `${id} ${fmt(v)}`).join("  ");
      console.log(`    ${excess(r).toFixed(2)}  ${values}  ${r.label}`);
    }
  }
}

function printProbesAndMistakes(rows: Row[]): Row[] {
  const probes = rows.filter((r) => r.set === "probe");
  if (probes.length > 0) {
    console.log("\nthe edge, not asserted — text a twentieth dimmer, half the smallest re-toning:");
    for (const r of probes) {
      console.log(`    ${excess(r).toFixed(2)}  ${r.verdict.verdict.padEnd(13)} ${r.label}`);
    }
  }
  const wrong = rows.filter((r) => r.expect !== null && r.verdict.verdict !== r.expect);
  const allRight = "every pair got its expected verdict";
  console.log(`\n${wrong.length === 0 ? allRight : `${wrong.length} WRONG:`}`);
  for (const r of wrong) {
    console.log(`  expected ${r.expect}, got ${r.verdict.verdict}: ${r.label}`);
    for (const reason of r.verdict.reasons) console.log(`      ${reason}`);
  }
  return wrong;
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const started = Date.now();
  const rows = [
    ...(await historyRows("renderer", [RENDERER_COMMIT], "renderer-only")),
    ...(await historyRows("content", all ? zeroToleranceCommits() : CONTENT_COMMITS, "content")),
    ...(await syntheticRows()),
  ];
  printSummary(rows);
  printMargins(rows);
  const wrong = printProbesAndMistakes(rows);
  console.log(`\n${rows.length} pairs in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exitCode = wrong.length === 0 ? 0 : 1;
}

await main();
