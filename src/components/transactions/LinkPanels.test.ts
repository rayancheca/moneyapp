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
const { attachToSeriesAction, createSeriesFromTxnAction, undoCreateSeriesAction } = await import("@/app/recurring/actions");
const { undoAction } = await import("@/app/transactions/actions");
const { toast } = await import("@/components/ui/Toast");
const { offerUndoToast } = await import("./undo-toast");

const undo = { rows: [] };
const filed = { categoryId: "c1", categoryPath: "Utilities > Electricity", count: 1 };
const after = { linked: vi.fn(), close: vi.fn(), reset: vi.fn(), onChanged: vi.fn() };

beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(offerUndoToast).mockClear();
  vi.mocked(undoCreateSeriesAction).mockClear();
  vi.mocked(undoAction).mockClear();
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

  /*
   * 🔴 Review of 0e18e5b (2026-10-13): the toast's Undo was never pressed where the sheet raises it — which undo it
   * calls is chosen by `mode`, and a series created (undone by ending it) or a live series joined (undone by putting
   * the rows' links back) could have swapped undos with every test green.
   */
  const undoOf = async (mode: "created" | "attached") => {
    vi.mocked(createSeriesFromTxnAction).mockResolvedValue({ ok: true, data: { ...made, mode, filed: null } });
    await pressMakeRecurring("t1", after);
    return vi.mocked(toast).mock.calls[0]![0].action!.onAction;
  };

  test("its Undo, a series created: the series' creation is undone, and the panel put back", async () => {
    vi.mocked(undoCreateSeriesAction).mockResolvedValue({ ok: true, data: { unlinked: 1 } });
    const undoIt = await undoOf("created");

    undoIt();

    await vi.waitFor(() => expect(after.reset).toHaveBeenCalledOnce());
    expect(undoCreateSeriesAction).toHaveBeenLastCalledWith({ seriesId: "s1", undo });
    expect(undoAction).not.toHaveBeenCalled();
    expect(after.onChanged).toHaveBeenCalledTimes(2);
  });

  test("its Undo, a live series joined: the rows' links are put back — the series he joined stays", async () => {
    vi.mocked(undoAction).mockResolvedValue({ ok: true, data: { restored: 1, ruleDeleted: false } });
    const undoIt = await undoOf("attached");

    undoIt();

    await vi.waitFor(() => expect(after.reset).toHaveBeenCalledOnce());
    expect(undoAction).toHaveBeenLastCalledWith(undo);
    expect(undoCreateSeriesAction).not.toHaveBeenCalled();
    expect(after.onChanged).toHaveBeenCalledTimes(2);
  });

  test("an Undo refused says why, and leaves the panel as the press left it", async () => {
    vi.mocked(undoCreateSeriesAction).mockResolvedValue({ ok: false, error: "Nothing to undo" });
    const undoIt = await undoOf("created");

    undoIt();

    await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: "Nothing to undo", tone: "negative" }));
    expect(after.reset).not.toHaveBeenCalled();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });
});
