import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase, type DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { seedHisCarSeries, type OneChargeLedger } from "./one-charge-fixture";

// a write landing between the merge's first reading and its own transaction — another tab, a script
const between = vi.hoisted(() => ({ write: undefined as (() => void) | undefined }));
vi.mock("@/db/backup", async (actual) => ({
  ...(await actual<typeof import("@/db/backup")>()),
  withPreMutationTransaction: <T>(db: AppDatabase, _label: string, write: (tx: never) => T): T => {
    between.write?.();
    return db.transaction((tx) => write(tx as never));
  },
}));

const { MERGE_FILING_CHANGED, mergeFilings, mergeSeries } = await import("./recurring-links");

/*
 * ⚖️ §6A 54 (2026-10-08): the confirmation names what the merge files, and the merge refuses anything else. It reads
 * once before its restore point — so a refusal takes none — and again inside its own transaction: the reading it
 * writes by. 🔴 Checked only before, a row filed in the gap would be merged past what he was shown.
 */
describe("a merge reads what it files again inside its own write", () => {
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-merge-race-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
  });

  afterEach(() => {
    between.write = undefined;
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a row filed after the first reading is still caught — refused, and nothing of the merge is written", () => {
    const { db } = bundle;
    const source = db
      .insert(recurringSeries)
      .values({ name: "PROGRESSIVE — a second schedule", kind: "bill", cadence: "monthly", status: "detected" })
      .returning({ id: recurringSeries.id })
      .get().id;
    const row = his.charge("2026-10-03", -7274, source);
    db.update(transactions).set({ categoryId: null }).where(eq(transactions.id, row)).run();
    const shown = mergeFilings(db, his.insuranceId, [source]).get(source) ?? null;
    expect(shown?.count).toBe(1);
    between.write = () => {
      db.update(transactions).set({ categoryId: his.carId }).where(eq(transactions.id, row)).run();
    };

    expect(() => mergeSeries(db, source, his.insuranceId, "2026-10-12", shown)).toThrow(MERGE_FILING_CHANGED);

    expect(db.select().from(transactions).where(eq(transactions.id, row)).get()!.recurringSeriesId).toBe(source);
    const after = db.select().from(recurringSeries).where(eq(recurringSeries.id, source)).get()!;
    expect([after.status, after.mergedIntoId]).toEqual(["detected", null]);
  });
});
