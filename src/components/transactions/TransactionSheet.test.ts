import { beforeEach, describe, expect, test, vi } from "vitest";
import { setFlagsAction } from "@/app/transactions/actions";
import { toast } from "@/components/ui/Toast";
import { ACTION_FAILED } from "@/hooks/useAction";
import { accountHistoryLine, historyLine, pressSaveNotes } from "./TransactionSheet";

// the notes box's save is made where the sheet makes it, its toasts read as raised
vi.mock("@/app/transactions/actions", async (actual) => ({ ...(await actual<object>()), setFlagsAction: vi.fn() }));
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));

describe("historyLine — the mean's denominator is named", () => {
  /*
   * 🔴 `Zelle`: "140 transactions · avg $76.48 · $4,053.69 total" — $4,053.69 ÷
   * 140 is $28.95, and ÷ 53 (its outflows) is $76.48, so the three figures
   * could not be reconciled with each other. `ACH Deposit`: 83 rows, no
   * outflow, +$16,386.82 net, and the line read "avg $0.00 · $0.00 total".
   * Measured 2026-09-10: 1,328 active rows sit in a group where the two counts
   * differ, 551 of them in groups with no outflow at all.
   */
  test("a group where every row spent keeps the plain sentence", () => {
    expect(historyLine({ count: 12, outCount: 12, avgCents: 1_250, totalCents: 15_000 })).toBe(
      "12 transactions · avg $12.50 · $150.00 spent",
    );
  });

  test("a mixed group names how many of them spent", () => {
    expect(historyLine({ count: 140, outCount: 53, avgCents: 7_648, totalCents: 405_369 })).toBe(
      "140 transactions, 53 of them spending · avg $76.48 · $4,053.69 spent",
    );
  });

  test("a group with no outflow says so instead of averaging nothing", () => {
    expect(historyLine({ count: 83, outCount: 0, avgCents: 0, totalCents: 0 })).toBe(
      "83 transactions, none of them spending",
    );
  });

  test("one transaction is singular", () => {
    expect(historyLine({ count: 1, outCount: 0, avgCents: 0, totalCents: 0 })).toBe(
      "1 transaction, none of them spending",
    );
  });

  test("the mean is always total ÷ the count the sentence names", () => {
    const h = { count: 140, outCount: 53, avgCents: 7_648, totalCents: 405_369 };
    expect(Math.round(h.totalCents / h.outCount)).toBe(h.avgCents);
  });
});

/**
 * 🔴 THE SAME DEFECT AS ABOVE, IN THE LIST DIRECTLY UNDER IT. The 2026-09-10
 * fix named the denominator for the group's total and stopped at the
 * per-account rows, which went on printing a GROSS count beside a debits-only
 * sum. Measured on the real ledger 2026-09-11: 12 of the 85 History cards that
 * render a per-account list carry at least one such row.
 */
describe("accountHistoryLine — the count and the figure are one population", () => {
  test("names how many of the rows the money-out figure is over", () => {
    expect(accountHistoryLine({ accountName: "Venture X", count: 36, outCount: 1 })).toBe(
      "Venture X · 36 transactions, 1 of them spending",
    );
  });

  test("an account with no outflow says so rather than implying 31 charges", () => {
    expect(accountHistoryLine({ accountName: "SoFi Savings", count: 31, outCount: 0 })).toBe(
      "SoFi Savings · 31 transactions, none of them spending",
    );
  });

  test("an all-spending account stays short — there is no second population to name", () => {
    expect(accountHistoryLine({ accountName: "Chase Sapphire", count: 12, outCount: 12 })).toBe(
      "Chase Sapphire · 12 transactions",
    );
  });

  test("one row is one transaction", () => {
    expect(accountHistoryLine({ accountName: "Discover", count: 1, outCount: 1 })).toBe(
      "Discover · 1 transaction",
    );
  });
});

/*
 * 🔴 Review of batch 9 F (2026-10-30): the notes box saved through `void setFlagsAction(…).then((r) => { if (r.ok)
 * afterMutation(); })` — a refused save said nothing, and his words stayed in the box as if saved; a call that never
 * reached the server rejected unhandled. Settled (`settleAction`), a failure says why, as every press does, and his
 * words stay in the box: blurring it again saves them again.
 */
describe("the sheet's notes save, as the notes box makes it", () => {
  const saved = { ok: true as const, data: { affected: 1, undo: { rows: [] } } };
  const afterSaved = vi.fn();

  beforeEach(() => {
    vi.mocked(setFlagsAction).mockReset();
    vi.mocked(toast).mockClear();
    afterSaved.mockClear();
  });

  test("it saves his words, and the sheet is re-read", async () => {
    vi.mocked(setFlagsAction).mockResolvedValue(saved);

    await pressSaveNotes("t1", "for the trip", afterSaved);

    expect(setFlagsAction).toHaveBeenLastCalledWith({ transactionId: "t1", flags: { notes: "for the trip" } });
    expect(afterSaved).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  test("an emptied box clears the note", async () => {
    vi.mocked(setFlagsAction).mockResolvedValue(saved);

    await pressSaveNotes("t1", "", afterSaved);

    expect(setFlagsAction).toHaveBeenLastCalledWith({ transactionId: "t1", flags: { notes: null } });
  });

  test("a save refused says why — nothing re-read as if it had landed", async () => {
    vi.mocked(setFlagsAction).mockResolvedValue({ ok: false, error: "Transaction not found" });

    await pressSaveNotes("t1", "for the trip", afterSaved);

    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: "Transaction not found", tone: "negative" });
    expect(afterSaved).not.toHaveBeenCalled();
  });

  test("a save that never reached the server says what it threw — or what every press says", async () => {
    vi.mocked(setFlagsAction).mockRejectedValueOnce(new Error("Failed to fetch")).mockRejectedValueOnce("nope");

    await pressSaveNotes("t1", "for the trip", afterSaved);
    await pressSaveNotes("t1", "for the trip", afterSaved);

    expect(vi.mocked(toast).mock.calls.map(([t]) => t)).toEqual([
      { title: "Failed to fetch", tone: "negative" },
      { title: ACTION_FAILED, tone: "negative" },
    ]);
    expect(afterSaved).not.toHaveBeenCalled();
  });
});
