import { describe, expect, test, vi } from "vitest";
import {
  PRIORITIES,
  SEQUENCE_WINDOW_MS,
  createKeyScopeStack,
  type KeyEventLike,
} from "./keyscope";

function ev(key: string, overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    targetIsEditable: false,
    ...overrides,
  };
}

const LIST = { priority: PRIORITIES.list };
const TOAST = { priority: PRIORITIES.toast };
const SHEET = { priority: PRIORITIES.sheet, modal: true };
const PALETTE = { priority: PRIORITIES.palette, modal: true };
const TRIGGER_AT_PALETTE = { priority: PRIORITIES.palette };

test("PRIORITIES tiers order palette > toast > sheet > list > trigger", () => {
  expect(PRIORITIES.palette).toBeGreaterThan(PRIORITIES.toast);
  expect(PRIORITIES.toast).toBeGreaterThan(PRIORITIES.sheet);
  expect(PRIORITIES.sheet).toBeGreaterThan(PRIORITIES.list);
  expect(PRIORITIES.list).toBeGreaterThan(PRIORITIES.trigger);
});

describe("combo matching", () => {
  test("empty stack handles nothing; bound plain key fires; unbound does not", () => {
    const stack = createKeyScopeStack();
    expect(stack.dispatch(ev("k"))).toBe(false);
    expect(stack.dispatch(ev("k", { metaKey: true, targetIsEditable: true }))).toBe(false);
    const onKey = vi.fn();
    stack.push("list", { k: onKey }, LIST);
    expect(stack.dispatch(ev("k"))).toBe(true);
    expect(stack.dispatch(ev("z"))).toBe(false);
    expect(onKey).toHaveBeenCalledOnce();
  });

  test("case-insensitive matching; shift and mod are required AND rejected exactly", () => {
    const stack = createKeyScopeStack();
    const onKey = vi.fn();
    const onEsc = vi.fn();
    const onShift = vi.fn();
    const onMod = vi.fn();
    const onPlain = vi.fn();
    stack.push("l", { K: onKey, Escape: onEsc, "shift+j": onShift, "mod+m": onMod, p: onPlain }, LIST);
    expect(stack.dispatch(ev("k"))).toBe(true); // binding side lowercased
    expect(stack.dispatch(ev("escape"))).toBe(true); // event side lowercased
    expect(stack.dispatch(ev("J", { shiftKey: true }))).toBe(true);
    expect(stack.dispatch(ev("j"))).toBe(false); // shift+j demands shift
    expect(stack.dispatch(ev("P", { shiftKey: true }))).toBe(false); // plain rejects shift
    expect(stack.dispatch(ev("m", { metaKey: true }))).toBe(true); // mod = meta…
    expect(stack.dispatch(ev("m", { ctrlKey: true }))).toBe(true); // …OR ctrl
    expect(stack.dispatch(ev("m"))).toBe(false); // mod+m demands mod
    expect(stack.dispatch(ev("p", { metaKey: true }))).toBe(false); // plain rejects mod
    for (const handler of [onKey, onEsc, onShift]) expect(handler).toHaveBeenCalledOnce();
    expect(onMod).toHaveBeenCalledTimes(2);
    expect(onPlain).not.toHaveBeenCalled();
  });

  test("alt never matches (no alt grammar); multi-modifier and named-key combos", () => {
    const stack = createKeyScopeStack();
    const onCombo = vi.fn();
    const onConfirm = vi.fn();
    stack.push("l", { a: vi.fn(), "mod+a": vi.fn(), "mod+shift+k": onCombo, "mod+enter": onConfirm }, LIST);
    expect(stack.dispatch(ev("a", { altKey: true }))).toBe(false);
    expect(stack.dispatch(ev("a", { metaKey: true, altKey: true }))).toBe(false);
    expect(stack.dispatch(ev("K", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(stack.dispatch(ev("k", { metaKey: true }))).toBe(false); // demands both
    expect(stack.dispatch(ev("Enter", { metaKey: true }))).toBe(true);
    expect(onCombo).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("editable targets", () => {
  test("plain/shifted mnemonics and sequences are ignored while typing; pending is cleared", () => {
    const stack = createKeyScopeStack();
    const onKey = vi.fn();
    const onChord = vi.fn();
    stack.push("list", { k: onKey, "shift+j": vi.fn(), "g r": onChord }, LIST);
    expect(stack.dispatch(ev("k", { targetIsEditable: true }))).toBe(false);
    expect(stack.dispatch(ev("J", { shiftKey: true, targetIsEditable: true }))).toBe(false);
    expect(stack.dispatch(ev("g", { targetIsEditable: true }), 0)).toBe(false); // never starts
    expect(stack.dispatch(ev("g"), 10)).toBe(true);
    expect(stack.dispatch(ev("r", { targetIsEditable: true }), 20)).toBe(false); // clears pending
    expect(stack.dispatch(ev("r"), 30)).toBe(false); // fresh r no longer completes
    expect(onKey).not.toHaveBeenCalled();
    expect(onChord).not.toHaveBeenCalled();
  });

  test("mod combos fire while typing, walking through non-modal scopes; misses stay unhandled", () => {
    const stack = createKeyScopeStack();
    const onLower = vi.fn();
    stack.push("list", { "mod+z": onLower }, LIST);
    stack.push("trigger", { "mod+k": vi.fn() }, TRIGGER_AT_PALETTE);
    expect(stack.dispatch(ev("z", { metaKey: true, targetIsEditable: true }))).toBe(true);
    expect(stack.dispatch(ev("j", { metaKey: true, targetIsEditable: true }))).toBe(false);
    expect(onLower).toHaveBeenCalledOnce();
  });

  test("modal scope while typing: its own escape/mod fire, everything below is blocked", () => {
    const stack = createKeyScopeStack();
    const onLower = vi.fn();
    const onEsc = vi.fn();
    const onMod = vi.fn();
    stack.push("list", { "mod+z": onLower }, LIST);
    stack.push("sheet", { escape: onEsc, "mod+s": onMod }, SHEET);
    expect(stack.dispatch(ev("Escape", { targetIsEditable: true }))).toBe(true);
    expect(stack.dispatch(ev("s", { ctrlKey: true, targetIsEditable: true }))).toBe(true);
    expect(stack.dispatch(ev("z", { metaKey: true, targetIsEditable: true }))).toBe(false);
    expect(onEsc).toHaveBeenCalledOnce();
    expect(onMod).toHaveBeenCalledOnce();
    expect(onLower).not.toHaveBeenCalled();
  });
});

describe("priority precedence", () => {
  test("higher priority wins regardless of push order; unbound combos fall through non-modal", () => {
    const stack = createKeyScopeStack();
    const onToast = vi.fn();
    const onList = vi.fn();
    const onListK = vi.fn();
    stack.push("toast", { e: onToast }, TOAST); // pushed FIRST, still consulted first
    stack.push("list", { e: onList, k: onListK }, LIST);
    expect(stack.dispatch(ev("e"))).toBe(true);
    expect(stack.dispatch(ev("k"))).toBe(true); // toast lacks k → falls through
    expect(onToast).toHaveBeenCalledOnce();
    expect(onListK).toHaveBeenCalledOnce();
    expect(onList).not.toHaveBeenCalled();
  });

  test("a modal scope swallows combos it does not bind and shadows what it does", () => {
    const stack = createKeyScopeStack();
    const onListX = vi.fn();
    const onListEsc = vi.fn();
    const onEsc = vi.fn();
    stack.push("list", { x: onListX, escape: onListEsc }, LIST);
    stack.push("sheet", { escape: onEsc }, SHEET);
    expect(stack.dispatch(ev("x"))).toBe(false); // no leak below the modal
    expect(stack.dispatch(ev("Escape"))).toBe(true);
    expect(onEsc).toHaveBeenCalledOnce();
    expect(onListX).not.toHaveBeenCalled();
    expect(onListEsc).not.toHaveBeenCalled();
  });

  test("mod+k trigger at the palette tier beats a modal sheet AND later-registered scopes", () => {
    const stack = createKeyScopeStack();
    const onOpenPalette = vi.fn();
    stack.push("palette-trigger", { "mod+k": onOpenPalette }, TRIGGER_AT_PALETTE);
    stack.push("list", { r: vi.fn(), "mod+k": vi.fn() }, LIST); // registered later
    stack.push("sheet", { escape: vi.fn() }, SHEET); // modal, but lower tier
    expect(stack.dispatch(ev("k", { metaKey: true }))).toBe(true);
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  test("ties go to the most recent scope; re-push replaces in place without stealing recency", () => {
    const stack = createKeyScopeStack();
    const onOld = vi.fn();
    const onNew = vi.fn();
    const onTop = vi.fn();
    stack.push("sheet-a", { escape: onOld }, SHEET);
    stack.push("sheet-b", { escape: onTop }, SHEET);
    stack.push("sheet-a", { escape: onNew, e: onNew }, SHEET); // conditional binding change
    expect(stack.dispatch(ev("Escape"))).toBe(true);
    expect(onTop).toHaveBeenCalledOnce(); // sheet-b is STILL the most recent tie
    expect(onOld).not.toHaveBeenCalled();
    stack.pop("sheet-b");
    expect(stack.dispatch(ev("e"))).toBe(true); // replaced bindings are live
    expect(onNew).toHaveBeenCalledOnce();
  });

  test("re-push can change priority and modality in place", () => {
    const stack = createKeyScopeStack();
    const onList = vi.fn();
    stack.push("list", { k: onList }, LIST);
    stack.push("promoted", { escape: vi.fn() }, LIST);
    stack.push("promoted", { escape: vi.fn() }, SHEET); // now modal, above list
    expect(stack.dispatch(ev("k"))).toBe(false);
    expect(onList).not.toHaveBeenCalled();
  });

  test("pop removes an id anywhere (once, even after re-push); unknown ids no-op", () => {
    const stack = createKeyScopeStack();
    const onListKey = vi.fn();
    const onPaletteKey = vi.fn();
    stack.push("list", { k: onListKey }, LIST);
    stack.push("sheet", { e: vi.fn() }, SHEET);
    stack.push("sheet", { e: vi.fn(), escape: vi.fn() }, SHEET); // re-push: still one entry
    stack.push("palette", { p: onPaletteKey }, PALETTE);
    stack.pop("ghost"); // unknown — no-op
    stack.pop("sheet"); // middle
    expect(stack.dispatch(ev("p"))).toBe(true);
    stack.pop("palette"); // top — list is exposed again
    expect(stack.dispatch(ev("k"))).toBe(true);
    expect(onPaletteKey).toHaveBeenCalledOnce();
    expect(onListKey).toHaveBeenCalledOnce();
  });
});

describe("sequence chords", () => {
  test("g then r fires within the window; the default clock (0) stays deterministic", () => {
    const stack = createKeyScopeStack();
    const onChord = vi.fn();
    stack.push("root", { "g r": onChord }, LIST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(stack.dispatch(ev("r"), SEQUENCE_WINDOW_MS)).toBe(true);
    expect(stack.dispatch(ev("g"))).toBe(true); // no nowMs argument
    expect(stack.dispatch(ev("r"))).toBe(true);
    expect(onChord).toHaveBeenCalledTimes(2);
  });

  test("chord lifecycle: expired prefix misses, repeated prefix restarts, modified key aborts", () => {
    const stack = createKeyScopeStack();
    const onChord = vi.fn();
    stack.push("root", { "g r": onChord }, LIST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(stack.dispatch(ev("r"), SEQUENCE_WINDOW_MS + 1)).toBe(false); // expired
    expect(stack.dispatch(ev("g"), 1000)).toBe(true);
    expect(stack.dispatch(ev("g"), 1010)).toBe(true); // restarts pending
    expect(stack.dispatch(ev("r"), 1020)).toBe(true);
    expect(stack.dispatch(ev("g"), 2000)).toBe(true);
    expect(stack.dispatch(ev("r", { metaKey: true }), 2010)).toBe(false); // aborts
    expect(onChord).toHaveBeenCalledOnce();
  });

  test("wrong second key clears pending and may fire its own fresh binding", () => {
    const stack = createKeyScopeStack();
    const onChord = vi.fn();
    const onExpand = vi.fn();
    stack.push("root", { "g r": onChord, e: onExpand }, LIST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(stack.dispatch(ev("x"), 10)).toBe(false); // unbound: cleared, unhandled
    expect(stack.dispatch(ev("r"), 20)).toBe(false); // no pending anymore
    expect(stack.dispatch(ev("g"), 30)).toBe(true);
    expect(stack.dispatch(ev("e"), 40)).toBe(true); // bound wrong-second fires fresh
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onChord).not.toHaveBeenCalled();
  });

  test("chord-start consumes same-key plain; completion skips combos and clears pending", () => {
    const stack = createKeyScopeStack();
    const onPlainG = vi.fn();
    const onReviewed = vi.fn();
    const onChord = vi.fn();
    // `r` listed BEFORE the sequence: completion must skip past combo bindings
    stack.push("root", { g: onPlainG, r: onReviewed, "g r": onChord }, LIST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(onPlainG).not.toHaveBeenCalled(); // prefix outranks the plain g
    expect(stack.dispatch(ev("r"), 10)).toBe(true);
    expect(onChord).toHaveBeenCalledOnce();
    expect(onReviewed).not.toHaveBeenCalled();
    expect(stack.dispatch(ev("r"), 20)).toBe(true); // pending cleared → direct binding
    expect(onReviewed).toHaveBeenCalledOnce();
  });

  test("the highest scope binding the prefix owns the whole chord", () => {
    const stack = createKeyScopeStack();
    const onListChord = vi.fn();
    const onToastChord = vi.fn();
    stack.push("list", { "g r": onListChord }, LIST);
    stack.push("toast", { "g r": onToastChord }, TOAST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(stack.dispatch(ev("r"), 10)).toBe(true);
    expect(onToastChord).toHaveBeenCalledOnce();
    expect(onListChord).not.toHaveBeenCalled();
    stack.pop("toast"); // owner found below scopes that skip the prefix
    stack.push("toast", { a: vi.fn() }, TOAST);
    expect(stack.dispatch(ev("g"), 20)).toBe(true);
    expect(stack.dispatch(ev("r"), 30)).toBe(true);
    expect(onListChord).toHaveBeenCalledOnce();
  });

  test("a modal scope blocks chord prefixes below it; differing prefixes stay independent", () => {
    const stack = createKeyScopeStack();
    const onChord = vi.fn();
    stack.push("list", { "g r": onChord, "h x": vi.fn() }, LIST);
    expect(stack.dispatch(ev("g"), 0)).toBe(true);
    expect(stack.dispatch(ev("x"), 10)).toBe(false); // "h x" needs an h prefix
    stack.push("sheet", { escape: vi.fn() }, SHEET);
    expect(stack.dispatch(ev("g"), 20)).toBe(false); // blocked by the modal
    expect(stack.dispatch(ev("r"), 30)).toBe(false);
    expect(onChord).not.toHaveBeenCalled();
  });

  test("push, pop, and emptying the stack all invalidate an in-flight chord", () => {
    const stack = createKeyScopeStack();
    const onChord = vi.fn();
    stack.push("root", { "g r": onChord }, LIST);
    stack.dispatch(ev("g"), 0);
    stack.push("sheet", { "g r": onChord }, { priority: PRIORITIES.sheet });
    expect(stack.dispatch(ev("r"), 10)).toBe(false);
    stack.dispatch(ev("g"), 20);
    stack.pop("sheet");
    expect(stack.dispatch(ev("r"), 30)).toBe(false);
    stack.dispatch(ev("g"), 40);
    stack.pop("root"); // empty mid-chord
    expect(stack.dispatch(ev("r"), 50)).toBe(false);
    stack.push("root", { "g r": onChord }, LIST);
    expect(stack.dispatch(ev("r"), 60)).toBe(false);
    expect(onChord).not.toHaveBeenCalled();
  });

  test("different chords under the same prefix coexist", () => {
    const stack = createKeyScopeStack();
    const onRecurring = vi.fn();
    const onTransactions = vi.fn();
    stack.push("root", { "g r": onRecurring, "g t": onTransactions }, LIST);
    stack.dispatch(ev("g"), 0);
    expect(stack.dispatch(ev("t"), 10)).toBe(true);
    expect(onTransactions).toHaveBeenCalledOnce();
    expect(onRecurring).not.toHaveBeenCalled();
  });
});

describe("binding grammar validation", () => {
  test.each(["", "mod+", "meta+k", "alt+k", "ctrl+k"])("push rejects invalid combo %j", (combo) => {
    const stack = createKeyScopeStack();
    expect(() => stack.push("bad", { [combo]: vi.fn() }, LIST)).toThrow(/Invalid key binding/);
  });

  test("push rejects three-key sequences", () => {
    const stack = createKeyScopeStack();
    expect(() => stack.push("bad", { "g r x": vi.fn() }, LIST)).toThrow(/exactly two keys/);
  });

  test.each(["mod+k r", "g mod+r"])("push rejects modified chord keys %j", (combo) => {
    const stack = createKeyScopeStack();
    expect(() => stack.push("bad", { [combo]: vi.fn() }, LIST)).toThrow(/plain keys/);
  });
});
