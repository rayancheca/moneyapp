import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vitest";

/**
 * ⛔ Only the app makes the app's CSS. Tailwind v4 makes CSS of every class-shaped string in every file git does not
 * ignore, and a test's strings became CSS on every page. 🔴 CardDeck.test.ts's list of what a card behind the front
 * must never carry put five rules nothing uses into the app's CSS (the review of d27f4f8f); merchant ids, a test's name
 * and an error message put four more, and the token names globals.test.ts reads kept four theme variables nothing
 * reads — 981 rules compiled, 972 with the test files hidden (measured 2026-10-30). 🔴 …and the docs put 17 rules
 * nothing uses and 12 theme variables nothing reads on every page — the design directions' `.@container` and
 * `--font-display`, the Markdown's `xl:max-w-7xl` and `pointer-coarse:min-h-11` — while this test hid the test files
 * alone, so it could not see them (the review of 34a96d51): 943 rules, 926 without docs/ and the Markdown (measured
 * 2026-11-05).
 *
 * So globals.css keeps the tests and the docs out of the scan, and this compiles it the way `@tailwindcss/postcss`
 * does, twice — as shipped, and from the app alone: src/, less its tests, its harnesses and its Markdown — and the two
 * must match line for line, both ways. A file outside src/ is not the app (a spec, a script, a doc), and nor is a file
 * in it that only a test reads; and nothing the app writes may be hidden from the scan.
 */

const root = process.cwd();
const from = path.join(root, "src/app/globals.css");

type Postcss = (plugins: unknown[]) => { process(css: string, options: { from: string }): Promise<{ css: string }> };

// postcss is the plugin's own dependency, not the app's: reached from where the plugin sits, as the plugin reaches it
const plugin = createRequire(import.meta.url).resolve("@tailwindcss/postcss");
const postcss = createRequire(plugin)("postcss") as Postcss;
const tailwind = createRequire(plugin)("@tailwindcss/postcss") as (options: object) => unknown;

/** Every line of what the stylesheet compiles to, read as though it sat at `at`. */
async function linesOf(css: string, at: string): Promise<Set<string>> {
  const compiled = await postcss([tailwind({ base: root, optimize: false })]).process(css, { from: at });
  return new Set(compiled.css.split("\n").map((line) => line.trim()));
}

test("⛔ nothing that is not the app adds to the app's CSS, and nothing the app writes is left out", async () => {
  const shipped = fs.readFileSync(from, "utf8");
  // the scan starts at src/, the stylesheet's parent (`source()` is read from the stylesheet's folder), less what is
  // a test's or a doc: the app's own files and nothing else. ⛔ None of the stylesheet's own `@source not` lines: kept
  // here, a line that hid a file of the app's would hide it from both compiles, and nothing would differ.
  const own = shipped.match(/^@source not .*;\n/gm) ?? [];
  expect(own.length, "globals.css hides nothing from the scan").toBeGreaterThan(0);
  const appAlone = own
    .reduce((css, line) => css.replace(line, ""), shipped)
    .replace(
      '@import "tailwindcss";',
      [
        '@import "tailwindcss" source("..");',
        '@source not "../**/*.test.ts";',
        '@source not "../**/*.harness.ts";',
        '@source not "../**/*.md";',
      ].join("\n"),
    );
  expect(appAlone, 'globals.css no longer starts from @import "tailwindcss"').toContain('"tailwindcss" source("..");');

  const asShipped = await linesOf(shipped, from);
  // ⚠️ under a second name in the same folder: the plugin keeps a compile by its file's name, and an `@source` path is
  // read from the file's folder
  const fromTheApp = await linesOf(appAlone, path.join(root, "src/app/globals.app-alone.css"));
  // guards the guard: a compile that found none of the app's own utilities proves nothing
  expect(fromTheApp).toContain(".text-ink-muted {");
  const added = [...asShipped].filter((line) => !fromTheApp.has(line));
  expect(added, "shipped, though no file of the app's writes it").toEqual([]);
  const lost = [...fromTheApp].filter((line) => !asShipped.has(line));
  expect(lost, "written by the app, and missing from what ships").toEqual([]);
});
