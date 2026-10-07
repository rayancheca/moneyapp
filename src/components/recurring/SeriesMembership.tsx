"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  attachToSeriesAction,
  detachFromSeriesAction,
  mergeIntoSeriesAction,
  searchAttachCandidatesAction,
} from "@/app/recurring/actions";
import { Money } from "@/components/ui/Money";
import { Menu } from "@/components/ui/Menu";
import { Popover, usePopover } from "@/components/ui/Popover";
import { toast } from "@/components/ui/Toast";
import { Icon } from "@/components/shell/Icon";
import { useAction } from "@/hooks/useAction";
import { offerUndoToast } from "@/components/transactions/undo-toast";
import { transactionSubjects } from "@/lib/row-subject";
import type {
  AttachCandidate,
  SeriesLinkedTxn,
  SeriesMergeCandidate,
} from "@/services/recurring-detail";
import { KIND_LABEL } from "./labels";

/** Full linked history with a per-row "not part of this series" detach (§4.2). */
export function LinkedTransactions({
  txns,
  onChanged,
}: {
  txns: readonly SeriesLinkedTxn[];
  onChanged: () => void;
}) {
  const { run } = useAction();
  // a series repeats its description by construction — the menu must say which row it detaches
  const subjects = useMemo(() => transactionSubjects(txns), [txns]);

  function detach(id: string): void {
    void run(() => detachFromSeriesAction({ transactionId: id }), {
      onSuccess: ({ undo }) => {
        onChanged();
        // the detach's own patch, not a re-attach: re-attaching would stamp a
        // detection-owned link as his AND file an unfiled row under the series'
        // category (§6A 47) — neither of which the detach undid
        offerUndoToast("Removed from series", undo, onChanged);
      },
    });
  }

  if (txns.length === 0) {
    return <p className="text-sm text-ink-muted">No linked transactions yet.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {txns.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
          {/*
            ⛔ `truncate` belongs on this BLOCK, not on the inline span below it.
            On an inline element `overflow`/`text-overflow` do nothing and only
            the `white-space: nowrap` half applies — so the misplaced utility was
            not merely inert, it was the CAUSE: the row could no longer wrap and
            pushed /recurring/[id] to 378px inside a 320px viewport. Invisible
            until a linked row carried a long descriptor ("ACH PYMT WESTVIEW
            APARTMENTS RENT" plus an account name); the one seeded before it was
            short enough to fit.
          */}
          <div className="min-w-0 truncate">
            <span className="figures mr-2 text-xs text-ink-faint">{t.postedOn}</span>
            <span>{t.description}</span>
            <span className="ml-2 text-[11px] text-ink-faint">{t.accountName}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Money cents={t.amountCents} flow />
            <Menu
              label={`Actions for ${subjects.get(t.id) ?? t.description}`}
              items={[
                { label: "Not part of this series", icon: "close", onSelect: () => detach(t.id), destructive: true },
              ]}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const SEARCH_DEBOUNCE_MS = 200;

/** "Find transactions" attach flow (§4.2): search unlinked rows, checkbox-attach. */
export function AttachPanel({
  seriesId,
  onChanged,
}: {
  seriesId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AttachCandidate[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const { run, pending } = useAction();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRequestedRef = useRef(false);

  // returning focus to the trigger on close keeps keyboard users oriented (never
  // dropped to <body>); guarded so the initial closed mount does not grab focus
  useEffect(() => {
    if (!open && closeRequestedRef.current) {
      closeRequestedRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function closePanel(): void {
    closeRequestedRef.current = true;
    setOpen(false);
    setSelected(new Set());
    setQuery("");
  }

  // one debounced round-trip per settled query while the panel is open
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const handle = setTimeout(() => {
      void searchAttachCandidatesAction({ seriesId, query }).then((r) => {
        if (!live) return;
        setCandidates(r.ok ? r.data : []);
        setLoading(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [open, query, seriesId]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function attach(): void {
    const ids = [...selected];
    if (ids.length === 0) return;
    void run(() => attachToSeriesAction({ seriesId, transactionIds: ids }), {
      onSuccess: ({ attached, undo }) => {
        onChanged();
        setSelected(new Set());
        setQuery("");
        // the attach's own lossless patch, in ONE transaction: each row's prior
        // link AND the category attaching filed (§6A 47). Detaching row by row
        // left the category behind and stamped a detach marker on every row.
        offerUndoToast(`${attached} attached`, undo, onChanged);
      },
    });
  }

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
      >
        <Icon name="search" className="size-3.5" /> Find transactions to attach
      </button>
    );
  }

  return (
    <div className="rounded-(--radius-card) border border-line bg-surface-sunken/40 p-3">
      <div className="flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-1.5">
        <Icon name="search" className="size-3.5 shrink-0 text-ink-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by description…"
          aria-label="Search transactions to attach"
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close search"
          className="shrink-0 text-ink-faint hover:text-ink"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </div>

      <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
        {loading && candidates.length === 0 ? (
          <li className="px-1 py-3 text-center text-xs text-ink-faint">Searching…</li>
        ) : candidates.length === 0 ? (
          <li className="px-1 py-3 text-center text-xs text-ink-faint">
            {query.trim() === "" ? "No similar unlinked transactions." : "No matches."}
          </li>
        ) : (
          candidates.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors duration-(--duration-fast) hover:bg-surface-sunken">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="size-4 accent-[var(--accent)]"
                />
                <span className="figures shrink-0 text-xs text-ink-faint">{c.postedOn}</span>
                <span className="min-w-0 flex-1 truncate">{c.description}</span>
                <Money cents={c.amountCents} flow className="text-xs" />
              </label>
            </li>
          ))
        )}
      </ul>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-ink-faint">{selected.size} selected</span>
        <button
          type="button"
          disabled={selected.size === 0}
          aria-busy={pending}
          onClick={attach}
          className={`rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 disabled:opacity-40 ${
            pending ? "opacity-60" : ""
          }`}
        >
          Attach {selected.size > 0 ? selected.size : ""}
        </button>
      </div>
    </div>
  );
}

/** Merge another live series INTO this one (§4.2): its charges relink, it ends. */
export function MergeControl({
  seriesId,
  candidates,
  onChanged,
}: {
  seriesId: string;
  candidates: readonly SeriesMergeCandidate[];
  onChanged: () => void;
}) {
  const { anchorRef, open, close, triggerProps } = usePopover<HTMLButtonElement>();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<SeriesMergeCandidate | null>(null);
  const { run, pending: merging } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else {
      setQuery("");
      setPending(null);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? candidates : candidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [candidates, query]);

  function merge(source: SeriesMergeCandidate): void {
    void run(() => mergeIntoSeriesAction({ sourceId: source.id, targetId: seriesId }), {
      onSuccess: ({ relinked }) => {
        close();
        onChanged();
        toast({ title: `${source.name} merged in · ${relinked} moved` });
      },
    });
  }

  if (candidates.length === 0) return null;

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
      >
        <Icon name="arrow-left-right" className="size-3.5" /> Merge another series in
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-end"
        offset={6}
        className="w-72 rounded-(--radius-overlay) border border-line bg-surface-overlay p-2 shadow-(--shadow-overlay)"
      >
        {pending ? (
          <div className="p-1">
            <p className="text-sm text-ink">
              Merge <span className="font-medium">{pending.name}</span> into this series? Its charges move
              here and it ends.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => merge(pending)}
                aria-busy={merging}
                className={`rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 ${
                  merging ? "opacity-60" : ""
                }`}
              >
                Merge in
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-line px-2 py-1">
              <Icon name="search" className="size-3.5 shrink-0 text-ink-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search series…"
                aria-label="Search series to merge"
                className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {results.length === 0 ? (
                <li className="px-2 py-3 text-center text-xs text-ink-faint">No other series.</li>
              ) : (
                results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-label={`Choose ${c.name} to merge in`}
                      onClick={() => setPending(c)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="shrink-0 text-[11px] text-ink-faint">{KIND_LABEL[c.kind]}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </Popover>
    </>
  );
}
