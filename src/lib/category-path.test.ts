import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { formatCategoryPath, PATH_SEPARATOR } from "./category-path";

describe("formatCategoryPath", () => {
  test("a subcategory reads 'Parent > Child'", () => {
    expect(formatCategoryPath("Food", "Dining")).toBe("Food > Dining");
    expect(formatCategoryPath("Car", "Car Insurance")).toBe("Car > Car Insurance");
  });

  test("a top-level category reads bare, whether its parent is null or absent from a lookup", () => {
    expect(formatCategoryPath(null, "Shopping")).toBe("Shopping");
    expect(formatCategoryPath(undefined, "Shopping")).toBe("Shopping");
  });

  test("the separator is the one the notes punctuate a path with", () => {
    expect(formatCategoryPath("A", "B")).toBe(`A${PATH_SEPARATOR}B`);
  });
});

/**
 * Whether a source file joins two names around the path separator in CODE: a template `${a} > ${b}`, a template
 * holding `${PATH_SEPARATOR}`, or " > " / PATH_SEPARATOR as an operand of + or the argument of a join. A literal path
 * ("Food > Dining" in a bank-bucket map), a split(" > ") that PARSES one, and a comment naming one are not printers.
 */
function printsCategoryPath(source: string, fileName: string): boolean {
  if (!source.includes(" > ") && !source.includes("PATH_SEPARATOR")) return false;
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const isSeparator = (node: ts.Node): boolean =>
    (ts.isStringLiteralLike(node) && node.text === " > ") || (ts.isIdentifier(node) && node.text === "PATH_SEPARATOR");
  const isSplitArgument = (node: ts.Node): boolean =>
    ts.isCallExpression(node.parent) &&
    ts.isPropertyAccessExpression(node.parent.expression) &&
    node.parent.expression.name.text === "split";
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTemplateMiddle(node) && node.text === " > ") found = true;
    else if (ts.isTemplateSpan(node) && isSeparator(node.expression)) found = true;
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      found = isSeparator(node.left) || isSeparator(node.right);
    } else if (ts.isStringLiteral(node) && node.text === " > " && !isSplitArgument(node)) found = true;
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      found = node.expression.name.text === "join" && node.arguments.some(isSeparator);
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * ⛔ ONE HOME. The "Parent > Child" path was printed inline sixteen times in twelve modules — the merge confirmation,
 * /budgets, the picker, the palette, the review inbox, the rule sentences, the import-hint guards — and the review of
 * §6A 54 (2026-10-08) caught the merge's `categoryPathOf` as one more. A copy that drifts (a separator, an archived
 * parent, a root printed as " > Name") makes two surfaces name one category two ways. Every one goes through
 * `formatCategoryPath` now; a seventeenth inline copy fails here.
 */
describe("the category path has one printer", () => {
  test("no other source file prints 'Parent > Child' itself", () => {
    const src = path.join(process.cwd(), "src");
    const home = path.join(src, "lib", "category-path.ts");
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && full !== home) {
          scanned++;
          if (printsCategoryPath(fs.readFileSync(full, "utf8"), full)) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    // guards the guard: a walk that read nothing would pass vacuously, and the home itself must read as a printer
    expect(scanned).toBeGreaterThan(100);
    expect(printsCategoryPath(fs.readFileSync(home, "utf8"), home)).toBe(true);
    expect(offenders).toEqual([]);
  });

  describe("the guard reads code, not comments or data", () => {
    test.each([
      ["a template", "export const p = (a: string, b: string) => `${a} > ${b}`;"],
      ["a template inside a sentence", "export const p = (a: string, b: string) => `Filed under ${a} > ${b}.`;"],
      ["the shared separator in a template", "export const p = (a: string, b: string) => `${a}${PATH_SEPARATOR}${b}`;"],
      ["a string joined with +", 'export const p = (a: string, b: string) => a + " > " + b;'],
      ["the shared separator joined with +", "export const p = (a: string, b: string) => a + PATH_SEPARATOR + b;"],
      ["an array join", 'export const p = (a: string, b: string) => [a, b].join(" > ");'],
      ["JSX text", 'export const P = ({ a, b }: { a: string; b: string }) => <>{a}{" > "}{b}</>;'],
    ])("it finds the printer spelled as %s", (_, code) => {
      expect(printsCategoryPath(code, "planted.tsx")).toBe(true);
    });

    test.each([
      ["a comment", '// prints "Food > Dining" as `${parent} > ${child}`\nexport const x = 1;'],
      ["a literal path", 'export const MAP = { GROCERIES: "Food > Groceries" };'],
      ["a parser", 'export const parse = (p: string) => p.split(" > ");'],
      ["a comparison", "export const more = (a: number, b: number) => a > b;"],
      ["a sentence with a literal before the arrow", "export const m = (n: number) => `must be > ${n}`;"],
    ])("it passes %s", (_, code) => {
      expect(printsCategoryPath(code, "planted.ts")).toBe(false);
    });
  });
});
