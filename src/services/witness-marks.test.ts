import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { preMutationSnapshot, restoreFromSnapshot } from "@/db/backup";
import { createDatabase, defaultMigrationsFolder, type DbBundle } from "@/db/client";
import { readWitnessMarks, writeWitnessMarks } from "./witness-marks";

let dir: string;
let bundle: DbBundle;
const opened: DbBundle[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-witness-marks-"));
  bundle = createDatabase(path.join(dir, "ledger.db"));
  opened.push(bundle);
});

afterEach(() => {
  for (const b of opened.splice(0)) {
    if (b.sqlite.open) b.sqlite.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// the owner's first Robinhood Brokerage statement, and the one after it
const MARK = {
  count: 2,
  witnesses: [
    ["Robinhood Brokerage", "2024-08-31"],
    ["Robinhood Brokerage", "2024-09-30"],
  ],
};
const LOWERED = { count: 1, witnesses: [["Robinhood Brokerage", "2024-09-30"]] };

describe("the store", () => {
  test("a migrated ledger holds no marks — so its first run records them", () => {
    expect(readWitnessMarks(bundle.db)).toEqual({});
  });

  test("a written mark reads back as written", () => {
    writeWitnessMarks(bundle.db, { "value-anchors": MARK });
    expect(readWitnessMarks(bundle.db)).toEqual({ "value-anchors": MARK });
  });

  test("writing a kind replaces that kind's mark and leaves every other kind's alone", () => {
    writeWitnessMarks(bundle.db, { "value-anchors": MARK, accounts: { count: 1, witnesses: [["Cash on Hand"]] } });
    writeWitnessMarks(bundle.db, { "value-anchors": LOWERED });
    expect(readWitnessMarks(bundle.db)).toEqual({
      "value-anchors": LOWERED,
      accounts: { count: 1, witnesses: [["Cash on Hand"]] },
    });
  });

  test("a run with nothing to write writes nothing — the hook touches the ledger only when a count moves", () => {
    writeWitnessMarks(bundle.db, { "value-anchors": MARK });
    const changes = () => (bundle.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    writeWitnessMarks(bundle.db, {});
    expect(changes()).toBe(before);
  });

  test("⛔ a stored mark that cannot be read is an error, never an absent mark that the next run would re-record", () => {
    bundle.sqlite
      .prepare("INSERT INTO ledger_witness_marks (kind, mark, witnesses, updated_at) VALUES (?, ?, ?, ?)")
      .run("value-anchors", 43, JSON.stringify(LOWERED.witnesses), "2026-09-15T00:00:00.000Z");
    expect(() => readWitnessMarks(bundle.db)).toThrow(/the value anchors mark says 43 but lists 1 witness/);
  });
});

describe("the mark lives in the ledger it describes", () => {
  test("a copy made from the ledger carries its marks, and writing the copy leaves the ledger's marks alone", () => {
    writeWitnessMarks(bundle.db, { "value-anchors": MARK });
    const snap = preMutationSnapshot(bundle.sqlite, path.join(dir, "rehearsal"), "rehearsal");
    const copy = createDatabase(snap.path!);
    opened.push(copy);

    expect(readWitnessMarks(copy.db)).toEqual({ "value-anchors": MARK });
    writeWitnessMarks(copy.db, { "value-anchors": LOWERED });

    expect(readWitnessMarks(copy.db)).toEqual({ "value-anchors": LOWERED });
    expect(readWitnessMarks(bundle.db)).toEqual({ "value-anchors": MARK });
  });

  test("restoring a snapshot brings back the marks that snapshot held — never one set after it", () => {
    writeWitnessMarks(bundle.db, { "value-anchors": LOWERED });
    const snap = preMutationSnapshot(bundle.sqlite, path.join(dir, "backups"), "before-import");
    writeWitnessMarks(bundle.db, { "value-anchors": MARK });

    const { reopened } = restoreFromSnapshot(bundle, snap.path!);
    opened.push(reopened);

    expect(readWitnessMarks(reopened.db)).toEqual({ "value-anchors": LOWERED });
  });

  test("restoring a snapshot from before the marks existed leaves none, so the next run records them afresh", () => {
    // a snapshot one migration behind: the table and the migration that made it, both absent
    const oldPath = path.join(dir, "older.db");
    const old = createDatabase(oldPath);
    const journal = JSON.parse(
      fs.readFileSync(path.join(defaultMigrationsFolder(), "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string; when: number }[] };
    const making = journal.entries.find((e) =>
      fs.readFileSync(path.join(defaultMigrationsFolder(), `${e.tag}.sql`), "utf8").includes("CREATE TABLE `ledger_witness_marks`"),
    );
    expect(making).toBeDefined();
    old.sqlite.exec("DROP TABLE ledger_witness_marks");
    old.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(making!.when);
    old.sqlite.close();

    writeWitnessMarks(bundle.db, { "value-anchors": MARK });
    const { reopened } = restoreFromSnapshot(bundle, oldPath);
    opened.push(reopened);

    expect(readWitnessMarks(reopened.db)).toEqual({});
  });
});
