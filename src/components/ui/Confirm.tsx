"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { PRESSED_SLOT } from "./letterpress";
import { blastRadiusSentence, type BlastRadius } from "@/components/ui/blast-radius";

/**
 * The destructive-action gate, generalised from the re-derive confirmation in
 * EditAccountSheet (§S3): a live region, the consequence in plain English, and
 * a checkbox that resets. What it adds is the number — an irreversible action
 * must state its blast radius in the owner's units, money and counts, measured
 * server-side against the same ledger the screen behind it is showing. Never a
 * row id, never "are you sure?".
 *
 * Dismissal, focus trap and focus return come from Sheet's native <dialog>:
 * Esc pops the sheet key-scope, the backdrop closes, and close() hands focus
 * back to the trigger. Initial focus lands on the body (never the confirm
 * button), so Enter can never destroy data the instant the dialog opens.
 */

export type ConfirmTone = "warning" | "negative";

/* The blast-radius panel is a well pressed into the sheet — you are reading a
   consequence, not being offered another surface to act on. */
const TONE: Record<ConfirmTone, { panel: string; confirm: "primary" | "destructive" }> = {
  warning: { panel: `border-warning/40 bg-warning/10 ${PRESSED_SLOT}`, confirm: "primary" },
  negative: { panel: `border-negative/40 bg-negative-soft ${PRESSED_SLOT}`, confirm: "destructive" },
};

export interface ConfirmProps {
  open: boolean;
  /** dismissal without acting — Esc, the backdrop and Cancel all route here */
  onClose: () => void;
  onConfirm: () => void;
  /** names the dialog; Sheet uses it as the accessible name */
  title: string;
  radius: BlastRadius;
  /** the button that performs the action — always names it, never "Confirm" */
  confirmLabel: string;
  /** when set, the action is gated behind this explicit acknowledgement */
  acknowledgement?: string;
  tone?: ConfirmTone;
  /** extra detail under the blast radius; additive, nothing is ever replaced */
  children?: ReactNode;
  pending?: boolean;
}

export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  radius,
  confirmLabel,
  acknowledgement,
  tone = "warning",
  children,
  pending = false,
}: ConfirmProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const ackId = useId();
  const describedBy = useId();
  const lines = radius.lines ?? [];

  // A new opening — or a new target behind the same trigger — needs a FRESH
  // acknowledgement. A checked box must never carry across dialogs (the rule
  // EditAccountSheet enforces when the type/subtype target changes).
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setBlocked(false);
  }, [open, acknowledgement, radius.headline]);

  function attempt(): void {
    if (acknowledgement !== undefined && !acknowledged) {
      setBlocked(true);
      // take the keyboard to the thing that must happen next, rather than
      // leaving a disabled-looking button and no explanation
      document.getElementById(ackId)?.focus();
      return;
    }
    onConfirm();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={TONE[tone].confirm}
            onClick={attempt}
            pending={pending}
            aria-describedby={describedBy}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink">{radius.headline}</p>

        {lines.length > 0 ? (
          <dl className={`rounded-(--radius-card) border px-3 ${TONE[tone].panel}`}>
            {lines.map((line) => (
              <div
                key={line.label}
                className="flex items-baseline justify-between gap-3 border-b border-line/60 py-2 last:border-0"
              >
                <dt className="min-w-0 text-xs text-ink-muted">{line.label}</dt>
                <dd
                  className={`figures min-w-0 text-right text-sm font-medium ${
                    line.irreversible ? "text-negative" : "text-ink"
                  }`}
                >
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {children}

        {radius.reassurance ? (
          <p className="text-xs text-ink-muted">{radius.reassurance}</p>
        ) : null}

        {acknowledgement !== undefined ? (
          <Checkbox
            id={ackId}
            label={acknowledgement}
            checked={acknowledged}
            onChange={(e) => {
              setAcknowledged(e.target.checked);
              if (e.target.checked) setBlocked(false);
            }}
          />
        ) : null}

        {/* persistent polite live region — a conditionally-mounted one would
            never announce the message it was mounted to carry */}
        <div aria-live="polite">
          {blocked ? (
            <p className="text-xs text-negative">
              {/* the same wording drift as BackupsManager's restore gate: the
                  button is never disabled — `attempt` intercepts the click */}
              Tick the acknowledgement above, then press &ldquo;{confirmLabel}&rdquo; again.
            </p>
          ) : null}
        </div>

        {/* the whole consequence as one sentence: the confirm button's
            description, so it is heard before the button can be activated */}
        <p id={describedBy} className="sr-only">
          {blastRadiusSentence(radius)}
        </p>
      </div>
    </Sheet>
  );
}

export interface ConfirmActionButtonProps
  extends Omit<ConfirmProps, "open" | "onClose" | "onConfirm" | "pending"> {
  /** the server action the trigger submits once the owner has confirmed */
  action: (formData: FormData) => void | Promise<void>;
  /** hidden inputs the action reads, exactly as the bare <form> passed them */
  fields: Readonly<Record<string, string>>;
  /** the trigger's visible text */
  triggerLabel: ReactNode;
  /** kept byte-identical to the pre-confirm markup so no pixel moves */
  triggerClassName?: string;
  formClassName?: string;
  triggerAriaLabel?: string;
}

/**
 * The confirm in front of a plain server-action <form> — the shape every
 * destructive action on the server-rendered pages already had. The form and
 * its hidden inputs are unchanged; only the submit button becomes a trigger
 * that opens the gate and submits on confirmation, so the capability is
 * identical and the markup stays pixel-for-pixel where it was.
 */
export function ConfirmActionButton({
  action,
  fields,
  triggerLabel,
  triggerClassName,
  formClassName,
  triggerAriaLabel,
  ...confirm
}: ConfirmActionButtonProps) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={formRef} action={action} className={formClassName}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <ConfirmTrigger
          label={triggerLabel}
          className={triggerClassName}
          ariaLabel={triggerAriaLabel}
          onOpen={() => setOpen(true)}
        />
      </form>
      <Confirm
        {...confirm}
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          formRef.current?.requestSubmit();
        }}
      />
    </>
  );
}

/**
 * The trigger reads its own form's status so an in-flight action is announced
 * (aria-busy) rather than silent. It is deliberately NOT disabled: closing the
 * dialog hands focus back to this button, and the browser cannot focus a
 * disabled one — the confirmation itself is what stands between a stray
 * double-click and a second write.
 */
function ConfirmTrigger({
  label,
  className,
  ariaLabel,
  onOpen,
}: {
  label: ReactNode;
  className: string | undefined;
  ariaLabel: string | undefined;
  onOpen: () => void;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      className={className}
    >
      {label}
    </button>
  );
}
