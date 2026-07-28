import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { MAX_FINANCIAL_DATE, MIN_FINANCIAL_DATE } from "@/lib/date-window";
import { createAccount } from "./accounts";
import { addManualAnchor, deleteAnchor, listAnchors, manualAnchorInputSchema } from "./anchors";

/**
 * Schema-level tests only: parse runs before any database work, so a rejected
 * date can never reach rebuildAccount's insert loop. The DB behaviour of
 * addManualAnchor is covered by derivation.test.ts's integration suite.
 */
describe("manualAnchorInputSchema — anchoredOn bounds", () => {
  const base = { accountId: "acct_1", enteredCents: 10_000 };

  test("accepts a real date and both window bounds", () => {
    for (const anchoredOn of ["2026-07-08", MIN_FINANCIAL_DATE, MAX_FINANCIAL_DATE]) {
      expect(manualAnchorInputSchema.safeParse({ ...base, anchoredOn }).success).toBe(true);
    }
  });

  test("rejects a fat-fingered year, naming the field", () => {
    for (const anchoredOn of ["1026-07-08", "9999-12-31", "1969-12-31", "2100-01-01"]) {
      const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message).join(" ")).toMatch(
        /anchoredOn must be between/,
      );
    }
  });

  test("a malformed date still reports the shape problem", () => {
    const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn: "20260-01-01" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain("Invalid date");
  });

  test("rejects rather than clamping — no valid date is invented", () => {
    const result = manualAnchorInputSchema.safeParse({ ...base, anchoredOn: "9999-12-31" });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

describe("pre-mutation snapshots", () => {
  let dir: string;
  let bundle: DbBundle;
  let accountId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-anchors-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Chase"))
      .get()!;
    accountId = createAccount(bundle.db, {
      institutionId: chase.id,
      name: "Checking",
      type: "checking",
    });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The archive lives beside the database it protects. */
  const snapshots = (): string[] => {
    const backups = path.join(dir, "backups");
    if (!fs.existsSync(backups)) return [];
    // .db only — reading a snapshot back leaves -wal/-shm siblings behind
    return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
  };

  test("a first anchor for the day loses nothing, so it takes no snapshot", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    expect(snapshots()).toEqual([]);
  });

  test("overwriting a day's anchor snapshots the figure it replaces", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 25_000 });

    const name = snapshots()[0]!;
    expect(name).toMatch(/-overwrite-anchor\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    expect(listAnchors(before.db, accountId).map((a) => a.balanceCents)).toEqual([10_000]);
    before.sqlite.close();
    expect(listAnchors(bundle.db, accountId).map((a) => a.balanceCents)).toEqual([25_000]);
  });

  test("re-saving the identical figure loses nothing, so it takes no snapshot", () => {
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    addManualAnchor(bundle.db, { accountId, anchoredOn: "2026-07-01", enteredCents: 10_000 });
    expect(snapshots()).toEqual([]);
  });

  test("deleting a hand-entered balance snapshots it first", () => {
    const anchorId = addManualAnchor(bundle.db, {
      accountId,
      anchoredOn: "2026-07-01",
      enteredCents: 10_000,
    });
    deleteAnchor(bundle.db, anchorId);

    const name = snapshots()[0]!;
    expect(name).toMatch(/-delete-anchor\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    expect(listAnchors(before.db, accountId)).toHaveLength(1);
    before.sqlite.close();
    expect(listAnchors(bundle.db, accountId)).toHaveLength(0);
  });

  test("a statement-derived anchor is refused before any snapshot is taken", () => {
    const anchorId = addManualAnchor(bundle.db, {
      accountId,
      anchoredOn: "2026-07-01",
      enteredCents: 10_000,
    });
    bundle.sqlite.prepare("UPDATE balance_anchors SET source = 'statement' WHERE id = ?").run(anchorId);

    expect(() => deleteAnchor(bundle.db, anchorId)).toThrow(/un-importing/);
    expect(snapshots()).toEqual([]);
  });
});
