import { describe, expect, test } from "vitest";
import type { SnapshotListing, SnapshotSummary } from "@/db/backup";
import { DEFAULT_RETENTION } from "@/db/backup";
import {
  formatBytes,
  formatCount,
  formatTakenAt,
  retentionSentence,
  toBackupRow,
} from "./backup-rows";

const STATE: NonNullable<SnapshotSummary["state"]> = {
  transactions: 9688,
  latestTransactionOn: "2026-07-14",
  netWorthCents: 8457848,
  netWorthOn: "2026-07-14",
  coveredAccounts: 9,
  activeAccounts: 9,
  userCategorized: 2450,
};

function summary(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    name: "daily-2026-07-28.db",
    kind: "daily",
    label: "2026-07-28",
    sizeBytes: 12_828_672,
    takenAtMs: new Date(2026, 6, 28, 10, 21, 0).getTime(),
    governedByRetention: true,
    state: STATE,
    unreadable: null,
    ...overrides,
  };
}

describe("formatBytes", () => {
  test("scales to the size of this archive", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(12_828_672)).toBe("12.2 MB");
  });

  test("an unreadable file says so instead of showing zero", () => {
    expect(formatBytes(null)).toBe("unknown size");
  });
});

describe("formatCount", () => {
  test("groups the way money does", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(9688)).toBe("9,688");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });
});

describe("formatTakenAt", () => {
  test("names the day and the time the file was written", () => {
    expect(formatTakenAt(new Date(2026, 6, 28, 10, 21, 0).getTime())).toBe(
      "Tue, Jul 28, 2026 at 10:21",
    );
    expect(formatTakenAt(new Date(2026, 6, 5, 9, 5, 0).getTime())).toBe(
      "Sun, Jul 5, 2026 at 09:05",
    );
  });

  test("a file that could not be stat'd says so", () => {
    expect(formatTakenAt(null)).toBe("time unknown");
  });
});

describe("toBackupRow", () => {
  test("states the ledger inside the snapshot, not just the filename", () => {
    const row = toBackupRow(summary());
    expect(row.kindLabel).toBe("Daily snapshot");
    expect(row.takenAtLabel).toBe("Tue, Jul 28, 2026 at 10:21");
    expect(row.sizeLabel).toBe("12.2 MB");
    expect(row.stateLines).toEqual([
      { label: "Transactions", value: "9,688" },
      { label: "Ledger runs to", value: "Tue, Jul 14, 2026" },
      { label: "Net worth on Tue, Jul 14, 2026", value: "$84,578.48" },
      { label: "Categorised by you", value: "2,450" },
    ]);
  });

  test("the hand-decided count is what separates otherwise identical states", () => {
    const a = toBackupRow(summary({ state: { ...STATE, userCategorized: 506 } }));
    const b = toBackupRow(summary({ state: { ...STATE, userCategorized: 1726 } }));
    // measured: 30 of the owner's 46 snapshots agree on all three other figures
    expect(a.stateLines.slice(0, 3)).toEqual(b.stateLines.slice(0, 3));
    expect(a.stateLines.at(-1)).not.toEqual(b.stateLines.at(-1));
  });

  test("a partly-covered net worth says how partial it is", () => {
    const row = toBackupRow(summary({ state: { ...STATE, coveredAccounts: 7 } }));
    expect(row.stateLines[2]!.value).toBe("$84,578.48 (7 of 9 accounts)");
  });

  test("no coverage reads as nothing, never as $0.00", () => {
    const row = toBackupRow(
      summary({ state: { ...STATE, netWorthCents: null, netWorthOn: null, coveredAccounts: 0 } }),
    );
    expect(row.stateLines[2]).toEqual({ label: "Net worth", value: "no covered accounts" });
  });

  test("a restore point says what it preceded", () => {
    const row = toBackupRow(
      summary({
        name: "pre-2026-07-23T105800-clarify-peers.db",
        kind: "restore-point",
        label: "clarify peers",
      }),
    );
    expect(row.kindLabel).toBe("Restore point");
    expect(row.description).toBe("before clarify peers");
  });

  test("the on-demand and pre-restore points are not described backwards", () => {
    expect(
      toBackupRow(summary({ kind: "restore-point", label: "manual backup" })).description,
    ).toBe("taken on demand");
    expect(toBackupRow(summary({ kind: "restore-point", label: "restore" })).description).toBe(
      "before another restore",
    );
  });

  test("an unreadable snapshot is a row that explains itself, with no figures", () => {
    const row = toBackupRow(summary({ state: null, unreadable: "file is not a database" }));
    expect(row.stateLines).toEqual([]);
    expect(row.unreadable).toBe("file is not a database");
  });
});

describe("retentionSentence", () => {
  const listing = (overrides: Partial<SnapshotListing> = {}): SnapshotListing => ({
    snapshots: [],
    totalFiles: 46,
    sidecarFiles: 8,
    ungovernedFiles: 34,
    totalBytes: 500 * 1024 * 1024,
    ...overrides,
  });

  test("names all three rotations, not just daily and monthly", () => {
    const sentence = retentionSentence(listing(), DEFAULT_RETENTION);
    expect(sentence).toContain("14 daily");
    expect(sentence).toContain("6 monthly");
    expect(sentence).toContain("12 restore points");
  });

  test("admits what rotation does NOT govern", () => {
    const sentence = retentionSentence(listing(), DEFAULT_RETENTION);
    expect(sentence).toContain("34 older snapshots are named outside those rules");
    expect(sentence).toContain("8 -wal/-shm siblings");
    expect(sentence).toContain("46 snapshots, 500.0 MB on disk");
  });

  test("says nothing about extras when there are none", () => {
    const sentence = retentionSentence(
      listing({ totalFiles: 1, sidecarFiles: 0, ungovernedFiles: 0, totalBytes: 1024 }),
      DEFAULT_RETENTION,
    );
    expect(sentence).not.toContain("-wal");
    expect(sentence).toContain("1 snapshot, 1 KB on disk");
  });
});
