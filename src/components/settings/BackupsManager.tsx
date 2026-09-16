"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";
import { useAction } from "@/hooks/useAction";
import {
  backUpNowAction,
  downloadSnapshotAction,
  restoreSnapshotAction,
} from "@/app/settings/actions";
import { RESTORE_PHRASE, matchesRestorePhrase } from "./restore-phrase";
import type { BackupRow, BackupStateLine } from "./backup-rows";

/**
 * The backup archive, made usable (§9). It used to be a list of eight
 * filenames with nothing to do about them, and the only documented way to go
 * back was `cp` over a database the server had open.
 *
 * Three things happen here. Every row states the LEDGER inside it — counts,
 * reach, net worth, hand-decided rows — so a choice is between states rather
 * than between names. Every row can be downloaded. And every row can be
 * restored, behind a typed word, after the state being replaced is snapshotted
 * so the restore is itself reversible.
 *
 * Restore is the most dangerous action in the app; what makes it safe lives in
 * db/backup.ts, where the ordering is documented step by step.
 */

interface BackupsManagerProps {
  rows: readonly BackupRow[];
  /** the ledger as it stands right now, in the same shape as a row's */
  currentStateLines: readonly BackupStateLine[];
  /** what rotation governs and what it does not */
  retentionNote: string;
  /** rows past the rendered window, so the count is never quietly wrong */
  hiddenCount: number;
  /** where the archive lives, for the copy-it-yourself path */
  archivePath: string;
}

export function BackupsManager({
  rows,
  currentStateLines,
  retentionNote,
  hiddenCount,
  archivePath,
}: BackupsManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { run, pending: acting } = useAction();
  const [target, setTarget] = useState<BackupRow | null>(null);
  const busy = isPending || acting;

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function backUpNow(): void {
    void run(() => backUpNowAction(), {
      onSuccess: ({ name, reason }) => {
        if (name === null) {
          toast({
            title:
              reason === "disabled"
                ? "Backups are turned off for this database"
                : "This database has no file to snapshot",
            description: "Nothing was written — the archive is unchanged.",
          });
          return;
        }
        refresh();
        toast({ title: "Backed up", description: name });
      },
      fallback: "Couldn’t write a backup — try again",
    });
  }

  function download(row: BackupRow): void {
    void run(() => downloadSnapshotAction(row.name), {
      onSuccess: ({ filename, base64 }) => {
        saveToDisk(filename, base64);
      },
      fallback: `Couldn’t read ${row.name}`,
    });
  }

  function restore(row: BackupRow, confirmation: string): void {
    void run(() => restoreSnapshotAction({ name: row.name, confirmation }), {
      onSuccess: ({ restoredFrom, preRestoreName, filesUnrecorded }) => {
        setTarget(null);
        refresh();
        const saved =
          preRestoreName === null
            ? "No restore point was saved for this database."
            : `The state you replaced is saved as ${preRestoreName}.`;
        // a snapshot older than the import records: what could not be read again is not safe to un-import yet
        const unrecorded =
          filesUnrecorded === 0
            ? ""
            : ` ${filesUnrecorded} imported ${filesUnrecorded === 1 ? "file has" : "files have"} no record of what ${filesUnrecorded === 1 ? "it prints" : "they print"} — don’t un-import until the record backfills have run.`;
        toast({
          title: `Restored ${restoredFrom}`,
          description: `${saved}${unrecorded}`,
          durationMs: 12_000,
          ...(filesUnrecorded === 0 ? {} : { tone: "negative" as const }),
        });
      },
      onError: (message) => toast({ title: message, tone: "negative" }),
    });
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Backups</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Crash-safe copies through SQLite itself, never raw file copies. Each one says what the
            ledger looked like inside it, so you pick a state and not a filename.
          </p>
        </div>
        <Button variant="secondary" size="sm" icon="plus" disabled={busy} onClick={backUpNow}>
          Back up now
        </Button>
      </div>

      {currentStateLines.length > 0 && (
        <div className="mb-3 rounded-(--radius-card) border border-accent/40 bg-surface-sunken px-3 py-2">
          <p className="text-xs font-medium">Right now</p>
          <StateLines lines={currentStateLines} />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No snapshots yet — the first lands on the next app start. &ldquo;Back up now&rdquo; writes
          one immediately.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.name} className="rounded-(--radius-card) border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm">
                    {row.kindLabel}
                    {row.description ? (
                      <span className="text-ink-muted"> · {row.description}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {row.takenAtLabel} · {row.sizeLabel}
                    {row.governedByRetention ? null : " · never pruned"}
                  </p>
                  <p className="figures mt-0.5 truncate text-[11px] text-ink-faint">{row.name}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Download ${row.name}`}
                    onClick={() => download(row)}
                  >
                    Download
                  </Button>
                  {/* deliberately NOT disabled while busy (the ConfirmTrigger
                      rule): closing the dialog hands focus back to this button,
                      and the browser cannot focus a disabled one. The typed
                      confirmation is what stands between a stray click and a
                      second restore. */}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={row.unreadable !== null}
                    aria-busy={busy || undefined}
                    aria-label={`Restore ${row.name}`}
                    onClick={() => setTarget(row)}
                  >
                    Restore
                  </Button>
                </div>
              </div>
              {row.unreadable === null ? (
                <StateLines lines={row.stateLines} />
              ) : (
                <p className="mt-2 text-xs text-warning">
                  Could not be read, so it cannot be restored from here: {row.unreadable}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-ink-faint">
        {retentionNote}
        {hiddenCount > 0 ? ` ${hiddenCount} older not shown.` : ""} They live in{" "}
        <span className="figures">{archivePath}</span>.
      </p>

      <RestoreDialog
        row={target}
        currentStateLines={currentStateLines}
        pending={acting}
        onClose={() => setTarget(null)}
        onConfirm={(confirmation) => {
          if (target) restore(target, confirmation);
        }}
      />
    </>
  );
}

/** The measured figures, as a definition list so a reader hears label + value. */
function StateLines({ lines }: { lines: readonly BackupStateLine[] }) {
  if (lines.length === 0) return null;
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-2">
          <dt className="min-w-0 truncate text-ink-muted">{line.label}</dt>
          <dd className="figures shrink-0 font-medium">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface RestoreDialogProps {
  row: BackupRow | null;
  currentStateLines: readonly BackupStateLine[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (confirmation: string) => void;
}

/**
 * Confirm's checkbox is not enough here.
 *
 * Every other destructive action in the app is scoped to a rule, an import or
 * a category, and a checkbox is a proportionate speed bump. This one replaces
 * the whole ledger, and a checkbox sits under the same pointer that opened the
 * dialog. So the gate is a word, typed — and the server re-checks it, because a
 * gate that only exists in the browser is decoration.
 */
function RestoreDialog({
  row,
  currentStateLines,
  pending,
  onClose,
  onConfirm,
}: RestoreDialogProps) {
  const [typed, setTyped] = useState("");
  const [blocked, setBlocked] = useState(false);
  const inputId = useId();
  const open = row !== null;

  // a fresh dialog — or a different target behind it — needs a fresh word
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setBlocked(false);
  }, [open, row?.name]);

  function attempt(): void {
    if (!matchesRestorePhrase(typed)) {
      setBlocked(true);
      document.getElementById(inputId)?.focus();
      return;
    }
    onConfirm(typed);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Restore this snapshot"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" pending={pending} onClick={attempt}>
            Restore
          </Button>
        </div>
      }
    >
      {row === null ? null : (
        <div className="space-y-4">
          <p className="text-sm text-ink">
            Every account, transaction, category and budget is replaced with the ones inside{" "}
            <span className="figures">{row.name}</span>. Anything you have done since is only
            recoverable from the restore point saved on the way past.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-(--radius-card) border border-line px-3 py-2">
              <p className="text-xs font-medium text-ink-muted">Now</p>
              <StateLines lines={currentStateLines} />
            </div>
            <div className="rounded-(--radius-card) border border-negative/40 bg-negative-soft px-3 py-2">
              <p className="text-xs font-medium">After restoring</p>
              <StateLines lines={row.stateLines} />
            </div>
          </div>

          <p className="text-xs text-ink-muted">
            The state you are replacing is snapshotted first, so this is reversible. The app
            reconnects to the restored ledger on its own — other tabs need a reload.
          </p>

          <Field label={`Type ${RESTORE_PHRASE} to confirm`}>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${inputId}-status`}
              onChange={(e) => {
                setTyped(e.target.value);
                if (blocked) setBlocked(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  attempt();
                }
              }}
            />
          </Field>

          {/* persistent live region — one mounted only when blocked would never
              announce the message it was mounted to carry.

              🔴 Its sentence made two claims, both false. `matchesRestorePhrase`
              is `input.trim().toUpperCase() === RESTORE_PHRASE` — its own
              docstring says "Case and surrounding whitespace are forgiven" — so
              "restore" and " Restore " both pass, and "exactly" is not what is
              asked. And the button carries no `disabled` (the deliberate rule
              is stated twice in this file); `attempt` intercepts the click, so
              nothing is ever enabled or disabled. */}
          <div id={`${inputId}-status`} aria-live="polite">
            {blocked ? (
              <p className="text-xs text-negative">
                Nothing was restored — type {RESTORE_PHRASE} to confirm, then press the button
                again.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Hands the snapshot to the browser's downloader. The bytes arrive base64 in
 * the action's result: this app has no route handlers, and a local-first
 * backup is only worth downloading because the copy needs to leave this disk.
 */
function saveToDisk(filename: string, base64: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.sqlite3" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // the download has been handed off; the object URL would otherwise pin the
  // whole file in memory for the life of the page
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
