import { beforeEach, describe, expect, test, vi } from "vitest";

// the server action pulls in next/cache and the database client
vi.mock("@/app/categories/actions", () => ({ moveCategoryAction: vi.fn() }));
// the toasts a press raises, read as raised
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));

const { pressMoveCategory } = await import("./CategoryMoveMenu");
const { moveCategoryAction } = await import("@/app/categories/actions");
const { settleToastAction, toast } = await import("@/components/ui/Toast");
type ToastActionResult = import("@/components/ui/Toast").ToastActionResult;

const refresh = vi.fn();
const food = { id: "c-food", label: "Food" };
// Coffee, a subcategory of Dining, moved under Food — and back
const movedThere = { ok: true as const, data: { id: "c-coffee", parentId: "c-food" } };
const movedBack = { ok: true as const, data: { id: "c-coffee", parentId: "c-dining" } };

beforeEach(() => {
  vi.mocked(moveCategoryAction).mockReset();
  vi.mocked(toast).mockClear();
  refresh.mockClear();
});

// what the card does once its Undo settles — Toast's own rule, read here rather than restated
const cardAfter = (value: ToastActionResult) => settleToastAction({ status: "resolved", value });

/** move Coffee under Food, and hand back the Undo on the card the move raised */
async function undoOfMove() {
  vi.mocked(moveCategoryAction).mockResolvedValueOnce(movedThere);
  await pressMoveCategory("c-coffee", "c-dining", food, refresh);
  return vi.mocked(toast).mock.calls[0]![0].action!.onAction;
}

describe("a category's Move, as CategoryMoveMenu makes it", () => {
  test("it moves, its card names where it went, and the page is re-read", async () => {
    await undoOfMove();

    expect(moveCategoryAction).toHaveBeenLastCalledWith({ categoryId: "c-coffee", newParentId: "c-food" });
    expect(vi.mocked(toast).mock.calls[0]![0].title).toBe("Moved to Food");
    expect(refresh).toHaveBeenCalledOnce();
  });

  test("a move refused says why, and offers nothing to undo", async () => {
    vi.mocked(moveCategoryAction).mockResolvedValueOnce({ ok: false, error: "Move within the same kind" });

    await pressMoveCategory("c-coffee", "c-dining", food, refresh);

    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: "Move within the same kind", tone: "negative" });
    expect(refresh).not.toHaveBeenCalled();
  });

  /*
   * 🔴 Review of c3d804e (batch 6) found the Make recurring card's `() => void (…).then(…)` in this menu too: a move
   * that never reached the server rejected with no catch, and its Undo resolved with nothing, so Toast's
   * `settleToastAction` dismissed the card on the press — a refused move back raised "Undo failed: …" beside a card
   * already gone, with nothing left to press (re-read on 569b0a8, 2026-10-29).
   */
  test("a move that never reached the server (restarted, wifi down) says so", async () => {
    vi.mocked(moveCategoryAction).mockRejectedValueOnce(new Error("Failed to fetch"));

    await pressMoveCategory("c-coffee", "c-dining", food, refresh);

    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: "Failed to fetch", tone: "negative" });
  });

  test("its Undo moves it back, and the card closes once the move back has landed", async () => {
    const undoIt = await undoOfMove();
    vi.mocked(moveCategoryAction).mockResolvedValueOnce(movedBack);

    expect(await undoIt()).toMatchObject({ ok: true });
    expect(moveCategoryAction).toHaveBeenLastCalledWith({ categoryId: "c-coffee", newParentId: "c-dining" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("an Undo refused keeps its card and says why on it — the page re-read to the server's truth", async () => {
    const undoIt = await undoOfMove();
    vi.mocked(moveCategoryAction).mockResolvedValueOnce({ ok: false, error: "Unknown destination category" });

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Unknown destination category" });
    // said on the card itself (its role="alert"), not in a second toast beside it
    expect(toast).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("an Undo that never reached the server says so on its card, and can be pressed again", async () => {
    const undoIt = await undoOfMove();
    vi.mocked(moveCategoryAction).mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(movedBack);

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Failed to fetch" });
    expect(await undoIt()).toMatchObject({ ok: true });
    expect(moveCategoryAction).toHaveBeenNthCalledWith(3, { categoryId: "c-coffee", newParentId: "c-dining" });
  });

  test("…and with nothing readable, it says it couldn’t move it back", async () => {
    const undoIt = await undoOfMove();
    vi.mocked(moveCategoryAction).mockRejectedValueOnce("nope");

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Couldn’t move it back — try again" });
  });
});
