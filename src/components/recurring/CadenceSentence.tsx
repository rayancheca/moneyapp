"use client";

import { useEffect, useRef, useState } from "react";
import { setSeriesOverridesAction } from "@/app/recurring/actions";
import { CADENCES, type Cadence, type SeriesKind } from "@/db/schema/recurring";
import { Popover, usePopover } from "@/components/ui/Popover";
import { toast } from "@/components/ui/Toast";
import { parseAmountToCents } from "@/lib/money";
import { CADENCE_LABEL, schedulePhrase, seriesVerb } from "./labels";

interface CadenceSentenceProps {
  seriesId: string;
  kind: SeriesKind;
  /** effective values (user override first) */
  cadence: Cadence;
  nextExpectedOn: string | null;
  amountCents: number | null;
  /** raw override columns — non-null means "user set this" (shows a reset) */
  userCadence: Cadence | null;
  userNextExpectedOn: string | null;
  userAmountCents: number | null;
  detectedCadence: Cadence;
  accountName: string | null;
  onChanged: () => void;
}

/** A dotted-underline token that opens an editor; carries an override marker. */
function tokenClass(overridden: boolean): string {
  return `rounded px-0.5 font-medium underline decoration-dotted decoration-ink-faint underline-offset-4 outline-offset-2 transition-colors duration-(--duration-fast) hover:decoration-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
    overridden ? "text-accent decoration-accent" : "text-ink"
  }`;
}

/**
 * The editable cadence sentence (ux-overhaul-plan §4.2 [CP]): the series' schedule
 * stated in words, each underlined token an editor writing a user override
 * (§4.4). Detection keeps refining its own columns underneath; the sentence and
 * the forecast read the override first. Every editor offers "use detected" to
 * hand a field back to detection.
 */
export function CadenceSentence(props: CadenceSentenceProps) {
  const { seriesId, kind, cadence, nextExpectedOn, amountCents, accountName, onChanged } = props;

  async function save(
    patch: Omit<Parameters<typeof setSeriesOverridesAction>[0], "seriesId">,
    label: string,
  ): Promise<void> {
    const r = await setSeriesOverridesAction({ seriesId, ...patch });
    if (!r.ok) {
      toast({ title: r.error, tone: "negative" });
      return;
    }
    onChanged();
    toast({ title: label });
  }

  return (
    <p className="text-[15px] leading-relaxed text-ink-muted">
      {seriesVerb(kind)}{" "}
      <CadenceToken
        cadence={cadence}
        overridden={props.userCadence !== null}
        detected={props.detectedCadence}
        onPick={(c) => save({ userCadence: c }, c === null ? "Cadence reset to detected" : `Cadence set to ${CADENCE_LABEL[c].toLowerCase()}`)}
      />
      {nextExpectedOn ? (
        <>
          {` ${schedulePhrase(cadence, nextExpectedOn).connective} `}
          <DateToken
            value={nextExpectedOn}
            label={schedulePhrase(cadence, nextExpectedOn).token}
            overridden={props.userNextExpectedOn !== null}
            onSave={(d) => save({ userNextExpectedOn: d }, d === null ? "Next date reset to detected" : `Next expected ${d}`)}
          />
        </>
      ) : null}
      {amountCents !== null ? (
        <>
          {", about "}
          <AmountToken
            cents={amountCents}
            overridden={props.userAmountCents !== null}
            onSave={(c) => save({ userAmountCents: c }, c === null ? "Amount reset to detected" : "Amount updated")}
          />
        </>
      ) : null}
      {accountName ? <> from <span className="font-medium text-ink">{accountName}</span></> : null}.
    </p>
  );
}

function CadenceToken({
  cadence,
  overridden,
  detected,
  onPick,
}: {
  cadence: Cadence;
  overridden: boolean;
  detected: Cadence;
  onPick: (cadence: Cadence | null) => void;
}) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const listRef = useRef<HTMLDivElement>(null);

  // focus the first menu item on open (APG menu pattern)
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"],[role="menuitem"]')?.focus();
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"],[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    items[(at + delta + items.length) % items.length]?.focus();
  }

  return (
    <>
      <button type="button" {...triggerProps} aria-haspopup="menu" aria-expanded={open} className={tokenClass(overridden)}>
        {CADENCE_LABEL[cadence].toLowerCase()}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        offset={6}
        className="w-44 rounded-(--radius-overlay) border border-line bg-surface-overlay p-1 shadow-(--shadow-overlay)"
      >
        <div ref={listRef} role="menu" aria-label="Cadence" onKeyDown={onMenuKeyDown} className="text-sm">
          {CADENCES.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={c === cadence}
              onClick={() => {
                onPick(c);
                close();
              }}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-surface-sunken focus:bg-surface-sunken ${
                c === cadence ? "text-ink" : "text-ink-muted"
              }`}
            >
              {CADENCE_LABEL[c]}
              {c === cadence ? <span aria-hidden className="text-accent">•</span> : null}
            </button>
          ))}
          {overridden ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(null);
                close();
              }}
              className="mt-1 w-full border-t border-line rounded-md px-2.5 pt-2 pb-1.5 text-left text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken focus:bg-surface-sunken hover:text-ink"
            >
              Use detected ({CADENCE_LABEL[detected].toLowerCase()})
            </button>
          ) : null}
        </div>
      </Popover>
    </>
  );
}

function DateToken({
  value,
  label,
  overridden,
  onSave,
}: {
  value: string;
  /** the display token, e.g. "15th" or "Fridays" — computed by the sentence */
  label: string;
  overridden: boolean;
  onSave: (date: string | null) => void;
}) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const [draft, setDraft] = useState(value);
  // re-sync the draft to the current value each time the editor opens, so a
  // reopen (or a reset that changed `value`) never prefills a stale date
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);
  return (
    <>
      <button type="button" {...triggerProps} aria-haspopup="dialog" aria-expanded={open} className={tokenClass(overridden)}>
        {label}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        offset={6}
        className="w-60 rounded-(--radius-overlay) border border-line bg-surface-overlay p-3 shadow-(--shadow-overlay)"
      >
        <div role="dialog" aria-label="Edit next expected date">
        <label htmlFor="rec-next-date" className="block text-xs font-medium text-ink-muted">Next expected date</label>
        <input
          id="rec-next-date"
          type="date"
          aria-label="Next expected date"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-line bg-surface-raised px-2 py-1.5 text-sm outline-none focus-visible:border-accent"
        />
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {overridden ? (
            <button
              type="button"
              onClick={() => {
                onSave(null);
                close();
              }}
              className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
            >
              Use detected
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => {
              if (draft) onSave(draft);
              close();
            }}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
          >
            Save
          </button>
        </div>
        </div>
      </Popover>
    </>
  );
}

function AmountToken({
  cents,
  overridden,
  onSave,
}: {
  cents: number;
  overridden: boolean;
  onSave: (cents: number | null) => void;
}) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const [draft, setDraft] = useState((Math.abs(cents) / 100).toFixed(2));
  const sign = cents < 0 ? -1 : 1;
  // re-sync the draft each time the editor opens (reopen/reset must not be stale)
  useEffect(() => {
    if (open) setDraft((Math.abs(cents) / 100).toFixed(2));
  }, [open, cents]);

  function commit(): void {
    try {
      const magnitude = Math.abs(parseAmountToCents(draft));
      onSave(sign * magnitude);
    } catch {
      toast({ title: "Enter a valid amount", tone: "negative" });
    }
    close();
  }

  return (
    <>
      <button type="button" {...triggerProps} aria-haspopup="dialog" aria-expanded={open} className={`figures ${tokenClass(overridden)}`}>
        {formatMoney(cents)}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        offset={6}
        className="w-52 rounded-(--radius-overlay) border border-line bg-surface-overlay p-3 shadow-(--shadow-overlay)"
      >
        <div role="dialog" aria-label="Edit expected amount">
        <label htmlFor="rec-amount" className="block text-xs font-medium text-ink-muted">Expected amount</label>
        <div className="mt-1.5 flex items-center gap-1 rounded-md border border-line bg-surface-raised px-2 py-1.5">
          <span aria-hidden className="text-sm text-ink-faint">$</span>
          <input
            id="rec-amount"
            inputMode="decimal"
            aria-label="Expected amount in dollars"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className="figures w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {overridden ? (
            <button
              type="button"
              onClick={() => {
                onSave(null);
                close();
              }}
              className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
            >
              Use detected
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={commit}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
          >
            Save
          </button>
        </div>
        </div>
      </Popover>
    </>
  );
}

/** Signed, no leading + (the sentence context already conveys direction). */
function formatMoney(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}
