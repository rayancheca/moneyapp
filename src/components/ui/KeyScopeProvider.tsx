"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createKeyScopeStack, type KeyHandler, type KeyScopeOptions } from "@/lib/keyscope";

/**
 * One app-wide stack (module-level singleton) so every scope — palette,
 * toast, sheet, list, trigger — shares a single priority order regardless of
 * where in the tree it registers.
 */
const keyScopeStack = createKeyScopeStack();

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/**
 * Mounts the ONE window keydown listener that feeds the scope stack.
 * Render once near the app root; nested providers would double-dispatch.
 */
export function KeyScopeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Keys during IME composition edit the composition, never the app —
      // Esc must cancel the conversion, not close the palette/sheet. 229 is
      // the legacy keyCode some platforms still send for composition keys.
      if (event.isComposing || event.keyCode === 229) return;
      const handled = keyScopeStack.dispatch(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          targetIsEditable: isEditableTarget(event.target),
        },
        Date.now(),
      );
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <>{children}</>;
}

/**
 * Registers a keyboard scope while `active` is true; pops on cleanup.
 * Handlers stay fresh through a ref, so re-renders never touch the stack —
 * only the combo *keys* changing (or toggling `active`) does.
 *
 * `options.priority` should be a PRIORITIES tier (lib/keyscope); pass
 * `modal: true` for surfaces that must swallow unbound combos (sheet,
 * palette) so lower-tier mnemonics can never fire underneath them.
 */
export function useKeyScope(
  id: string,
  bindings: Record<string, KeyHandler>,
  active: boolean,
  options: KeyScopeOptions,
): void {
  const latest = useRef(bindings);
  useEffect(() => {
    latest.current = bindings;
  });

  // combo strings never contain "|", so this join is a safe identity key
  const combos = Object.keys(bindings).join("|");
  const { priority, modal = false } = options;

  // Registration is split across two effects so a conditional binding change
  // re-pushes WITHOUT popping first: push() replaces a live id in place,
  // which keeps the scope's recency among equal-priority peers (a pop+push
  // cycle would move it to "most recent" and reorder ties).
  useEffect(() => {
    if (!active) return;
    const proxied: Record<string, KeyHandler> = {};
    for (const combo of combos.split("|")) {
      if (combo === "") continue;
      proxied[combo] = () => {
        latest.current[combo]?.();
      };
    }
    keyScopeStack.push(id, proxied, { priority, modal });
  }, [id, combos, active, priority, modal]);

  useEffect(() => {
    if (!active) return;
    return () => keyScopeStack.pop(id);
  }, [id, active]);
}
