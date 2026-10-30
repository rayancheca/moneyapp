import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImportFiling } from "@/services/recurring-links";

/**
 * What each /imports action carries back of what its import filed under a series he confirmed — the service's own
 * answer, read off a stand-in for it here: what the import files, and when, is services/import/import.test.ts's.
 *
 * 🔴 Review of 304c59a4 (2026-10-30): an import's filing was said by the two scripts only. The upload called
 * `importStatementFiles`, which drops the report, and an un-import's restore and a gap acceptance discarded theirs.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/services/import/service", () => ({
  acceptGap: vi.fn(),
  importStatementFilesWithReport: vi.fn(),
  originalOfArchivedCopy: () => undefined,
  unimportFile: vi.fn(),
}));

const { acceptGapResultAction, unimportFileResultAction, uploadStatementsResultAction } = await import("./actions");
const { acceptGap, importStatementFilesWithReport, unimportFile } = await import("@/services/import/service");

/** his weekly pay, as the Wells Fargo statement Sep 25 → Oct 26 would have filed it */
const PAY: ImportFiling = {
  seriesId: "s-pay",
  seriesName: "It America LLC (weekly pay)",
  categoryId: "c-salary",
  categoryPath: "Income > Salary",
  count: 5,
  transactionIds: ["t1", "t2", "t3", "t4", "t5"],
};

function form(entries: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

beforeEach(() => {
  for (const fn of [acceptGap, importStatementFilesWithReport, unimportFile]) vi.mocked(fn).mockReset();
});

describe("each /imports action carries back what its import filed", () => {
  test("an upload: beside each file's outcome", async () => {
    vi.mocked(importStatementFilesWithReport).mockResolvedValueOnce({ outcomes: [], filed: [PAY] });

    const result = await uploadStatementsResultAction(form({ files: new File(["Date,Amount"], "statement.csv") }));

    expect(result).toEqual({ ok: true, data: { outcomes: [], filed: [PAY] } });
  });

  test("an un-import: what its restore filed", async () => {
    vi.mocked(unimportFile).mockReturnValueOnce([PAY]);

    const result = await unimportFileResultAction(form({ importFileId: "f-1" }));

    expect(unimportFile).toHaveBeenCalledWith({}, "f-1");
    expect(result).toEqual({ ok: true, data: { importFileId: "f-1", filed: [PAY] } });
  });

  test("a gap accepted: what the rows it promoted were filed under", async () => {
    vi.mocked(acceptGap).mockReturnValueOnce([PAY]);

    const result = await acceptGapResultAction(form({ statementPeriodId: "p-1" }));

    expect(acceptGap).toHaveBeenCalledWith({}, "p-1");
    expect(result).toEqual({ ok: true, data: { statementPeriodId: "p-1", filed: [PAY] } });
  });
});
