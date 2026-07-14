"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  IDLE,
  inlineEditReducer,
  keyToIntent,
  type CommitOutcome,
} from "@/lib/inline-edit";
import { toast } from "@/components/ui/Toast";

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

/**
 * Client glue for an inline "click-to-edit" field, over the pure state machine
 * in lib/inline-edit. Owns: the editing/draft reducer, optimistic display with
 * rollback on failure (including a THROWN save — network/RPC rejection, which
 * this app sees on flaky wifi), a generation guard so a late-failing earlier
 * save can't clobber a newer one, a Toast+Undo on success, keyboard focus
 * return to the trigger, and the Enter/Escape/blur grammar. Components are thin
 * renderers of what this returns. Verified via e2e (no jsdom in this project).
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
    async (next: T, previous: T, undoable: boolean): Promise<void> => {
      const seq = (saveSeqRef.current += 1);
      setDisplay(next); // optimistic
      setPending(true);
      let ok = false;
      let errorMessage: string | undefined;
      try {
        const result = await onSave(next);
        ok = result.ok;
        errorMessage = result.error;
      } catch {
        // a thrown/rejected save (transport failure) is a failure, not a success
        ok = false;
      }
      // superseded by a newer save — let that one own display/pending/toast
      if (seq !== saveSeqRef.current) return;
      setPending(false);
      if (!ok) {
        setDisplay(previous); // rollback
        toast({ title: errorMessage ?? "Couldn’t save that — try again", tone: "negative" });
        return;
      }
      if (undoable) {
        toast({
          title: describe ? describe(next) : "Saved",
          action: { label: "Undo", onAction: () => void persist(previous, next, false) },
        });
      }
    },
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
