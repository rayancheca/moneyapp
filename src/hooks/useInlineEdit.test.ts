import { beforeEach, describe, expect, test, vi } from "vitest";
import type { InlineSaveResult } from "./useInlineEdit";

/**
 * One save of an inline field, and the Undo card it raises. `useInlineEdit` itself is React and is covered by e2e (no
 * jsdom in this project); the save is a plain function the hook hands its state to, and the card is where the bug was.
 */

// the toasts a save raises, read as raised
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));

const { persistInlineEdit } = await import("./useInlineEdit");
const { settleToastAction, toast } = await import("@/components/ui/Toast");
type ToastActionResult = import("@/components/ui/Toast").ToastActionResult;

const saved = (): Promise<InlineSaveResult> => Promise.resolve({ ok: true });

/** a field showing "Checking", whose saves answer in turn as given */
function fieldAnswering(...answers: ReadonlyArray<() => Promise<InlineSaveResult>>) {
  let display = "Checking";
  const onSave = vi.fn<(value: string) => Promise<InlineSaveResult>>();
  for (const answer of answers) onSave.mockImplementationOnce(answer);
  const io = {
    onSave,
    describe: (value: string) => `Renamed to “${value}”`,
    setDisplay: (value: string) => {
      display = value;
    },
    setPending: vi.fn(),
    seq: { current: 0 },
  };
  return { io, display: () => display };
}

/** rename Checking to Bills, and hand back the Undo on the card the save raised */
async function undoOfRename(io: ReturnType<typeof fieldAnswering>["io"]) {
  await persistInlineEdit(io, "Bills", "Checking", true);
  return vi.mocked(toast).mock.calls[0]![0].action!.onAction;
}

// what the card does once its Undo settles — Toast's own rule, read here rather than restated
const cardAfter = (value: ToastActionResult) => settleToastAction({ status: "resolved", value });

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

describe("an inline field's save, and the Undo on its card", () => {
  test("a save shows at once, and its card names what it saved", async () => {
    const { io, display } = fieldAnswering(saved);

    await persistInlineEdit(io, "Bills", "Checking", true);

    expect(io.onSave).toHaveBeenLastCalledWith("Bills");
    expect(display()).toBe("Bills");
    expect(vi.mocked(toast).mock.calls[0]![0].title).toBe("Renamed to “Bills”");
  });

  test("its Undo puts the old value back, and the card closes once that save has landed", async () => {
    const { io, display } = fieldAnswering(saved, saved);
    const undoIt = await undoOfRename(io);

    expect(await undoIt()).toMatchObject({ ok: true });
    expect(io.onSave).toHaveBeenLastCalledWith("Checking");
    expect(display()).toBe("Checking");
    // an undo offers no undo of its own
    expect(toast).toHaveBeenCalledOnce();
  });

  /*
   * 🔴 Review of c3d804e (batch 6) found the Make recurring card's shape here too: the Undo was
   * `() => void persist(…)`, which resolves with nothing, so Toast's `settleToastAction` dismissed the card on the
   * press — a refused undo rolled the field back to what he had saved and raised a toast beside a card already gone,
   * with nothing left to press (re-read on 569b0a8, 2026-10-29).
   */
  test("an Undo refused keeps its card and says why on it — the field shows what is saved", async () => {
    const { io, display } = fieldAnswering(saved, () =>
      Promise.resolve({ ok: false, error: "Could not rename account" }),
    );
    const undoIt = await undoOfRename(io);

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Could not rename account" });
    expect(display()).toBe("Bills");
    // said on the card itself (its role="alert"), not in a second toast beside it
    expect(toast).toHaveBeenCalledOnce();
  });

  test("an Undo that never reached the server says so on its card, and can be pressed again", async () => {
    const { io, display } = fieldAnswering(saved, () => Promise.reject(new Error("Failed to fetch")), saved);
    const undoIt = await undoOfRename(io);

    expect(cardAfter(await undoIt())).toEqual({ dismiss: false, error: "Couldn’t save that — try again" });
    expect(display()).toBe("Bills");
    expect(await undoIt()).toMatchObject({ ok: true });
    expect(display()).toBe("Checking");
  });

  test("a save that fails has no card to say it on — it says so in a toast of its own", async () => {
    const { io, display } = fieldAnswering(() => Promise.reject(new Error("Failed to fetch")));

    await persistInlineEdit(io, "Bills", "Checking", true);

    expect(display()).toBe("Checking");
    expect(toast).toHaveBeenCalledExactlyOnceWith({ title: "Couldn’t save that — try again", tone: "negative" });
  });

  test("an Undo overtaken by a newer save closes its card — the newer save owns the field", async () => {
    let land!: (result: InlineSaveResult) => void;
    const inFlight = () => new Promise<InlineSaveResult>((resolve) => (land = resolve));
    const { io, display } = fieldAnswering(saved, inFlight, saved);
    const undoIt = await undoOfRename(io);

    const pressed = undoIt();
    // he renames it again before the undo lands
    await persistInlineEdit(io, "Rent", "Checking", true);
    land({ ok: false, error: "Could not rename account" });

    expect(cardAfter(await pressed)).toEqual({ dismiss: true, error: null });
    expect(display()).toBe("Rent");
  });
});
