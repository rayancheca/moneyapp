import { beforeEach, describe, expect, test, vi } from "vitest";

// the server actions pull in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({
  attachToSeriesAction: vi.fn(),
  createSeriesFromTxnAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  undoCreateSeriesAction: vi.fn(),
}));
vi.mock("@/app/transactions/actions", () => ({
  linkTransferAction: vi.fn(),
  undoAction: vi.fn(),
  unlinkTransferAction: vi.fn(),
}));
vi.mock("@/app/transactions/sheet-actions", () => ({ loadSeriesLinkPanel: vi.fn(), loadTransferLinkPanel: vi.fn() }));
// the toasts a press raises, read as raised
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));
vi.mock("./undo-toast", () => ({ offerUndoToast: vi.fn() }));

const { pressMakeRecurring, pressSheetAttach } = await import("./LinkPanels");
const { attachToSeriesAction, createSeriesFromTxnAction } = await import("@/app/recurring/actions");
const { toast } = await import("@/components/ui/Toast");
const { offerUndoToast } = await import("./undo-toast");

const undo = { rows: [] };
const filed = { categoryId: "c1", categoryPath: "Utilities > Electricity", count: 1 };
const after = { linked: vi.fn(), close: vi.fn(), reset: vi.fn(), onChanged: vi.fn() };

beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(offerUndoToast).mockClear();
  for (const fn of Object.values(after)) fn.mockClear();
});

/*
 * ⚖️ §6A 47: attaching a row not filed yet files it under the series' category — and the toast says so, in the merge
 * toast's own clause (`filedToastTitle`). 🔴 Review of 474e757 (2026-10-12): the transaction sheet's two toasts that
 * name the filing — "Attach" on a candidate, and "Make recurring" joining a live series — were tested only on the
 * label function: `SeriesLinkPanel` could have dropped the clause with every test green. The presses are made here,
 * where the sheet makes them.
 */
describe("the transaction sheet's attach, as SeriesLinkPanel makes it", () => {
  test("its undo toast names what attaching filed, from the attach's own result", async () => {
    vi.mocked(attachToSeriesAction).mockResolvedValue({ ok: true, data: { attached: 1, undo, filed } });

    await pressSheetAttach("t1", "s1", "FPL", after);

    expect(attachToSeriesAction).toHaveBeenLastCalledWith({ seriesId: "s1", transactionIds: ["t1"] });
    expect(offerUndoToast).toHaveBeenCalledWith(
      "Attached to FPL · 1 filed under Utilities > Electricity",
      undo,
      expect.any(Function),
    );
    expect(after.linked).toHaveBeenCalledWith("s1", "FPL");
    expect(after.onChanged).toHaveBeenCalledOnce();
  });

  test("nothing filed — the toast he has always read", async () => {
    vi.mocked(attachToSeriesAction).mockResolvedValue({ ok: true, data: { attached: 1, undo, filed: null } });

    await pressSheetAttach("t1", "s1", "FPL", after);

    expect(offerUndoToast).toHaveBeenCalledWith("Attached to FPL", undo, expect.any(Function));
  });

  test("its undo puts the panel back and re-reads the page", async () => {
    vi.mocked(attachToSeriesAction).mockResolvedValue({ ok: true, data: { attached: 1, undo, filed } });
    await pressSheetAttach("t1", "s1", "FPL", after);
    const undone = vi.mocked(offerUndoToast).mock.calls[0]![2] as () => void;

    undone();

    expect(after.reset).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledTimes(2);
  });

  test("a row no longer active attaches nothing, and says so — no undo offered", async () => {
    vi.mocked(attachToSeriesAction).mockResolvedValue({ ok: true, data: { attached: 0, undo, filed: null } });

    await pressSheetAttach("t1", "s1", "FPL", after);

    expect(toast).toHaveBeenCalledWith({ title: "Couldn’t attach — the transaction is no longer active", tone: "negative" });
    expect(offerUndoToast).not.toHaveBeenCalled();
    expect(after.linked).not.toHaveBeenCalled();
  });
});

describe("the transaction sheet's Make recurring, as SeriesLinkPanel makes it", () => {
  const made = { seriesId: "s1", name: "FPL", linked: 1, undo };

  test("joining a live series: the toast names what joining filed", async () => {
    vi.mocked(createSeriesFromTxnAction).mockResolvedValue({ ok: true, data: { ...made, mode: "attached", filed } });

    await pressMakeRecurring("t1", after);

    expect(createSeriesFromTxnAction).toHaveBeenLastCalledWith({ transactionId: "t1" });
    expect(vi.mocked(toast).mock.calls[0]![0].title).toBe("Attached to FPL · 1 filed under Utilities > Electricity");
    expect(after.linked).toHaveBeenCalledWith("s1", "FPL");
    expect(after.close).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });

  test("a series created — nothing filed, the toast he has always read", async () => {
    vi.mocked(createSeriesFromTxnAction).mockResolvedValue({ ok: true, data: { ...made, mode: "created", filed: null } });

    await pressMakeRecurring("t1", after);

    expect(vi.mocked(toast).mock.calls[0]![0].title).toBe('Marked "FPL" as recurring');
  });
});
