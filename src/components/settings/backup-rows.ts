import type { RetentionPolicy, SnapshotListing, SnapshotSummary } from "@/db/backup";
import { todayIso } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { formatCents } from "@/lib/money";

/**
 * Snapshot summaries → what the Settings list actually says.
 *
 * Every string is built HERE, on the server, and handed to the client as text.
 * Two reasons: the ledger figures are money and dates, which this codebase
 * refuses to format twice; and a client that formatted a timestamp itself would
 * hydrate against whatever clock and locale the browser has, which is the
 * standard way a date on a server-rendered page ends up disagreeing with itself.
 */

export interface BackupStateLine {
  label: string;
  value: string;
}

export interface BackupRow {
  name: string;
  /** "Daily snapshot", "Restore point", … */
  kindLabel: string;
  /** what it preceded, when the name records it */
  description: string | null;
  /** "Tue, Jul 28, 2026 at 10:21" */
  takenAtLabel: string;
  sizeLabel: string;
  /** what the ledger looked like inside it — empty when it could not be read */
  stateLines: BackupStateLine[];
  /** null unless the file itself refused to be read */
  unreadable: string | null;
  /** false when no rotation rule matches this name, so it is kept forever */
  governedByRetention: boolean;
}

const KIND_LABEL: Record<SnapshotSummary["kind"], string> = {
  daily: "Daily snapshot",
  monthly: "Monthly archive",
  "restore-point": "Restore point",
  other: "Snapshot",
};

/** "12.2 MB" — one decimal past a megabyte, which is the scale of this archive. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** "Tue, Jul 28, 2026 at 10:21" from the file's own write time. */
export function formatTakenAt(takenAtMs: number | null): string {
  if (takenAtMs === null) return "time unknown";
  const at = new Date(takenAtMs);
  const hh = at.getHours().toString().padStart(2, "0");
  const mm = at.getMinutes().toString().padStart(2, "0");
  return `${formatDayLong(todayIso(at))} at ${hh}:${mm}`;
}

/** 9688 → "9,688". Counts are grouped the same way money is. */
export function formatCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function describeRestorePoint(label: string | null): string | null {
  if (label === null) return null;
  // the on-demand button's own label reads backwards as "before manual backup"
  if (label.startsWith("manual backup")) return "taken on demand";
  if (label.startsWith("restore")) return "before another restore";
  return `before ${label}`;
}

/**
 * The state lines a row shows. Deliberately four, in this order: how big the
 * ledger was, how far it ran, what it was worth, and how much of it he had
 * decided by hand.
 *
 * That last one is not decoration. Measured across the owner's 46 snapshots,
 * 30 of them share an identical transaction count, latest date AND net worth —
 * they are the restore points either side of a categorising session, and the
 * hand-decided count is the ONLY figure that tells them apart. Without it the
 * list would still be asking him to pick a filename.
 */
export function describeState(state: SnapshotSummary["state"]): BackupStateLine[] {
  if (state === null) return [];
  const lines: BackupStateLine[] = [
    { label: "Transactions", value: formatCount(state.transactions) },
    {
      label: "Ledger runs to",
      value: state.latestTransactionOn === null ? "—" : formatDayLong(state.latestTransactionOn),
    },
  ];
  if (state.netWorthCents !== null && state.netWorthOn !== null) {
    lines.push({
      label: `Net worth on ${formatDayLong(state.netWorthOn)}`,
      value:
        state.coveredAccounts === state.activeAccounts
          ? formatCents(state.netWorthCents)
          : `${formatCents(state.netWorthCents)} (${state.coveredAccounts} of ${state.activeAccounts} accounts)`,
    });
  } else {
    // "no account had coverage" is a real answer; "$0.00" would be a wrong one
    lines.push({ label: "Net worth", value: "no covered accounts" });
  }
  lines.push({ label: "Categorised by you", value: formatCount(state.userCategorized) });
  return lines;
}

export function toBackupRow(summary: SnapshotSummary): BackupRow {
  return {
    name: summary.name,
    kindLabel: KIND_LABEL[summary.kind],
    description:
      summary.kind === "restore-point" ? describeRestorePoint(summary.label) : null,
    takenAtLabel: formatTakenAt(summary.takenAtMs),
    sizeLabel: formatBytes(summary.sizeBytes),
    stateLines: describeState(summary.state),
    unreadable: summary.unreadable,
    governedByRetention: summary.governedByRetention,
  };
}

/**
 * What retention actually governs, in one sentence.
 *
 * The old copy said "N daily + M monthly snapshots" and stopped there, which
 * left out the restore points entirely and implied the whole folder was on a
 * rotation. It is not: the owner's archive holds script-written snapshots under
 * an older name and `-wal`/`-shm` siblings beside the raw-copied ones, and no
 * keep-N count has ever touched any of them.
 */
export function retentionSentence(
  listing: SnapshotListing,
  retention: RetentionPolicy,
): string {
  const governed = `Rotation keeps the newest ${retention.keepDaily} daily, ${retention.keepMonthly} monthly, and ${retention.keepPreMutation} restore points.`;
  const extras: string[] = [];
  if (listing.ungovernedFiles > 0) {
    extras.push(
      `${formatCount(listing.ungovernedFiles)} older ${listing.ungovernedFiles === 1 ? "snapshot is" : "snapshots are"} named outside those rules and never pruned`,
    );
  }
  if (listing.sidecarFiles > 0) {
    extras.push(
      `${formatCount(listing.sidecarFiles)} -wal/-shm ${listing.sidecarFiles === 1 ? "sibling sits" : "siblings sit"} beside raw copies and are not rotated either`,
    );
  }
  const total = `${formatCount(listing.totalFiles)} ${listing.totalFiles === 1 ? "snapshot" : "snapshots"}, ${formatBytes(listing.totalBytes)} on disk.`;
  return extras.length === 0
    ? `${governed} ${total}`
    : `${governed} ${extras.join("; ")}. ${total}`;
}
