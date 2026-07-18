"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/Toast";
import { linkTransferAction, unlinkTransferAction } from "@/app/transactions/actions";
import {
  attachToSeriesAction,
  createSeriesFromTxnAction,
  detachFromSeriesAction,
  undoCreateSeriesAction,
} from "@/app/recurring/actions";
import {
  loadSeriesLinkPanel,
  loadTransferLinkPanel,
  type SeriesLinkPanelData,
  type TransferLinkPanelData,
} from "@/app/transactions/sheet-actions";
import { offerUndoToast } from "./undo-toast";

/**
 * S5 "linkable" panels for the transaction sheet: pair this row with its
 * counterpart as a transfer (the human override for what detectTransfers
 * missed), and attach/detach it to a recurring series — both right where the
 * transaction is shown. Candidates load lazily on disclosure, never on open.
 * Every mutation returns a lossless UndoPatch through the shared undo toast.
 */

const NETWORK_ERROR = "Network error — nothing was changed";

export function TransferLinkPanel({
  txnId,
  isTransfer,
  onChanged,
}: {
  txnId: string;
  isTransfer: boolean;
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<TransferLinkPanelData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const regionId = useId();

  async function disclose(): Promise<void> {
    setOpen(true);
    try {
      const r = await loadTransferLinkPanel(txnId);
      if (r.ok) setPanel(r.data);
      else {
        setOpen(false); // the button stays as the retry affordance
        toast({ title: r.error, tone: "negative" });
      }
    } catch {
      setOpen(false);
      toast({ title: NETWORK_ERROR, tone: "negative" });
    }
  }

  function link(counterpartId: string): void {
    if (busy) return;
    setBusy(true);
    void linkTransferAction({ aId: txnId, bId: counterpartId })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        setPanel(null);
        setOpen(false);
        offerUndoToast("Linked as transfer", r.data.undo, onChanged);
        onChanged();
      })
      .catch(() => toast({ title: NETWORK_ERROR, tone: "negative" }))
      .finally(() => setBusy(false));
  }

  function unlink(groupId: string): void {
    if (busy) return;
    setBusy(true);
    void unlinkTransferAction({ groupId })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        setPanel(null);
        setOpen(false);
        offerUndoToast("Transfer unlinked", r.data.undo, onChanged);
        onChanged();
      })
      .catch(() => toast({ title: NETWORK_ERROR, tone: "negative" }))
      .finally(() => setBusy(false));
  }

  if (isTransfer) {
    return (
      <section className="space-y-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Transfer</span>
        {panel?.counterparts ? (
          <div aria-live="polite">
            <ul className="space-y-1">
              {panel.counterparts.legs.map((leg) => (
                <li key={leg.id} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{leg.description}</span>
                  <span className="shrink-0 text-xs text-ink-muted">{leg.accountName}</span>
                  <Money cents={leg.amountCents} flow />
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              pending={busy}
              className="mt-1"
              onClick={() => unlink(panel.counterparts!.groupId)}
            >
              Unlink transfer
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => void disclose()}>
            Show counterpart
          </Button>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-1.5">
      <Button
        variant="ghost"
        size="sm"
        icon="arrow-left-right"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => (open ? setOpen(false) : void disclose())}
      >
        Link as transfer…
      </Button>
      {open ? (
        <div id={regionId} role="status" className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            Link with the other leg
          </span>
          {panel === null ? (
            <p className="text-xs text-ink-faint">Looking for counterparts…</p>
          ) : panel.candidates.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No opposite-signed rows in other accounts within two weeks.
            </p>
          ) : (
            <ul className="space-y-1">
              {panel.candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => link(c.id)}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                  >
                    <span className="figures shrink-0 text-xs text-ink-muted">{c.postedOn}</span>
                    <span className="min-w-0 flex-1 truncate">{c.description}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{c.accountName}</span>
                    <Money cents={c.amountCents} flow />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function SeriesLinkPanel({
  txnId,
  isRecurring,
  onChanged,
}: {
  txnId: string;
  /** the row already carries a series link — disclose shows it instead of candidates */
  isRecurring: boolean;
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<SeriesLinkPanelData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const regionId = useId();

  async function disclose(): Promise<void> {
    setOpen(true);
    try {
      const r = await loadSeriesLinkPanel(txnId);
      if (r.ok) setPanel(r.data);
      else {
        setOpen(false);
        toast({ title: r.error, tone: "negative" });
      }
    } catch {
      setOpen(false);
      toast({ title: NETWORK_ERROR, tone: "negative" });
    }
  }

  function attach(seriesId: string, name: string): void {
    if (busy) return;
    setBusy(true);
    void attachToSeriesAction({ seriesId, transactionIds: [txnId] })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        if (r.data.attached === 0) {
          toast({ title: "Couldn’t attach — the transaction is no longer active", tone: "negative" });
          return;
        }
        setPanel({ linked: { id: seriesId, name }, candidates: [] });
        offerUndoToast(`Attached to ${name}`, r.data.undo, () => {
          setPanel(null);
          setOpen(false);
          onChanged();
        });
        onChanged();
      })
      .catch(() => toast({ title: NETWORK_ERROR, tone: "negative" }))
      .finally(() => setBusy(false));
  }

  /** The "Make recurring" quick action: promote THIS row into a confirmed series
   *  (or join the identity's existing live series). Undo is mode-aware: a created
   *  series is deleted outright; an attach simply detaches. */
  function makeRecurring(): void {
    if (busy) return;
    setBusy(true);
    void createSeriesFromTxnAction({ transactionId: txnId })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        const { mode, seriesId, name, undo } = r.data;
        setPanel({ linked: { id: seriesId, name }, candidates: [] });
        setOpen(false);
        toast({
          title: mode === "created" ? `Marked "${name}" as recurring` : `Attached to ${name}`,
          action: {
            label: "Undo",
            onAction: () =>
              void (mode === "created"
                ? undoCreateSeriesAction({ seriesId, undo })
                : detachFromSeriesAction({ transactionId: txnId })
              ).then((res) => {
                if (!res.ok) {
                  toast({ title: res.error, tone: "negative" });
                  return;
                }
                setPanel(null);
                setOpen(false);
                onChanged();
              }),
          },
        });
        onChanged();
      })
      .catch(() => toast({ title: NETWORK_ERROR, tone: "negative" }))
      .finally(() => setBusy(false));
  }

  function detach(name: string): void {
    if (busy) return;
    setBusy(true);
    void detachFromSeriesAction({ transactionId: txnId })
      .then((r) => {
        if (!r.ok) {
          toast({ title: r.error, tone: "negative" });
          return;
        }
        setPanel(null);
        setOpen(false);
        offerUndoToast(`Detached from ${name}`, r.data.undo, () => {
          setPanel(null);
          setOpen(false);
          onChanged();
        });
        onChanged();
      })
      .catch(() => toast({ title: NETWORK_ERROR, tone: "negative" }))
      .finally(() => setBusy(false));
  }

  if (panel?.linked) {
    return (
      <section className="space-y-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Recurring</span>
        <div className="flex items-center justify-between gap-2 text-sm" aria-live="polite">
          <span className="min-w-0 flex-1 truncate">{panel.linked.name}</span>
          <Button variant="ghost" size="sm" pending={busy} onClick={() => detach(panel.linked!.name)}>
            Detach
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {!isRecurring ? (
          <Button variant="ghost" size="sm" icon="repeat" pending={busy} onClick={makeRecurring}>
            Make recurring
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon={isRecurring ? "repeat" : undefined}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => (open ? setOpen(false) : void disclose())}
        >
          {isRecurring ? "Show recurring series…" : "Attach to recurring series…"}
        </Button>
      </div>
      {open ? (
        <div id={regionId} role="status" className="space-y-1.5">
          {panel === null ? (
            <p className="text-xs text-ink-faint">Loading series…</p>
          ) : panel.candidates.length === 0 ? (
            <p className="text-xs text-ink-faint">No live recurring series yet.</p>
          ) : (
            <>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                Attach to series
              </span>
              <ul className="space-y-1">
                {panel.candidates.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => attach(s.id, s.name)}
                      className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="shrink-0 text-xs text-ink-muted">{s.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
