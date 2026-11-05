import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vitest";

/**
 * ⛔ A test file is not the app. Tailwind v4 makes CSS of every class-shaped string in every file git does not ignore,
 * and a test's strings became CSS on every page. 🔴 CardDeck.test.ts's list of what a card behind the front must never
 * carry put five rules nothing uses into the app's CSS (the review of d27f4f8f); merchant ids, a test's name and an
 * error message put four more, and the token names globals.test.ts reads kept four theme variables nothing reads —
 * 981 rules compiled, 972 with the test files hidden (measured 2026-10-30).
 *
 * So globals.css keeps every `*.test.ts` out of the scan, and this compiles it the way `@tailwindcss/postcss` does,
 * twice — as shipped, and with the test files hidden here — and the two must match line for line.
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

test("⛔ no test file adds anything to the app's CSS", async () => {
  const shipped = fs.readFileSync(from, "utf8");
  const hidden = shipped.replace('@import "tailwindcss";', '@import "tailwindcss";\n@source not "../../**/*.test.ts";');
  expect(hidden, 'globals.css no longer starts from @import "tailwindcss"').not.toBe(shipped);

  const asShipped = await linesOf(shipped, from);
  // ⚠️ under a second name in the same folder: the plugin keeps a compile by its file's name, and an `@source` path is
  // read from the file's folder
  const withoutTests = await linesOf(hidden, path.join(root, "src/app/globals.without-tests.css"));
  // guards the guard: a compile that found none of the app's own utilities proves nothing
  expect(withoutTests).toContain(".text-ink-muted {");
  expect([...asShipped].filter((line) => !withoutTests.has(line))).toEqual([]);
});
