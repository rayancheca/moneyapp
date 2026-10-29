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
// the patch undo's toast is read as raised; the rest of the shared Undo card is real — Make recurring's card is it
vi.mock("./undo-toast", async (actual) => ({ ...(await actual<object>()), offerUndoToast: vi.fn() }));

const { pressMakeRecurring, pressSheetAttach } = await import("./LinkPanels");
const { attachToSeriesAction, createSeriesFromTxnAction, undoCreateSeriesAction } = await import("@/app/recurring/actions");
const { undoAction } = await import("@/app/transactions/actions");
const { settleToastAction, toast } = await import("@/components/ui/Toast");
const { offerUndoToast, UNDO_FAILED } = await import("./undo-toast");
type ToastActionResult = import("@/components/ui/Toast").ToastActionResult;

const undo = { rows: [] };
const filed = { categoryId: "c1", categoryPath: "Utilities > Electricity", count: 1 };
const after = { linked: vi.fn(), close: vi.fn(), reset: vi.fn(), onChanged: vi.fn() };

beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(offerUndoToast).mockClear();
  // reset, not cleared: a test's rejected undo must not answer the next test's press
  vi.mocked(undoCreateSeriesAction).mockReset();
  vi.mocked(undoAction).mockReset();
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
  // what the card does once its Undo settles — Toast's own rule, read here rather than restated
  const cardAfter = (value: ToastActionResult) => settleToastAction({ status: "resolved", value });

  test("its Undo, a series created: the series' creation is undone, and the panel put back", async () => {
    vi.mocked(undoCreateSeriesAction).mockResolvedValue({ ok: true, data: { unlinked: 1 } });
    const undoIt = await undoOf("created");

    // the card closes because the undo landed, not because it was pressed
    expect(await undoIt()).toMatchObject({ ok: true });
    expect(undoCreateSeriesAction).toHaveBeenLastCalledWith({ seriesId: "s1", undo });
    expect(undoAction).not.toHaveBeenCalled();
    expect(after.reset).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledTimes(2);
  });

  test("its Undo, a live series joined: the rows' links are put back — the series he joined stays", async () => {
    vi.mocked(undoAction).mockResolvedValue({ ok: true, data: { restored: 1, ruleDeleted: false } });
    const undoIt = await undoOf("attached");

    expect(await undoIt()).toMatchObject({ ok: true });
    expect(undoAction).toHaveBeenLastCalledWith(undo);
    expect(undoCreateSeriesAction).not.toHaveBeenCalled();
    expect(after.reset).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledTimes(2);
  });

  /*
   * 🔴 Review of c3d804e (batch 6): those tests blessed a card hand-rolled as `() => void (…).then(…)`, which resolves
   * with nothing — and Toast's `settleToastAction` dismisses a card whose action reports nothing, on the press. A
   * refused undo tore the card down with its patch (the negative toast it raised had nothing to press), and a call
   * that never reached the server rejected with no catch: nothing reached him at all. The card is now the shared one,
   * which settles and RETURNS (re-read on 569b0a8, 2026-10-29).
   */
  test("an Undo refused keeps its card and says why on it — the panel stays as the press left it", async () => {
    vi.mocked(undoCreateSeriesAction).mockResolvedValue({ ok: false, error: "Nothing to undo" });
    const undoIt = await undoOf("created");

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Nothing to undo" });
    // said on the card itself (its role="alert"), not in a second toast beside it
    expect(toast).toHaveBeenCalledOnce();
    expect(after.reset).not.toHaveBeenCalled();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });

  test("an Undo that never reached the server (restarted, wifi down) says so on its card", async () => {
    vi.mocked(undoAction).mockRejectedValue(new Error("Failed to fetch"));
    const undoIt = await undoOf("attached");

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Failed to fetch" });
    expect(after.reset).not.toHaveBeenCalled();
  });

  test("…and with nothing readable, it says what every Undo card says: the change still stands", async () => {
    vi.mocked(undoCreateSeriesAction).mockRejectedValue("nope");
    const undoIt = await undoOf("created");

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: UNDO_FAILED });
  });

  test("a failed Undo can be pressed again, with the same patch, and the second press undoes it", async () => {
    vi.mocked(undoCreateSeriesAction)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, data: { unlinked: 1 } });
    const undoIt = await undoOf("created");

    expect(await undoIt()).toMatchObject({ ok: false });
    expect(await undoIt()).toMatchObject({ ok: true });
    expect(undoCreateSeriesAction).toHaveBeenNthCalledWith(2, { seriesId: "s1", undo });
    expect(after.reset).toHaveBeenCalledOnce();
  });
});
