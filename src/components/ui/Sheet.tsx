"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/Button";
import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { registerModalRoot } from "@/components/ui/Toast";
import { PRIORITIES } from "@/lib/keyscope";
import styles from "./sheet.module.css";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Pinned below the scrollable body — bulk actions, confirm rows. */
  footer?: ReactNode;
  /** Reserved for future placements; only the right drawer exists today. */
  side?: "right";
  /** Tailwind max-width class capping the panel width. */
  widthClass?: string;
}

/**
 * Detail drawer on native <dialog>: right drawer on md+, bottom sheet below.
 * showModal() gives focus trap, top layer, and focus return for free; the
 * open prop stays authoritative so exits run their CSS transition. While
 * open, the sheet holds the modal `sheet` tier of the KeyScope stack (Esc
 * pops this scope only; list mnemonics below never leak through) and hands
 * its dialog node to the toast layer so action toasts stay reachable.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = "max-w-md",
}: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Backdrop close must see the FULL gesture on the backdrop: a text-select
  // drag that starts in an input and releases over the backdrop fires its
  // click on the dialog (nearest common ancestor) — that must not close.
  const pointerDownOnBackdropRef = useRef(false);
  const titleId = useId();
  const scopeId = useId();

  // Esc routes through the stack so "Esc pops the top scope only" holds by
  // construction; the native cancel handler below stays as a backup for the
  // paths KeyScope never sees (e.g. browser-initiated closes).
  useKeyScope(`sheet-${scopeId}`, { escape: onClose }, open, {
    priority: PRIORITIES.sheet,
    modal: true,
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Land initial focus on the scrollable body, not the Close button:
      // readers hear content first, Enter cannot instantly close the sheet
      // just opened, and a focused scroll container keyboard-scrolls even in
      // Safari (which never auto-focuses scrollable divs).
      bodyRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // While the modal is open everything outside its subtree is inert — the
  // registry lets ToastHost portal the toast stack inside (see Toast.tsx).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    return registerModalRoot(dialog);
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={`${styles.sheet} ${widthClass}`}
      onCancel={(event) => {
        // Swallow the native Esc-close so the exit transition runs from the
        // open-prop effect and parent state never desyncs from the DOM.
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // Browsers can force-close a dialog without a cancelable cancel
        // event; resync parent state if that happens.
        if (open) onClose();
      }}
      onPointerDown={(event) => {
        pointerDownOnBackdropRef.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        // Clicks on ::backdrop dispatch to the <dialog> itself; the inner
        // wrapper fully covers the panel, so target === dialog ⇔ backdrop.
        // Closing also requires the pointerdown to have hit the backdrop.
        if (event.target === dialogRef.current && pointerDownOnBackdropRef.current) onClose();
      }}
    >
      <div className="flex h-full max-h-[85dvh] flex-col md:max-h-none">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id={titleId} className="min-w-0 text-sm font-semibold text-ink">
            {title}
          </h2>
          <IconButton icon="close" aria-label="Close" onClick={onClose} />
        </header>
        <div
          ref={bodyRef}
          tabIndex={-1}
          role="region"
          aria-labelledby={titleId}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none"
        >
          {children}
        </div>
        {footer ? (
          <footer className="shrink-0 border-t border-line px-5 py-4">{footer}</footer>
        ) : null}
      </div>
    </dialog>
  );
}
