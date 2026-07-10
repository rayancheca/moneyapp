/**
 * Pure keyboard-scope stack — the precedence spine of the keyboard grammar
 * (plan §1.7/§2.5): palette > toast > sheet > list > trigger, expressed as
 * explicit numeric priorities rather than push order. Zero DOM; the React
 * binding lives in components/ui/KeyScopeProvider.tsx.
 *
 * Combo grammar:
 *   "k"          plain key (mnemonic)
 *   "shift+k"    shifted key
 *   "mod+k"      mod = meta OR ctrl
 *   "escape"     key names are matched case-insensitively
 *   "g r"        sequence chord: g then r within SEQUENCE_WINDOW_MS
 *
 * Dispatch rules:
 *   - Scopes are consulted from highest priority down; the first scope that
 *     binds the combo handles it. Priority ties resolve to the most recently
 *     registered scope.
 *   - A `modal` scope stops the walk: combos it does not bind are unhandled
 *     rather than falling through (an open sheet/palette must swallow list
 *     mnemonics). Combos bound at a priority ABOVE a modal scope still fire.
 *   - Re-pushing an existing id replaces its bindings IN PLACE — conditional
 *     bindings can never reorder equal-priority scopes.
 *   - When the event target is editable, plain/shifted mnemonics and chords
 *     are ignored (typing must never trigger them) — "mod+…" and "escape"
 *     still fire, walking scopes under the same rules.
 *   - A key that starts a chord is consumed as the prefix by the first scope
 *     in the walk that binds it; the chord completes in that same scope. A
 *     same-key plain binding in that scope is therefore unreachable.
 */

export type KeyHandler = () => void;

/**
 * Canonical scope tiers: higher wins. `toast` sits ABOVE the modal sheet
 * tier so Stage 1's accept mnemonic stays reachable while a sheet is open
 * (action toasts fire from in-sheet flows), yet below the palette. The ⌘K
 * trigger intentionally registers at the `palette` tier (see CommandPalette)
 * so mod+k stays reachable above modal sheet scopes; `trigger` is the tier
 * for ambient triggers that modals SHOULD silence.
 */
export const PRIORITIES = {
  trigger: 0,
  list: 1,
  sheet: 2,
  toast: 2.5,
  palette: 3,
} as const;

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  targetIsEditable: boolean;
}

export interface KeyScopeOptions {
  /** Dispatch tier — use a PRIORITIES value unless a surface needs a custom slot. */
  priority: number;
  /** Modal scopes stop the walk: combos they do not bind go unhandled. */
  modal?: boolean;
}

export interface KeyScopeStack {
  /**
   * Registers a scope, or — when the id already exists — replaces its
   * bindings/priority/modal flag in place without disturbing its position
   * among equal-priority scopes. `modal` scopes block fall-through of
   * combos they do not bind.
   */
  push(id: string, bindings: Record<string, KeyHandler>, opts: KeyScopeOptions): void;
  /** Removes that id wherever it sits; unknown ids are a no-op. */
  pop(id: string): void;
  /**
   * Returns true when some scope handled the event (see dispatch rules).
   * `nowMs` is an injected clock used only for sequence-chord timing; it
   * defaults to 0 so tests are deterministic — real callers (the provider)
   * must pass a monotonic timestamp or chords will never expire.
   */
  dispatch(e: KeyEventLike, nowMs?: number): boolean;
}

export const SEQUENCE_WINDOW_MS = 800;

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
}

type ParsedBinding =
  | { kind: "combo"; combo: Combo; handler: KeyHandler }
  | { kind: "sequence"; first: string; second: string; handler: KeyHandler };

interface Scope {
  id: string;
  bindings: readonly ParsedBinding[];
  priority: number;
  modal: boolean;
  /** Registration sequence — breaks priority ties toward the most recent. */
  seq: number;
}

function parseCombo(source: string, handler: KeyHandler): ParsedBinding {
  const tokens = source.toLowerCase().split("+");
  const key = tokens.pop();
  if (!key) {
    throw new Error(`Invalid key binding "${source}": missing key`);
  }
  let mod = false;
  let shift = false;
  for (const token of tokens) {
    if (token === "mod") {
      mod = true;
    } else if (token === "shift") {
      shift = true;
    } else {
      throw new Error(`Invalid key binding "${source}": unknown modifier "${token}"`);
    }
  }
  return { kind: "combo", combo: { key, mod, shift }, handler };
}

function parseBinding(source: string, handler: KeyHandler): ParsedBinding {
  const trimmed = source.trim();
  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex === -1) {
    return parseCombo(trimmed, handler);
  }
  const first = trimmed.slice(0, spaceIndex);
  const second = trimmed.slice(spaceIndex).trim();
  if (second.search(/\s/) !== -1) {
    throw new Error(`Invalid sequence binding "${source}": chords are exactly two keys`);
  }
  if (first.includes("+") || second.includes("+")) {
    throw new Error(`Invalid sequence binding "${source}": chord keys must be plain keys`);
  }
  return { kind: "sequence", first: first.toLowerCase(), second: second.toLowerCase(), handler };
}

function comboMatches(combo: Combo, e: KeyEventLike): boolean {
  const hasMod = e.metaKey || e.ctrlKey;
  return (
    e.key.toLowerCase() === combo.key &&
    hasMod === combo.mod &&
    e.shiftKey === combo.shift &&
    !e.altKey
  );
}

export function createKeyScopeStack(): KeyScopeStack {
  let scopes: readonly Scope[] = [];
  // The owning scope is stored by reference: push/pop clear pending, so a
  // live pending always points at a scope that is still registered.
  let pending: { first: string; scope: Scope; at: number } | null = null;
  let nextSeq = 0;

  function ordered(): readonly Scope[] {
    return [...scopes].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  }

  function push(id: string, bindings: Record<string, KeyHandler>, opts: KeyScopeOptions): void {
    const { priority, modal = false } = opts;
    const parsed = Object.entries(bindings).map(([source, handler]) =>
      parseBinding(source, handler),
    );
    const exists = scopes.some((scope) => scope.id === id);
    scopes = exists
      ? // In-place replace keeps `seq`, so a re-push never reorders ties.
        scopes.map((scope) =>
          scope.id === id ? { ...scope, bindings: parsed, priority, modal } : scope,
        )
      : [...scopes, { id, bindings: parsed, priority, modal, seq: nextSeq++ }];
    pending = null; // any scope change invalidates an in-flight chord
  }

  function pop(id: string): void {
    scopes = scopes.filter((scope) => scope.id !== id);
    pending = null;
  }

  function dispatch(e: KeyEventLike, nowMs = 0): boolean {
    const key = e.key.toLowerCase();
    const hasMod = e.metaKey || e.ctrlKey;
    const isPlain = !hasMod && !e.altKey && !e.shiftKey;

    if (e.targetIsEditable) {
      pending = null;
      for (const scope of ordered()) {
        for (const binding of scope.bindings) {
          if (
            binding.kind === "combo" &&
            (binding.combo.mod || binding.combo.key === "escape") &&
            comboMatches(binding.combo, e)
          ) {
            binding.handler();
            return true;
          }
        }
        if (scope.modal) return false;
      }
      return false;
    }

    if (pending !== null) {
      const chord = pending;
      pending = null;
      if (isPlain && nowMs - chord.at <= SEQUENCE_WINDOW_MS) {
        for (const binding of chord.scope.bindings) {
          if (
            binding.kind === "sequence" &&
            binding.first === chord.first &&
            binding.second === key
          ) {
            binding.handler();
            return true;
          }
        }
      }
      // expired or wrong key: fall through and treat this press fresh
    }

    for (const scope of ordered()) {
      if (isPlain && scope.bindings.some((b) => b.kind === "sequence" && b.first === key)) {
        pending = { first: key, scope, at: nowMs };
        return true;
      }
      for (const binding of scope.bindings) {
        if (binding.kind === "combo" && comboMatches(binding.combo, e)) {
          binding.handler();
          return true;
        }
      }
      if (scope.modal) return false;
    }
    return false;
  }

  return { push, pop, dispatch };
}
