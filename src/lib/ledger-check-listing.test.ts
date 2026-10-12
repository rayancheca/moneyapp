import { describe, expect, test } from "vitest";
import { beyondBackfillsNotice, keptOpeningNotice, listed, namedFiles } from "./ledger-check-listing";

/** The shape the pre-commit hook knows a listing by (scripts/pre-commit-hook.test.ts runs the hook on it). */
describe("a line ledger-check names and fails nothing on", () => {
  test("two spaces, its tag in brackets, its sentence", () => {
    expect(listed("line-left-out, acknowledged", "+$25.00 on 2026-07-01")).toBe("  [line-left-out, acknowledged] +$25.00 on 2026-07-01");
  });

  test("⚠️ before the tag where it warns", () => {
    expect(listed("read at two banks", "x.pdf reads accounts at Robinhood and SoFi", { warns: true })).toBe(
      "  ⚠️ [read at two banks] x.pdf reads accounts at Robinhood and SoFi",
    );
  });
});

/*
 * 🔴 ledger-check built these two sentences inline, so the hook's test stood for them with copies that drifted — the
 * account with no colon after its name, the files beyond the backfills with half their sentence (the handoff of
 * 2026-10-09, §6C). Built here now: the one place the script prints them from and that test derives them from.
 */
describe("the sentences ledger-check builds for what it names", () => {
  test("an account standing only on the opening of a statement he un-imported", () => {
    expect(keptOpeningNotice("Wells Fargo Everyday Checking", "2026-07-01")).toBe(
      "Wells Fargo Everyday Checking: stands only on the opening of a statement you un-imported (2026-07-01) — unchecked, and no witness",
    );
  });

  test("the files read at a version their profile has moved past, and the re-read that records what they print", () => {
    expect(beyondBackfillsNotice([{ fileName: "a.pdf" }, { fileName: "b.pdf" }])).toBe(
      "2 of them were read at a version their profile has moved past (a.pdf, b.pdf) — " +
        "the backfills read a file only at the version that imported it, so they cannot cover these. " +
        "Un-importing any file whose rows one of them also prints loses those rows. " +
        "Re-read them at their profile's version (it refuses unless only the records change):\n" +
        "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger>             # rehearse on a copy, write nothing\n" +
        "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger> --confirm   # restore point, write, re-check",
    );
  });

  test("files are named by the first three, and … past them", () => {
    const files = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map((fileName) => ({ fileName }));
    expect(namedFiles(files.slice(0, 3))).toBe("a.pdf, b.pdf, c.pdf");
    expect(namedFiles(files)).toBe("a.pdf, b.pdf, c.pdf, …");
    expect(beyondBackfillsNotice(files)).toContain("4 of them were read at a version their profile has moved past (a.pdf, b.pdf, c.pdf, …) — ");
  });
});
