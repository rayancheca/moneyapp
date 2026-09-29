import { createRequire } from "node:module";
import path from "node:path";

/**
 * Would the gate itself fail this baseline? Asked of Playwright's own comparator, with the
 * gate's own options, because the gate is not pixel-exact: `maxDiffPixels: 0` counts only pixels
 * past the comparator's colour threshold (0.2 in YIQ by default, about 52 grey levels) that it
 * does not take for anti-aliasing. Measured 2026-09-28: 20 dark pages drawn before macOS 27.2
 * differ from this Mac's drawing by 931 to 6,394 pixels, and the gate calls every one a match.
 *
 * `pnpm e2e:rebase-renderer` judges every pair's pixels, and then re-bases only the renderer
 * drift this comparator fails: a file whose pixels moved within the gate's tolerance is left as
 * it is. The comparator is not a public export, so when a Playwright upgrade moves it the answer
 * is "unknown" rather than a crash, and an unknown file is re-based as though the gate failed it.
 */

export interface GateOptions {
  maxDiffPixels?: number;
  maxDiffPixelRatio?: number;
  threshold?: number;
}

/** true when the gate would fail the drawn image against the baseline */
export type GateFails = (baseline: Buffer, drawn: Buffer) => boolean;

/** What the gate says of one pair; "unknown" when its comparator could not be asked. */
export type GateAnswer = "fails" | "passes" | "unknown";

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

/**
 * Puts one pair to the comparator. It throws on a file it cannot decode as PNG, which sharp may
 * still have read for diffVerdict, so a throw answers "unknown" with its first line instead of
 * stopping the classification. The caller re-bases an unknown file as though the gate failed it.
 */
export function askGate(
  fails: GateFails,
  baseline: Buffer,
  drawn: Buffer,
): { answer: GateAnswer; why?: string } {
  try {
    return { answer: fails(baseline, drawn) ? "fails" : "passes" };
  } catch (error) {
    return { answer: "unknown", why: firstLine(error) };
  }
}

type Comparator = (actual: Buffer, expected: Buffer, options: GateOptions) => unknown;

function isComparatorFactory(value: unknown): value is (mime: string) => Comparator {
  return typeof value === "function";
}

/**
 * Resolved the way the test runner resolves it: @playwright/test → playwright →
 * playwright-core, whose core bundle carries the comparator toHaveScreenshot calls.
 */
export function loadGateComparator(
  options: GateOptions,
): { fails: GateFails } | { unavailable: string } {
  try {
    const require = createRequire(import.meta.url);
    const testPackage = require.resolve("@playwright/test/package.json");
    const runnerPackage = createRequire(testPackage).resolve("playwright/package.json");
    const corePackage = createRequire(runnerPackage).resolve("playwright-core/package.json");
    const bundle: unknown = createRequire(corePackage)(
      path.join(path.dirname(corePackage), "lib", "coreBundle.js"),
    );
    const factory = (bundle as { utils?: { getComparator?: unknown } }).utils?.getComparator;
    if (!isComparatorFactory(factory)) {
      return { unavailable: "playwright-core no longer exports its comparator" };
    }
    const compare = factory("image/png");
    // the comparator answers null for a match and a description of the difference otherwise
    return { fails: (baseline, drawn) => compare(drawn, baseline, options) !== null };
  } catch (error) {
    return { unavailable: firstLine(error) };
  }
}
