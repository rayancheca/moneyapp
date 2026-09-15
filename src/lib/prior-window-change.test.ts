import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { changeAgainstPrior, changeAgainstPriorText } from "./prior-window-change";

const PHRASE = /\blevel\s+with\b/i;

/**
 * Whether a source file spells the phrase in CODE — a string, a template, JSX
 * text or an attribute — rather than in a comment naming it. Comments are how a
 * fix records the words it replaced, and three do.
 *
 * 🔴 The guard looked for the text `level with ${` alone. An inline copy written
 * as JSX text (`<>level with {priorLabel}</>`, the way the relief's readout
 * writes its "against") or joined with + (`"level with " + priorLabel`) passed
 * it: each was planted in CategoryMassif.tsx on 2026-09-15 and the guard stayed
 * green. It reads the parsed file now.
 */
function spellsLevelWith(source: string, fileName: string): boolean {
  if (!PHRASE.test(source)) return false;
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const text = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node) ? node.text : null;
    if (text !== null && PHRASE.test(text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

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
          if (spellsLevelWith(fs.readFileSync(full, "utf8"), full)) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    // guards the guard: a walk that read nothing would pass vacuously
    expect(scanned).toBeGreaterThan(100);
    expect(spellsLevelWith(fs.readFileSync(home, "utf8"), home)).toBe(true);
    expect(offenders).toEqual([]);
  });

  describe("the guard reads code, not comments", () => {
    test.each([
      ["a template", "export const s = (p: string) => `level with ${p}`;"],
      ["JSX text", "export const A = ({ p }: { p: string }) => <>level with {p}</>;"],
      ["JSX text broken over a line", "export const A = ({ p }: { p: string }) => (\n  <span>\n    level\n    with {p}\n  </span>\n);"],
      ["a string joined with +", 'export const s = (p: string) => "level with " + p;'],
      ["a single-quoted string", "export const s = (p: string) => 'Level with ' + p;"],
      ["an attribute", 'export const A = () => <svg aria-label="level with June 2026" />;'],
    ])("it finds the phrase spelled as %s", (_, code) => {
      expect(spellsLevelWith(code, "planted.tsx")).toBe(true);
    });

    test("a comment naming the phrase is not a copy of it", () => {
      const code = [
        "// was `level with ${priorLabel}`",
        "/* 🔴 \"The 1 height sums to level with May 18, 2023.\" */",
        "export const A = () => <p>{/* level with the window */}ok</p>;",
      ].join("\n");
      expect(spellsLevelWith(code, "planted.tsx")).toBe(false);
    });
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

