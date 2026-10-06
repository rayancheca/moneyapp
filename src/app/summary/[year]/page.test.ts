import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⛔ THE GAMBLING BLOCK'S SENTENCE AND WINDOW ARE THE SERVICE'S. `gamblingNote` says its losses sit inside the figure
 * under What you spent, and on a running year that is true over What you spent's own days alone — the days the block
 * reads (`gamblingFor`) and names. 🔴 The sentence was a literal here while the block read Jan 1 – Dec 31, so a loss
 * past the day every account you spend from has been imported through was in Lost and in no Spent.
 *
 * A source gate, like the other pages': the page is an async server component that reads the database.
 */
const source = fs.readFileSync(path.join(process.cwd(), "src/app/summary/[year]/page.tsx"), "utf8");

describe("the gambling block says what the service measured", () => {
  test("its sentence is gamblingNote's, never a literal", () => {
    expect(source).toMatch(/\{gamblingNote\(gambling, spending !== null\)\}/);
    expect(source).not.toContain("sit inside the figure under What you spent");
  });

  /*
   * 🔴 "What you spent" prints only when the year measured spending (`spending && <YearSpendingCard …>`), and the block
   * whenever it holds a row: a year of one win read "they sit inside the figure under What you spent" with no such
   * figure on the page, and Lost "−$0.00". The sentence is told whether the figure is there; Lost is the service's.
   */
  test("it is told whether What you spent is on the page, and Lost is gamblingLostFigure's", () => {
    expect(source).toMatch(/\{spending && <YearSpendingCard view=\{spending\} \/>\}/);
    expect(source).toContain("{gamblingLostFigure(gambling.lostCents)}");
    expect(source).not.toMatch(/−\{formatCents/);
  });

  test("a block cut short names its window beside the heading", () => {
    expect(source).toMatch(/\{gambling\.window\?\.truncated && \(/);
    expect(source).toContain("{gambling.window.label}");
  });
});
