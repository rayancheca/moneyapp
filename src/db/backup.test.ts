import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { maybeSnapshot } from "./backup";

let dir: string;
let dbPath: string;
let backupsDir: string;
let writer: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-backup-"));
  dbPath = path.join(dir, "test.db");
  backupsDir = path.join(dir, "backups");
  writer = new Database(dbPath);
  writer.pragma("journal_mode = WAL");
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = writer.prepare("INSERT INTO t (v) VALUES (?)");
  writer.transaction(() => {
    for (let i = 0; i < 10; i++) insert.run(`row-${i}`);
  })();
});

afterEach(() => {
  writer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 6, 8, 12, 0, 0);

describe("maybeSnapshot", () => {
  test("acceptance: snapshot during an in-flight write transaction opens cleanly with committed data only", async () => {
    const other = new Database(dbPath);
    other.pragma("busy_timeout = 5000");
    other.exec("BEGIN IMMEDIATE");
    other.prepare("INSERT INTO t (v) VALUES (?)").run("uncommitted");

    const result = await maybeSnapshot(writer, backupsDir, NOW);
    expect(result.status).toBe("created");

    other.exec("ROLLBACK");
    other.close();

    const snapshot = new Database(result.dailyPath, { readonly: true });
    expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
    const { c } = snapshot.prepare("SELECT COUNT(*) c FROM t").get() as { c: number };
    expect(c).toBe(10); // committed rows present, uncommitted row absent
    snapshot.close();
  });

  test("second call the same day is a no-op; monthly copy exists", async () => {
    const first = await maybeSnapshot(writer, backupsDir, NOW);
    expect(first.status).toBe("created");
    expect(first.monthlyCreated).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, "monthly-2026-07.db"))).toBe(true);

    const second = await maybeSnapshot(writer, backupsDir, NOW);
    expect(second.status).toBe("skipped");
    expect(second.monthlyCreated).toBe(false);
  });

  test("rotation keeps 14 daily + 6 monthly, newest first", async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    for (let i = 1; i <= 20; i++) {
      fs.writeFileSync(path.join(backupsDir, `daily-2026-06-${String(i).padStart(2, "0")}.db`), "x");
    }
    for (let m = 1; m <= 8; m++) {
      fs.writeFileSync(path.join(backupsDir, `monthly-2025-${String(m).padStart(2, "0")}.db`), "x");
    }

    const result = await maybeSnapshot(writer, backupsDir, NOW);
    const remaining = fs.readdirSync(backupsDir).sort();
    const daily = remaining.filter((f) => f.startsWith("daily-"));
    const monthly = remaining.filter((f) => f.startsWith("monthly-"));

    expect(daily).toHaveLength(14);
    expect(monthly).toHaveLength(6);
    // newest survive: today's snapshot + monthly copy exist
    expect(daily).toContain("daily-2026-07-08.db");
    expect(monthly).toContain("monthly-2026-07.db");
    // oldest were pruned
    expect(daily).not.toContain("daily-2026-06-01.db");
    expect(monthly).not.toContain("monthly-2025-01.db");
    expect(result.pruned.length).toBeGreaterThan(0);
  });

  test("a failed backup never leaves a plausible snapshot or tmp file", async () => {
    // force sqlite.backup() itself to fail: closed source connection
    const closed = new Database(dbPath);
    closed.close();
    await expect(maybeSnapshot(closed, backupsDir, NOW)).rejects.toThrow();
    const leftovers = fs.readdirSync(backupsDir);
    expect(leftovers.filter((f) => f.startsWith("daily-"))).toEqual([]);
    expect(leftovers.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("backups dir that cannot be created rejects loudly", async () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    await expect(maybeSnapshot(writer, path.join(blocked, "backups"), NOW)).rejects.toThrow();
  });

  test("concurrent calls share one in-flight snapshot run", async () => {
    const [a, b] = await Promise.all([
      maybeSnapshot(writer, backupsDir, NOW),
      maybeSnapshot(writer, backupsDir, NOW),
    ]);
    expect(a).toBe(b); // identical result object — one run, no tmp collision
    expect(a.status).toBe("created");
    expect(fs.readdirSync(backupsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("stale tmp files from hard crashes are pruned after an hour", async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    const staleTmp = path.join(backupsDir, "daily-2026-07-07.db.123-dead.tmp");
    fs.writeFileSync(staleTmp, "partial");
    const twoHoursAgo = (NOW.getTime() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    const result = await maybeSnapshot(writer, backupsDir, NOW);
    expect(result.pruned).toContain("daily-2026-07-07.db.123-dead.tmp");
    expect(fs.existsSync(staleTmp)).toBe(false);
  });
});
