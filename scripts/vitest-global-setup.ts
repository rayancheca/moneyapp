import { assertQuietBox } from "./quiet-box";

/**
 * Refuse to start the unit suite on a machine that is already saturated.
 *
 * 🔴 Three consecutive full runs on a box at load 44 failed a DIFFERENT set of
 * files each time — 4, then 8, then 9 — and every one of them passed alone.
 * Worse, the reported test COUNT moved with them (4,349 / 4,396 / 4,408): a
 * file that dies in `beforeEach` never registers its tests, so the run that
 * looked most nearly green was measuring the least. A suite whose totals move
 * with the weather cannot be used to decide anything.
 *
 * ⚠️ Escape hatch on purpose. Sometimes the box is busy because something else
 * important is running and you want the answer anyway — `VITEST_ALLOW_LOAD=1`.
 * What must not happen is spending an hour reading real-looking failures.
 */
export default function setup(): void {
  const load = assertQuietBox({ suite: "vitest", escapeHatch: "VITEST_ALLOW_LOAD" });
  if (load.verdict !== "quiet") {
    console.warn(
      `[vitest] load average ${load.load1.toFixed(1)} across ${load.cores} cores — a timeout in this run is ` +
        "more likely the machine than the code. Check `uptime` before believing a failure.",
    );
  }
}
