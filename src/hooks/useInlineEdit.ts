"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  IDLE,
  inlineEditReducer,
  keyToIntent,
  type CommitOutcome,
} from "@/lib/inline-edit";
import { toast, type ToastActionResult } from "@/components/ui/Toast";

export interface InlineSaveResult {
  ok: boolean;
  error?: string;
}

interface UseInlineEditParams<T> {
  /** the committed value from the server (source of truth) */
  value: T;
  /** value → the string the input is seeded/edited with */
  format: (value: T) => string;
  /** decide save / no-op / invalid from the current display value + draft */
  resolve: (original: T, draft: string) => CommitOutcome<T>;
  /** persist a committed value; optimistic UI reverts if this resolves !ok or throws */
  onSave: (value: T) => Promise<InlineSaveResult>;
  /** accessible name for the trigger + input */
  label: string;
  /** toast title for a committed save (the toast carries an Undo action) */
  describe?: (value: T) => string;
}

/** What one save of an inline field reads and writes in its hook — handed in, so the save is a plain function. */
export interface InlineSaveIO<T> {
  readonly onSave: (value: T) => Promise<InlineSaveResult>;
  readonly describe?: (value: T) => string;
  readonly setDisplay: (value: T) => void;
  readonly setPending: (pending: boolean) => void;
  /** monotonic id per save; only the latest may mutate display/pending/toast */
  readonly seq: { current: number };
}

/**
 * One save of an inline field: optimistic, rolled back on failure, and on success a toast whose Undo is the same save
 * the other way. Outside the hook so a test can press that Undo — no jsdom here, as with `useAction`'s two halves.
 * The Undo RETURNS its save's outcome (`offerUndoToast` is the model): a refused or failed undo keeps the card — and
 * `previous` in its closure — to be pressed again, and the card says why.
 */
export async function persistInlineEdit<T>(
  io: InlineSaveIO<T>,
  next: T,
  previous: T,
  undoable: boolean,
): Promise<ToastActionResult> {
  const seq = (io.seq.current += 1);
  io.setDisplay(next); // optimistic
  io.setPending(true);
  let ok = false;
  let errorMessage: string | undefined;
  try {
    const result = await io.onSave(next);
    ok = result.ok;
    errorMessage = result.error;
  } catch {
    // a thrown/rejected save (transport failure) is a failure, not a success
    ok = false;
  }
  // superseded by a newer save — let that one own display/pending/toast; an Undo it overtook closes its card, the
  // field being the newer save's now
  if (seq !== io.seq.current) return;
  io.setPending(false);
  if (!ok) {
    io.setDisplay(previous); // rollback
    const error = errorMessage ?? "Couldn’t save that — try again";
    // an Undo's failure is said on its own card, which stays; a save has no card to say it on
    if (undoable) toast({ title: error, tone: "negative" });
    return { ok: false, error };
  }
  if (undoable) {
    toast({
      title: io.describe ? io.describe(next) : "Saved",
      action: { label: "Undo", onAction: () => persistInlineEdit(io, previous, next, false) },
    });
  }
  return { ok: true };
}

/**
 * Client glue for an inline "click-to-edit" field, over the pure state machine
 * in lib/inline-edit. Owns: the editing/draft reducer, optimistic display with
 * rollback on failure (including a THROWN save — network/RPC rejection, which
 * this app sees on flaky wifi), a generation guard so a late-failing earlier
 * save can't clobber a newer one, a Toast+Undo on success, keyboard focus
 * return to the trigger, and the Enter/Escape/blur grammar. Components are thin
 * renderers of what this returns. Verified via e2e (no jsdom in this project);
 * its save, `persistInlineEdit`, is a plain function with tests of its own.
 */
export function useInlineEdit<T>({
  value,
  format,
  resolve,
  onSave,
  label,
  describe,
}: UseInlineEditParams<T>) {
  const [state, dispatch] = useReducer(inlineEditReducer, IDLE);
  const [display, setDisplay] = useState<T>(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // set on a keyboard-initiated close so focus returns to the trigger (a
  // click-away/blur close must NOT steal focus back to it)
  const refocusRef = useRef(false);
  // monotonic id per save; only the latest may mutate display/pending/toast
  const saveSeqRef = useRef(0);

  // Adopt a genuinely-new server value (React "adjust state on prop change"):
  // only when the prop actually changes and we're not mid-edit — so an
  // optimistic display is never clobbered by a stale render before refresh.
  const lastValueRef = useRef<T>(value);
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    if (!state.editing) setDisplay(value);
  }

  const persist = useCallback(
    (next: T, previous: T, undoable: boolean) =>
      persistInlineEdit({ onSave, describe, setDisplay, setPending, seq: saveSeqRef }, next, previous, undoable),
    [onSave, describe],
  );

  const begin = useCallback(() => {
    setError(null);
    dispatch({ type: "begin", value: format(display) });
  }, [display, format]);

  const change = useCallback((draft: string) => dispatch({ type: "change", draft }), []);

  const commit = useCallback(() => {
    if (!state.editing) return;
    const outcome = resolve(display, state.draft);
    if (outcome.kind === "invalid") {
      setError(outcome.error);
      return;
    }
    setError(null);
    dispatch({ type: "close" });
    if (outcome.kind === "save") void persist(outcome.value, display, true);
    // no-op: reconcile to the current server value (in case it changed during the edit)
    else setDisplay(value);
  }, [state, resolve, display, persist, value]);

  const cancel = useCallback(() => {
    setError(null);
    // discard the draft AND any staleness — snap back to current server truth
    setDisplay(value);
    dispatch({ type: "close" });
  }, [value]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const intent = keyToIntent(event.key);
      if (!intent) return;
      event.preventDefault();
      refocusRef.current = true; // keyboard close → return focus to the trigger
      if (intent === "commit") commit();
      else cancel();
    },
    [commit, cancel],
  );

  // focus + select the draft on entering edit; return focus to the trigger when
  // a keyboard action closed it (blur-close leaves focus wherever the user went)
  useEffect(() => {
    if (state.editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocusRef.current) {
      refocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [state.editing]);

  return {
    editing: state.editing,
    draft: state.editing ? state.draft : "",
    display,
    error,
    pending,
    inputRef,
    triggerRef,
    label,
    begin,
    change,
    commit,
    cancel,
    onKeyDown,
  } as const;
}
