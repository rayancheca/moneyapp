"use client";

import { useCallback, useRef, useState } from "react";
import type { ActionResult } from "@/app/transactions/action-types";
import { toast } from "@/components/ui/Toast";

/** What a failure says when the server handed us nothing readable. */
export const ACTION_FAILED = "Couldn’t do that — try again";

/**
 * Await a server action and normalize BOTH failure shapes into one
 * {@link ActionResult}: a reported `{ ok: false }` keeps the server's own
 * message, and a THROWN call becomes a failure instead of an unhandled
 * rejection nobody sees. A throw is not hypothetical here — a transport/RPC
 * rejection (flaky wifi) and a server action that throws before it can build a
 * result both land in the catch, and the historical `.then((r) => { if (r.ok)
 * … })` shape treated all of it as silence.
 *
 * Pure: no React, no toasts. {@link useAction} layers those on top, and the
 * module-level toast actions (undo-toast, SplitEditor) reuse it directly.
 */
export async function settleAction<T>(
  task: () => Promise<ActionResult<T>>,
  fallback: string = ACTION_FAILED,
): Promise<ActionResult<T>> {
  try {
    const result = await task();
    if (result.ok) return result;
    return result.error.trim() === "" ? { ok: false, error: fallback } : result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.trim() : "";
    return { ok: false, error: message === "" ? fallback : message };
  }
}

/**
 * Monotonic generation counter shared by every run of one hook instance.
 * `begin()` claims the next generation and hands back a predicate that stays
 * true only while that run is still the newest — so a slow first request can
 * never overwrite state a fast second one already wrote (the same guard
 * useInlineEdit runs on a single field, here scoped to one component).
 */
export function createRunGuard(): { begin: () => () => boolean } {
  let latest = 0;
  return {
    begin: () => {
      const seq = (latest += 1);
      return () => seq === latest;
    },
  };
}

export interface RunOptions<T> {
  /** runs only when the call succeeded AND is still the newest run */
  onSuccess?: (data: T) => void;
  /** replaces the default negative toast — still called for a superseded run */
  onError?: (message: string) => void;
  /** what a thrown call (or a blank server message) says */
  fallback?: string;
}

/**
 * The one way a client component calls a server action (audit items 5+6): a
 * `pending` flag cleared in a `finally`, a failure that is ALWAYS surfaced —
 * the whole bug class this replaces was `.then((r) => { if (r.ok) … })`, where
 * a rejected call and a `{ ok: false }` were both indistinguishable from
 * success — and a staleness guard so a slow first request cannot overwrite a
 * fast second one.
 *
 * Deliberate deviation from useInlineEdit: a superseded run still reports its
 * failure. There, a newer save of the SAME field makes the older answer
 * irrelevant; here the calls are independent (delete rule A, then rule B), so
 * swallowing A's failure would be the silent failure all over again. What a
 * stale run may not do is write shared state (`pending`, `error`) or fire
 * `onSuccess` — the newest run owns those.
 *
 * `run` resolves with the normalized result, which is exactly the shape a
 * toast action returns to keep its card alive on failure.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guardRef = useRef(createRunGuard());

  const run = useCallback(
    async <T>(
      task: () => Promise<ActionResult<T>>,
      options?: RunOptions<T>,
    ): Promise<ActionResult<T>> => {
      const isLatest = guardRef.current.begin();
      setPending(true);
      setError(null);
      let result: ActionResult<T>;
      try {
        result = await settleAction(task, options?.fallback);
      } finally {
        // a superseded run must not un-pend the UI the newer run owns
        if (isLatest()) setPending(false);
      }
      if (!result.ok) {
        if (isLatest()) setError(result.error);
        if (options?.onError) options.onError(result.error);
        else toast({ title: result.error, tone: "negative" });
        return result;
      }
      if (isLatest()) options?.onSuccess?.(result.data);
      return result;
    },
    [],
  );

  return { run, pending, error } as const;
}
