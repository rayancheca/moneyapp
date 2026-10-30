import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CorrectCategoryData } from "@/app/transactions/action-types";

// the server actions pull in next/cache and the database client
vi.mock("@/app/transactions/actions", () => ({
  correctCategory: vi.fn(),
  createRuleAction: vi.fn(),
  retroApplyRuleAction: vi.fn(),
  undoAction: vi.fn(),
}));
// the toasts a correction raises, read as raised; the rest of Toast is real — its card's rule is read, not restated
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));

const { runCategoryCorrection } = await import("./correct-category");
const { correctCategory, createRuleAction, retroApplyRuleAction, undoAction } = await import("@/app/transactions/actions");
const { settleToastAction, toast } = await import("@/components/ui/Toast");
type ToastActionResult = import("@/components/ui/Toast").ToastActionResult;

const undo = { rows: [{ id: "t1", prev: { categoryId: null } }] };
const pastUndo = { rows: [{ id: "t2", prev: { categoryId: null } }] };
/** t1 corrected to Coffee: three other rows named “Blue Bottle” could follow it */
const corrected: { ok: true; data: CorrectCategoryData } = {
  ok: true,
  data: {
    rulePrompt: {
      target: { kind: "merchant", merchantId: "m-blue-bottle" },
      subjectLabel: "Blue Bottle",
      categoryLabel: "Coffee",
      matchCount: 3,
    },
    undo,
  },
};
const ruleMade = { ok: true as const, data: { ruleId: "r1", name: "Always: Blue Bottle → Coffee", priority: 1, matchCount: 3 } };
const pastApplied = { ok: true as const, data: { affected: 3, undo: pastUndo } };
const onChanged = vi.fn();

beforeEach(() => {
  // reset, not cleared: a test's refusal must not answer the next test's press
  for (const fn of [correctCategory, createRuleAction, retroApplyRuleAction, undoAction]) vi.mocked(fn).mockReset();
  vi.mocked(toast).mockClear();
  onChanged.mockClear();
});

const correctToCoffee = () =>
  runCategoryCorrection({ transactionId: "t1", categoryId: "c-coffee", categoryName: "Coffee", onChanged });

/** correct t1 to Coffee, and hand back the "Apply to 3" on the card the correction raised */
async function applyOfCorrection() {
  vi.mocked(correctCategory).mockResolvedValueOnce(corrected);
  await correctToCoffee();
  return vi.mocked(toast).mock.calls[0]![0].action!.onAction;
}

// what the card does once its action settles — Toast's own rule, read here rather than restated
const cardAfter = (value: ToastActionResult) => settleToastAction({ status: "resolved", value });

describe("a correction, and the “Apply to N” on its card, as runCategoryCorrection raises them", () => {
  test("a correction offers its category to the others named alike, past and future", async () => {
    await applyOfCorrection();

    expect(correctCategory).toHaveBeenLastCalledWith({ transactionId: "t1", categoryId: "c-coffee" });
    const [card] = vi.mocked(toast).mock.calls[0]!;
    expect(card.title).toBe("Categorized as Coffee");
    expect(card.action?.label).toBe("Apply to 3");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  test("pressed, it makes the rule and applies it to the past — the card closes once both have landed", async () => {
    vi.mocked(createRuleAction).mockResolvedValueOnce(ruleMade);
    vi.mocked(retroApplyRuleAction).mockResolvedValueOnce(pastApplied);
    vi.mocked(undoAction).mockResolvedValueOnce({ ok: true, data: { restored: 3, ruleDeleted: true } });
    const applyIt = await applyOfCorrection();

    expect(cardAfter(await applyIt())).toEqual({ dismiss: true, error: null });
    expect(createRuleAction).toHaveBeenLastCalledWith({ merchantId: "m-blue-bottle", categoryId: "c-coffee" });
    expect(retroApplyRuleAction).toHaveBeenLastCalledWith("r1");
    expect(onChanged).toHaveBeenCalledTimes(2);
    // the one Undo for both: the past put back AND the rule deleted
    const [undoCard] = vi.mocked(toast).mock.calls[1]!;
    expect(undoCard.title).toBe("3 recategorized · rule created");
    await undoCard.action!.onAction();
    expect(undoAction).toHaveBeenLastCalledWith(pastUndo, { deleteRuleId: "r1" });
  });

  /*
   * 🔴 Review of 43a66c99 (batch 8): the sweep that made every Undo card settle missed this card. Its action was
   * `() => applyToAll(…)` over `void createRuleAction(…).then(…)`, which returns nothing, so Toast's
   * `settleToastAction` dismissed the card on the press: a refused rule raised a toast beside a card already gone,
   * and a call that never reached the server rejected with no catch — nothing reached him (re-read on b86f4e88,
   * 2026-10-30).
   */
  test("a rule refused keeps its card and says why on it — not in a second toast beside it", async () => {
    vi.mocked(createRuleAction).mockResolvedValueOnce({ ok: false, error: "Unknown category" });
    const applyIt = await applyOfCorrection();

    expect(cardAfter(await applyIt())).toEqual({ dismiss: false, error: "Unknown category" });
    expect(retroApplyRuleAction).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledOnce();
  });

  test("a press that never reached the server (restarted, wifi down) says so on its card", async () => {
    vi.mocked(createRuleAction).mockRejectedValueOnce(new Error("Failed to fetch"));
    const applyIt = await applyOfCorrection();

    expect(cardAfter(await applyIt())).toEqual({ dismiss: false, error: "Failed to fetch" });
    expect(toast).toHaveBeenCalledOnce();
  });

  test("a rule made whose past did not apply: pressed again, it applies that rule — it never makes a second", async () => {
    vi.mocked(createRuleAction).mockResolvedValueOnce(ruleMade);
    vi.mocked(retroApplyRuleAction).mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(pastApplied);
    const applyIt = await applyOfCorrection();

    expect(cardAfter(await applyIt())).toEqual({ dismiss: false, error: "Failed to fetch" });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(cardAfter(await applyIt())).toEqual({ dismiss: true, error: null });
    expect(createRuleAction).toHaveBeenCalledOnce();
    expect(retroApplyRuleAction).toHaveBeenNthCalledWith(2, "r1");
    expect(vi.mocked(toast).mock.calls[1]![0].title).toBe("3 recategorized · rule created");
  });

  test("a correction that never reached the server says so", async () => {
    vi.mocked(correctCategory).mockRejectedValueOnce(new Error("Failed to fetch"));

    await correctToCoffee();

    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: "Failed to fetch", tone: "negative" });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
