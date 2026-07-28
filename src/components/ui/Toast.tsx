"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TransitionEvent } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/shell/Icon";

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 3;
/** Exit-removal safety net — must outlast --duration-normal (300ms). */
const EXIT_FALLBACK_MS = 400;

export type ToastTone = "neutral" | "positive" | "negative";

/** What a toast card says when an action failed without a readable message. */
export const TOAST_ACTION_FAILED = "That didn’t go through — try again";

/** What an action reports back so the card knows whether it actually worked. */
export interface ToastActionOutcome {
  ok: boolean;
  error?: string;
}

/** Returning nothing keeps the old fire-and-forget behaviour. */
export type ToastActionResult = void | ToastActionOutcome;

export interface ToastAction {
  label: string;
  /**
   * May be async. The card waits for it and only dismisses on success — an
   * Undo whose patch lives in this closure must survive a failed attempt.
   */
  onAction: () => ToastActionResult | Promise<ToastActionResult>;
}

/** Recognised structurally so a caller may resolve with anything at all. */
function isOutcome(value: ToastActionResult): value is ToastActionOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ToastActionOutcome).ok === "boolean"
  );
}

export interface ToastActionSettlement {
  /** dismiss the card only when the action actually worked */
  readonly dismiss: boolean;
  /** what to show in place of dismissal (null on success) */
  readonly error: string | null;
}

/**
 * What a card does once its action settles. Dismissing on failure was the
 * worst half of the undo bug: the card was torn down synchronously on click,
 * so a failed Undo took its own patch with it and left no way to retry and no
 * way to even know. Success dismisses; a reported `{ ok: false }` or a THROWN
 * action keeps the card — and its closure — alive, saying what went wrong.
 */
export function settleToastAction(
  settled: { status: "resolved"; value: ToastActionResult } | { status: "rejected"; reason: unknown },
): ToastActionSettlement {
  if (settled.status === "rejected") {
    const message = settled.reason instanceof Error ? settled.reason.message.trim() : "";
    return { dismiss: false, error: message === "" ? TOAST_ACTION_FAILED : message };
  }
  if (!isOutcome(settled.value)) return { dismiss: true, error: null };
  if (settled.value.ok) return { dismiss: true, error: null };
  const message = settled.value.error?.trim() ?? "";
  return { dismiss: false, error: message === "" ? TOAST_ACTION_FAILED : message };
}

export interface ToastOptions {
  title: string;
  description?: string;
  /** Toasts with an action never auto-dismiss while it is available. */
  action?: ToastAction;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: string;
  exiting: boolean;
}

// Module-level store: call sites import toast() directly, no provider.
let items: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function update(next: readonly ToastItem[]): void {
  items = next;
  listeners.forEach((listener) => listener());
}

/** Show a toast; returns its id for programmatic dismissal. */
export function toast(options: ToastOptions): string {
  const id = `toast-${nextId}`;
  nextId += 1;
  const next: readonly ToastItem[] = [...items, { ...options, id, exiting: false }];
  // The visible cap counts only live, actionless toasts: an action toast is
  // NEVER evicted (its affordance must survive bursts — plan §2.5's
  // no-auto-dismiss contract), and exiting cards no longer hold a slot.
  // Overflow leaves via the animated exiting path, oldest first; the stack
  // may exceed MAX_VISIBLE while every remaining toast carries an action.
  const evictable = next.filter((item) => !item.exiting && item.action === undefined);
  const overflow = evictable.slice(0, Math.max(0, evictable.length - MAX_VISIBLE));
  const overflowIds = new Set(overflow.map((item) => item.id));
  update(next.map((item) => (overflowIds.has(item.id) ? { ...item, exiting: true } : item)));
  return id;
}

/** Starts the exit transition; the card removes itself when it finishes. */
export function dismissToast(id: string): void {
  update(items.map((item) => (item.id === id ? { ...item, exiting: true } : item)));
}

/**
 * Moves DOM focus to the newest live toast's action button, returning false
 * when there is nothing to focus (no action toast, or not yet rendered).
 * Stage 1 binds this to the scoped `A` mnemonic (KeyScope `toast` tier,
 * lib/keyscope PRIORITIES.toast) — reaching a toast action by Tab alone is a
 * full-document traversal and is not an acceptable steady state. No key is
 * bound here; the binding belongs to the flow that owns the mnemonic.
 */
export function focusNewestToastAction(): boolean {
  const newest = items.findLast((item) => !item.exiting && item.action !== undefined);
  if (newest === undefined) return false;
  const button = document.querySelector<HTMLButtonElement>(
    `[data-toast-action-for="${newest.id}"]`,
  );
  if (button === null) return false;
  button.focus();
  return true;
}

function removeToast(id: string): void {
  update(items.filter((item) => item.id !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

const SERVER_SNAPSHOT: readonly ToastItem[] = [];

function getServerSnapshot(): readonly ToastItem[] {
  return SERVER_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// Modal-root registry. While a modal <dialog> is open, every node outside its
// subtree is inert per the HTML spec — a popover="manual" stack in the top
// layer would PAINT above the sheet but be dead to mouse and keyboard. Sheet
// registers its dialog node here so ToastHost can portal the stack inside the
// top-most open modal, keeping toast actions clickable mid-flow.
let modalRoots: readonly HTMLElement[] = [];
const modalListeners = new Set<() => void>();

function notifyModalListeners(): void {
  modalListeners.forEach((listener) => listener());
}

/** Called by Sheet on open; the returned cleanup unregisters on close. */
export function registerModalRoot(node: HTMLElement): () => void {
  modalRoots = [...modalRoots, node];
  notifyModalListeners();
  return () => {
    modalRoots = modalRoots.filter((root) => root !== node);
    notifyModalListeners();
  };
}

function subscribeModalRoots(listener: () => void): () => void {
  modalListeners.add(listener);
  return () => {
    modalListeners.delete(listener);
  };
}

function getTopModalRoot(): HTMLElement | null {
  return modalRoots.at(-1) ?? null;
}

function getServerModalRoot(): null {
  return null;
}

const TONE_ICON: Record<Exclude<ToastTone, "neutral">, { name: IconName; className: string }> = {
  positive: { name: "circle-check", className: "text-positive" },
  negative: { name: "circle-alert", className: "text-negative" },
};

function ToastCard({ item }: { item: ToastItem }) {
  const remainingRef = useRef(item.durationMs ?? DEFAULT_DURATION_MS);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAction = item.action !== undefined;
  // an in-flight action and, after a failed one, what went wrong. Both stay
  // local to the card: the store holds what to offer, not how the offer is going
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const runningRef = useRef(false);
  // Persistent = never auto-dismisses. Action toasts qualify (their affordance
  // must survive), and so does an explicit durationMs <= 0 / non-finite —
  // the escape hatch Stage-1 interaction states use for actionless-but-pinned
  // toasts. Without this guard a 0/Infinity duration flows into setTimeout and
  // fires on the next tick (Math.max(0, …)), the opposite of "persistent".
  const persistent =
    hasAction ||
    (item.durationMs !== undefined && (!Number.isFinite(item.durationMs) || item.durationMs <= 0));

  const pauseTimer = useCallback(() => {
    if (timerRef.current === null || startedAtRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current -= Date.now() - startedAtRef.current;
    startedAtRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    if (persistent || item.exiting || timerRef.current !== null) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => dismissToast(item.id), Math.max(0, remainingRef.current));
  }, [persistent, item.exiting, item.id]);

  useEffect(() => {
    startTimer();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [startTimer]);

  // safety net in case the opacity transitionend never fires
  useEffect(() => {
    if (!item.exiting) return;
    const fallback = setTimeout(() => removeToast(item.id), EXIT_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [item.exiting, item.id]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (item.exiting && event.propertyName === "opacity") removeToast(item.id);
  };

  // Run the action and keep the card alive until it SETTLES. The ref guards
  // re-entry (a second click while the first is in flight would run an undo
  // twice); the button stays enabled and focusable throughout, because a
  // disabled button drops keyboard focus to <body>.
  const runAction = async (): Promise<void> => {
    const action = item.action;
    if (action === undefined || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setActionError(null);
    let settlement: ToastActionSettlement;
    try {
      settlement = settleToastAction({ status: "resolved", value: await action.onAction() });
    } catch (reason: unknown) {
      settlement = settleToastAction({ status: "rejected", reason });
    }
    runningRef.current = false;
    setRunning(false);
    if (settlement.dismiss) dismissToast(item.id);
    else setActionError(settlement.error);
  };

  const tone = item.tone === "positive" || item.tone === "negative" ? TONE_ICON[item.tone] : null;

  return (
    <div
      onMouseEnter={pauseTimer}
      onMouseLeave={startTimer}
      onFocus={pauseTimer}
      onBlur={startTimer}
      onTransitionEnd={handleTransitionEnd}
      className={`pointer-events-auto w-full max-w-sm rounded-(--radius-overlay) border border-line bg-surface-overlay p-3 shadow-(--shadow-overlay) transition-[opacity,translate] duration-(--duration-normal) ease-(--ease-out-expo) starting:translate-y-2 starting:opacity-0 ${
        item.exiting ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {tone ? (
          <Icon name={tone.name} className={`mt-0.5 size-4 shrink-0 ${tone.className}`} />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{item.title}</p>
          {item.description ? (
            <p className="mt-0.5 text-xs text-ink-muted">{item.description}</p>
          ) : null}
          {item.action ? (
            <button
              type="button"
              data-toast-action-for={item.id}
              aria-busy={running}
              onClick={() => void runAction()}
              className={`mt-2 inline-flex items-center rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent transition-colors duration-(--duration-fast) hover:bg-accent hover:text-surface-raised ${
                running ? "opacity-60" : ""
              }`}
            >
              {item.action.label}
            </button>
          ) : null}
          {/* role="alert" is how a failure reaches a screen reader at all: the
              host's live region announces the newest STORE item, and a card's
              own failure never changes the store. */}
          {actionError !== null ? (
            <p role="alert" className="mt-1.5 text-xs text-negative">
              {actionError}
            </p>
          ) : null}
        </div>
        <IconButton
          icon="close"
          size="sm"
          aria-label="Dismiss"
          onClick={() => dismissToast(item.id)}
          className="shrink-0 text-ink-muted hover:text-ink"
        />
      </div>
    </div>
  );
}

function buildAnnouncement(item: ToastItem): string {
  const parts = [item.title];
  if (item.description !== undefined) parts.push(item.description);
  // Screen-reader users must learn a button appeared — action toasts never
  // auto-dismiss, so an unannounced action is functionally invisible.
  if (item.action !== undefined) parts.push(`Action available: ${item.action.label}`);
  return `${parts.join(". ")}.`;
}

/**
 * Mount once in the shell. With no modal open, the stack is a
 * popover="manual" region: top layer, no light dismiss, and showing it never
 * moves focus. While a modal Sheet is open the stack instead portals INSIDE
 * that dialog — top-layer position alone is NOT enough, because showModal()
 * makes everything outside the dialog's subtree inert (unclickable and
 * unfocusable). Bottom-right on sm+, bottom-center below.
 */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const modalRoot = useSyncExternalStore(subscribeModalRoots, getTopModalRoot, getServerModalRoot);
  const regionRef = useRef<HTMLDivElement>(null);
  const usesPopoverHost = modalRoot === null;

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    try {
      if (toasts.length > 0) {
        // Re-promote on every change: top-layer paint order is insertion
        // order, so a dialog opened after this region entered the top layer
        // would sit above it (its ::backdrop dimming and intercepting the
        // toasts) until the region re-enters last.
        if (region.matches(":popover-open")) region.hidePopover();
        region.showPopover();
      } else if (region.matches(":popover-open")) {
        region.hidePopover();
      }
    } catch {
      // hide/show can race teardown (detached node) — never worth throwing
    }
  }, [toasts.length, usesPopoverHost]);

  const newest = toasts.findLast((item) => !item.exiting);
  const announcement = newest === undefined ? "" : buildAnnouncement(newest);
  const cards = toasts.map((item) => <ToastCard key={item.id} item={item} />);

  return (
    <>
      {/* Singleton polite live region: content is replaced, never stacked, so
          rapid toasts throttle to the newest announcement. Lives outside the
          popover so it is never display:none while announcing. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {usesPopoverHost ? (
        <div
          ref={regionRef}
          popover="manual"
          // display comes only from :popover-open — a bare `flex` would defeat
          // the UA's display:none on the closed popover
          className="pointer-events-none top-auto right-4 bottom-4 left-4 m-0 w-auto flex-col items-center gap-2 overflow-visible border-0 bg-transparent p-0 [&:popover-open]:flex sm:left-auto sm:w-96 sm:items-end"
        >
          {cards}
        </div>
      ) : (
        createPortal(
          <div className="pointer-events-none absolute right-4 bottom-4 left-4 z-10 flex flex-col items-center gap-2 sm:left-auto sm:w-96 sm:items-end">
            {cards}
          </div>,
          modalRoot,
        )
      )}
    </>
  );
}
