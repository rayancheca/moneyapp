import fs from "node:fs";
import path from "node:path";
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

/*
 * 🔴 Review of batch 9 F (2026-10-30): `UNDO_FAILED` was "ONE sentence for every Undo card", and three of the six said
 * their own — a merchant's default ("Couldn’t put the default back — try again"), a deleted rule and a split each
 * hand-rolled this card with a sentence of its own, so an undo refused with nothing readable read two ways. A source
 * gate, as /imports' page.test.ts is: an Undo card is this one (`offerUndoToast`, `offerUndoToastWith`), or one of the
 * two that must do more on their press — a category's Move re-reads the page on a failure, and an inline edit rolls
 * its field back — each of which says `UNDO_FAILED`, pinned by its own test (CategoryMoveMenu.test.ts,
 * useInlineEdit.test.ts).
 */
describe("every Undo card is this one, or says what it says", () => {
  const root = path.join(process.cwd(), "src");
  const sources = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => f.split(path.sep).join("/"));
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

  it("no card raises its own Undo but the shared one, a category's Move and an inline edit", () => {
    const own = sources.filter((f) => /label: "Undo"/.test(read(f))).sort();
    expect(own).toEqual([
      "components/categories/CategoryMoveMenu.tsx",
      "components/transactions/undo-toast.ts",
      "hooks/useInlineEdit.ts",
    ]);
    for (const f of own) expect(read(f), f).toMatch(/\bUNDO_FAILED\b/);
  });
});
