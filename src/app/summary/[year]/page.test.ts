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
    expect(source).toMatch(/\{gamblingNote\(gambling\)\}/);
    expect(source).not.toContain("sit inside the figure under What you spent");
  });

  test("a block cut short names its window beside the heading", () => {
    expect(source).toMatch(/\{gambling\.window\?\.truncated && \(/);
    expect(source).toContain("{gambling.window.label}");
  });
});
