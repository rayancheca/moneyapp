import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastOptions } from "@/components/ui/Toast";
import type { UndoPatch } from "@/app/transactions/action-types";

/**
 * The undo safety net end-to-end at the module level: what the toast is handed,
 * and what its action reports back. The failure branch is the point — the old
 * `.then((r) => { if (r.ok) onUndone(); })` had no else and no catch, so a
 * failed undo of a 300-row recategorization looked exactly like a successful
 * one.
 */

const shown = vi.hoisted(() => [] as ToastOptions[]);
const undo = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/Toast", () => ({
  toast: (options: ToastOptions) => {
    shown.push(options);
    return "toast-0";
  },
}));
vi.mock("@/app/transactions/actions", () => ({ undoAction: undo }));

const { offerUndoToast, UNDO_FAILED } = await import("./undo-toast");

const PATCH: UndoPatch = { rows: [{ id: "t1", prev: { categoryId: "c1" } }] };

beforeEach(() => {
  shown.length = 0;
  undo.mockReset();
});

describe("offerUndoToast", () => {
  it("offers an Undo action under the given title", () => {
    offerUndoToast("300 recategorized", PATCH, vi.fn());
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("300 recategorized");
    expect(shown[0]!.action?.label).toBe("Undo");
  });

  it("applies the patch and reports success", async () => {
    undo.mockResolvedValue({ ok: true, data: { restored: 300, ruleDeleted: false } });
    const onUndone = vi.fn();
    offerUndoToast("300 recategorized", PATCH, onUndone, { deleteRuleId: "r1" });

    const outcome = await shown[0]!.action!.onAction();

    expect(undo).toHaveBeenCalledWith(PATCH, { deleteRuleId: "r1" });
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("reports a REPORTED failure back to the card and does not claim it undid anything", async () => {
    undo.mockResolvedValue({ ok: false, error: "Unknown transaction t1" });
    const onUndone = vi.fn();
    offerUndoToast("300 recategorized", PATCH, onUndone);

    const outcome = await shown[0]!.action!.onAction();

    expect(onUndone).not.toHaveBeenCalled();
    // ok:false is what keeps the card — and this patch — alive for a retry
    expect(outcome).toEqual({ ok: false, error: "Unknown transaction t1" });
  });

  it("reports a THROWN undo instead of resolving as if it worked", async () => {
    undo.mockRejectedValue(new Error("Failed to fetch"));
    const onUndone = vi.fn();
    offerUndoToast("300 recategorized", PATCH, onUndone);

    const outcome = await shown[0]!.action!.onAction();

    expect(onUndone).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("says the change still stands when the failure carries no message", async () => {
    undo.mockRejectedValue("nope");
    offerUndoToast("300 recategorized", PATCH, vi.fn());

    expect(await shown[0]!.action!.onAction()).toEqual({ ok: false, error: UNDO_FAILED });
  });

  it("keeps the patch retryable — a second attempt after a failure can succeed", async () => {
    undo.mockRejectedValueOnce(new Error("Failed to fetch"));
    undo.mockResolvedValueOnce({ ok: true, data: { restored: 300, ruleDeleted: false } });
    const onUndone = vi.fn();
    offerUndoToast("300 recategorized", PATCH, onUndone);

    const first = await shown[0]!.action!.onAction();
    const second = await shown[0]!.action!.onAction();

    expect(first).toMatchObject({ ok: false });
    expect(second).toMatchObject({ ok: true });
    expect(undo).toHaveBeenNthCalledWith(2, PATCH, undefined);
    expect(onUndone).toHaveBeenCalledTimes(1);
  });
});
