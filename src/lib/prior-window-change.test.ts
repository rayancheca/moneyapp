import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { changeAgainstPrior, changeAgainstPriorText } from "./prior-window-change";

/**
 * ⛔ ONE HOME. "level with <prior window>" was spelled inline in three places —
 * the List's phone line, the relief's rail and its description — each beside
 * its own zero test, and the rail's copy had drifted to "on" for a change that
 * was not zero. A fourth inline copy is how that starts again.
 */
describe("the level-with phrase has one home", () => {
  test("no other source file spells it", () => {
    const src = path.join(process.cwd(), "src");
    const home = path.join(src, "lib", "prior-window-change.ts");
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && full !== home) {
          scanned++;
          if (fs.readFileSync(full, "utf8").includes("level with ${")) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    // guards the guard: a walk that read nothing would pass vacuously
    expect(scanned).toBeGreaterThan(100);
    expect(fs.readFileSync(home, "utf8")).toContain("level with ${");
    expect(offenders).toEqual([]);
  });
});

/**
 * The words for a change against the prior window. Every figure below was
 * measured on the owner's ledger 2026-09-15 (read-only): `?period=2022-08-29`
 * Food spent $11.10 against $0.00 on Aug 28, 2022; `?period=2023-05-19` Food
 * spent $18.45 against $18.45 on May 18, 2023; `?period=2026-Q2` Gifts &
 * Donations -$10.40 against Q1 2026.
 */
describe("a change against the prior window, in words", () => {
  test("no change is level with the window, and prints no figure", () => {
    expect(changeAgainstPrior(1_845 - 1_845, "May 18, 2023")).toEqual({ level: true, words: "level with May 18, 2023" });
    expect(changeAgainstPriorText(1_845 - 1_845, "May 18, 2023")).toBe("level with May 18, 2023");
  });

  test("a -0 is no change too, never a figure", () => {
    expect(changeAgainstPrior(-0, "June 2026").level).toBe(true);
    expect(changeAgainstPriorText(-0, "June 2026")).toBe("level with June 2026");
  });

  test("a change is its signed figure against the window", () => {
    expect(changeAgainstPrior(1_110, "Aug 28, 2022")).toEqual({ level: false, words: "against Aug 28, 2022" });
    expect(changeAgainstPriorText(1_110, "Aug 28, 2022")).toBe("+$11.10 against Aug 28, 2022");
    expect(changeAgainstPriorText(-1_040, "Q1 2026")).toBe("-$10.40 against Q1 2026");
  });
});
