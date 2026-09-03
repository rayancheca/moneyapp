import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase, type DbBundle } from "./client";
import {
  classifySnapshot,
  clearSnapshotStateCache,
  dailySnapshotDir,
  listSnapshots,
  manualSnapshot,
  maybeSnapshot,
  preMutationSnapshot,
  readSnapshotState,
  resolveSnapshotPath,
  restoreFromSnapshot,
  withPreMutationSnapshot,
} from "./backup";

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

describe("preMutationSnapshot", () => {
  test("names the snapshot after what it preceded and when, and it opens cleanly", () => {
    const result = preMutationSnapshot(writer, backupsDir, "unimport-file", NOW);

    expect(result.status).toBe("created");
    expect(path.basename(result.path!)).toBe("pre-2026-07-08T120000-unimport-file.db");
    // exactly one file: no tmp, no -wal/-journal residue beside it
    expect(fs.readdirSync(backupsDir)).toEqual(["pre-2026-07-08T120000-unimport-file.db"]);
    const snapshot = new Database(result.path!, { readonly: true });
    expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((snapshot.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c).toBe(10);
    snapshot.close();
  });

  test("the name prefix sorts after daily-/monthly-, which is why listing sorts by time", () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, "daily-2026-07-08.db"), "x");
    fs.writeFileSync(path.join(backupsDir, "monthly-2026-07.db"), "x");
    preMutationSnapshot(writer, backupsDir, "delete-anchor", NOW);

    // A reverse NAME sort puts every pre- ahead of every daily-, whatever the
    // dates say — the bug that hid all 14 of the owner's dailies behind an
    // 8-row window. listSnapshots orders by write time instead.
    const listed = fs.readdirSync(backupsDir).sort().reverse();
    expect(listed[0]).toBe("pre-2026-07-08T120000-delete-anchor.db");
    expect(listed.at(-1)).toBe("daily-2026-07-08.db");
  });

  test("a label with unsafe characters becomes a slug, never a path", () => {
    const result = preMutationSnapshot(writer, backupsDir, "../../Retro Apply!", NOW);
    expect(path.dirname(result.path!)).toBe(backupsDir);
    expect(path.basename(result.path!)).toBe("pre-2026-07-08T120000-retro-apply.db");
  });

  test("two mutations in the same second keep both restore points", () => {
    const first = preMutationSnapshot(writer, backupsDir, "merge-series", NOW);
    const second = preMutationSnapshot(writer, backupsDir, "merge-series", NOW);
    expect(second.path).not.toBe(first.path);
    expect(fs.existsSync(first.path!)).toBe(true);
    expect(path.basename(second.path!)).toBe("pre-2026-07-08T120000-merge-series-2.db");
  });

  test("retention keeps the newest 12 and never touches daily/monthly", () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    for (let i = 1; i <= 20; i++) {
      const stamp = `2026-07-08T${String(i).padStart(2, "0")}0000`;
      fs.writeFileSync(path.join(backupsDir, `pre-${stamp}-delete-anchor.db`), "x");
    }
    fs.writeFileSync(path.join(backupsDir, "daily-2026-07-08.db"), "x");
    fs.writeFileSync(path.join(backupsDir, "monthly-2026-07.db"), "x");

    preMutationSnapshot(writer, backupsDir, "accept-gap", NOW);

    const remaining = fs.readdirSync(backupsDir);
    expect(remaining.filter((f) => f.startsWith("pre-"))).toHaveLength(12);
    // the snapshot just taken survives; the oldest placeholders are gone
    expect(remaining).toContain("pre-2026-07-08T120000-accept-gap.db");
    expect(remaining).not.toContain("pre-2026-07-08T010000-delete-anchor.db");
    expect(remaining).toContain("daily-2026-07-08.db");
    expect(remaining).toContain("monthly-2026-07.db");
  });

  test("a failed snapshot throws and leaves no plausible restore point", () => {
    const closed = new Database(dbPath);
    closed.close();
    expect(() => preMutationSnapshot(closed, backupsDir, "unimport-file", NOW)).toThrow();
    const leftovers = fs.readdirSync(backupsDir);
    expect(leftovers.filter((f) => f.startsWith("pre-"))).toEqual([]);
    expect(leftovers.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses to snapshot from inside a transaction, naming the fix", () => {
    writer.exec("BEGIN");
    try {
      expect(() => preMutationSnapshot(writer, backupsDir, "merge-series", NOW)).toThrow(
        /before opening a transaction/,
      );
    } finally {
      writer.exec("ROLLBACK");
    }
  });
});

describe("withPreMutationSnapshot", () => {
  let appDir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-premutation-"));
    // built before any cwd stub — createDatabase resolves migrations from cwd
    bundle = createDatabase(path.join(appDir, "data", "moneyapp.db"));
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(appDir, { recursive: true, force: true });
    delete process.env.MONEYAPP_SKIP_BACKUP;
    vi.restoreAllMocks();
  });

  const archive = () => {
    const dir = path.join(appDir, "data", "backups");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("pre-")) : [];
  };

  test("the snapshot lands BEFORE the mutation runs — it holds the prior state", () => {
    bundle.sqlite.exec("CREATE TABLE t (v TEXT)");
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('before')").run();

    const returned = withPreMutationSnapshot(bundle.db, "delete-manual-transaction", () => {
      bundle.sqlite.exec("DELETE FROM t");
      return "mutated";
    });

    expect(returned).toBe("mutated");
    const name = archive()[0]!;
    expect(name).toMatch(/^pre-\d{4}-\d{2}-\d{2}T\d{6}-delete-manual-transaction\.db$/);
    const snapshot = new Database(path.join(appDir, "data", "backups", name), { readonly: true });
    expect((snapshot.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c).toBe(1);
    snapshot.close();
    // and the live database really did change
    expect((bundle.sqlite.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c).toBe(0);
  });

  test("a snapshot that cannot be written ABORTS the mutation", () => {
    // a file where the archive directory belongs — mkdir fails
    fs.writeFileSync(path.join(appDir, "data", "backups"), "not a directory");
    let ran = false;

    expect(() =>
      withPreMutationSnapshot(bundle.db, "unimport-file", () => {
        ran = true;
      }),
    ).toThrow(/nothing was changed/);
    expect(ran).toBe(false);
  });

  test("a database with no driver handle aborts rather than mutating unprotected", () => {
    let ran = false;
    const handleless = { select: () => undefined } as unknown as AppDatabase;
    expect(() =>
      withPreMutationSnapshot(handleless, "unimport-file", () => {
        ran = true;
      }),
    ).toThrow(/no better-sqlite3 handle/);
    expect(ran).toBe(false);
  });

  test("MONEYAPP_SKIP_BACKUP turns snapshots off for the e2e database", () => {
    process.env.MONEYAPP_SKIP_BACKUP = "1";
    let ran = false;
    withPreMutationSnapshot(bundle.db, "accept-gap", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(archive()).toEqual([]);
  });

  test("MONEYAPP_SKIP_BACKUP cannot leave the REAL database unprotected", () => {
    process.env.MONEYAPP_SKIP_BACKUP = "1";
    // the bundle's file IS <cwd>/data/moneyapp.db once cwd points at appDir
    vi.spyOn(process, "cwd").mockReturnValue(appDir);

    withPreMutationSnapshot(bundle.db, "accept-gap", () => undefined);
    expect(archive()).toHaveLength(1);
  });

  test("an in-memory database has no file to protect, so it is skipped", () => {
    const memory = createDatabase(":memory:");
    let ran = false;
    withPreMutationSnapshot(memory.db, "merge-series", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "backups"))).toBe(false);
    memory.sqlite.close();
  });
});

describe("dailySnapshotDir", () => {
  const real = path.join(process.cwd(), "data", "moneyapp.db");

  test("the real database snapshots into the real archive", () => {
    expect(dailySnapshotDir(real, {})).toBe(path.join(process.cwd(), "data", "backups"));
  });

  /*
   * 🔴 The e2e fixture's daily snapshot was found IN the owner's rotation —
   * `data/e2e.db` lives beside the real file, and a fixed default folder does
   * not care which database it is snapshotting.
   */
  test("another database beside the real one is not snapshotted into its archive", () => {
    expect(dailySnapshotDir(path.join(process.cwd(), "data", "e2e.db"), {})).toBeNull();
    expect(dailySnapshotDir("/somewhere/else/moneyapp.db", {})).toBeNull();
  });

  test("an explicit MONEYAPP_BACKUPS_DIR is honoured for any database, and an empty one is not", () => {
    expect(dailySnapshotDir("/tmp/fixture.db", { MONEYAPP_BACKUPS_DIR: "/tmp/fixture-backups" })).toBe("/tmp/fixture-backups");
    expect(dailySnapshotDir(real, { MONEYAPP_BACKUPS_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    expect(dailySnapshotDir("/tmp/fixture.db", { MONEYAPP_BACKUPS_DIR: "" })).toBeNull();
  });
});

describe("classifySnapshot", () => {
  test("names each shape and says which ones retention actually rotates", () => {
    expect(classifySnapshot("daily-2026-07-08.db")).toEqual({
      kind: "daily",
      label: "2026-07-08",
      governedByRetention: true,
    });
    expect(classifySnapshot("monthly-2026-07.db")).toEqual({
      kind: "monthly",
      label: "2026-07",
      governedByRetention: true,
    });
    expect(classifySnapshot("pre-2026-07-23T105800-clarify-peers.db")).toEqual({
      kind: "restore-point",
      label: "clarify peers",
      governedByRetention: true,
    });
  });

  test("the owner's older script snapshots are restore points NO rule prunes", () => {
    // measured on the real archive: 34 of 46 files carry one of these shapes,
    // and prune()'s PRE_RE has never matched a single one of them
    expect(classifySnapshot("pre-clarify-robinhood-2026-07-23.db")).toEqual({
      kind: "restore-point",
      label: "clarify robinhood",
      governedByRetention: false,
    });
    expect(classifySnapshot("pre-stage4a-20260710-200637.db")).toEqual({
      kind: "restore-point",
      label: "stage4a",
      governedByRetention: false,
    });
  });

  test("a stray .db file is neither claimed as a restore point nor as retained", () => {
    expect(classifySnapshot("something-else.db")).toEqual({
      kind: "other",
      label: null,
      governedByRetention: false,
    });
  });
});

/** The three tables a snapshot summary reads — nothing else is needed here. */
const LEDGER_DDL = `
  CREATE TABLE transactions (id TEXT, posted_on TEXT, status TEXT, categorization_source TEXT);
  CREATE TABLE accounts (id TEXT, is_active INTEGER);
  CREATE TABLE daily_balances (account_id TEXT, day TEXT, balance_cents INTEGER, basis TEXT);
`;

describe("readSnapshotState", () => {
  let appDir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-snapstate-"));
    bundle = createDatabase(path.join(appDir, "data", "moneyapp.db"));
    clearSnapshotStateCache();
  });

  afterEach(() => {
    try {
      bundle.sqlite.close();
    } catch {
      // a restore test may already have closed it
    }
    fs.rmSync(appDir, { recursive: true, force: true });
    clearSnapshotStateCache();
  });

  /** A ledger just real enough to measure: one asset, one liability, one day. */
  function seedLedger(sqlite: Database.Database): void {
    sqlite.exec(`
      INSERT INTO institutions (id, name, created_at, updated_at) VALUES ('i1', 'Bank', 'x', 'x');
      INSERT INTO accounts (id, institution_id, name, type, currency, is_active, display_order, created_at, updated_at)
        VALUES ('a1', 'i1', 'Checking', 'checking', 'USD', 1, 0, 'x', 'x'),
               ('a2', 'i1', 'Card', 'credit', 'USD', 1, 1, 'x', 'x'),
               ('a3', 'i1', 'Closed', 'checking', 'USD', 0, 2, 'x', 'x');
      INSERT INTO daily_balances (account_id, day, balance_cents, basis) VALUES
        ('a1', '2026-07-05', 500000, 'anchored'),
        ('a1', '2026-07-09', 700000, 'derived'),
        ('a2', '2026-07-04', -120000, 'anchored'),
        ('a2', '2026-07-09', -999999, 'gap'),
        ('a3', '2026-07-09', 4200, 'anchored');
      INSERT INTO transactions
        (id, account_id, posted_on, amount_cents, raw_description, normalized_description,
         dedupe_hash, occurrence_index, categorization_source, needs_review, status,
         created_at, updated_at)
        VALUES
        ('t1', 'a1', '2026-07-02', -1000, 'COFFEE', 'coffee', 'h1', 0, 'user', 0, 'active', 'x', 'x'),
        ('t2', 'a1', '2026-07-06', -2000, 'RENT', 'rent', 'h2', 0, 'rule', 0, 'active', 'x', 'x'),
        ('t3', 'a1', '2026-07-08', -3000, 'DUPE', 'dupe', 'h3', 0, NULL, 0, 'superseded', 'x', 'x');
    `);
  }

  test("measures the ledger inside the file — counts, reach, net worth, hand decisions", () => {
    seedLedger(bundle.sqlite);
    const snapshot = preMutationSnapshot(bundle.sqlite, backupsDir, "measure", NOW).path!;

    const state = readSnapshotState(snapshot);
    expect(state.transactions).toBe(2); // superseded rows are not the ledger
    expect(state.latestTransactionOn).toBe("2026-07-06");
    expect(state.userCategorized).toBe(1);
    // as of 2026-07-06: checking's 07-05 anchor + the card's 07-04 anchor.
    // The 07-09 rows are after the day; the 'gap' row is never a level; the
    // inactive account is not part of net worth.
    expect(state.netWorthCents).toBe(500000 - 120000);
    expect(state.netWorthOn).toBe("2026-07-06");
    expect(state.coveredAccounts).toBe(2);
    expect(state.activeAccounts).toBe(2);
  });

  test("a snapshot with no transactions still reports a state, not a blank", () => {
    bundle.sqlite.exec(`
      INSERT INTO institutions (id, name, created_at, updated_at) VALUES ('i1', 'Bank', 'x', 'x');
      INSERT INTO accounts (id, institution_id, name, type, currency, is_active, display_order, created_at, updated_at)
        VALUES ('a1', 'i1', 'Checking', 'checking', 'USD', 1, 0, 'x', 'x');
      INSERT INTO daily_balances (account_id, day, balance_cents, basis)
        VALUES ('a1', '2026-07-09', 111100, 'anchored');
    `);
    const snapshot = preMutationSnapshot(bundle.sqlite, backupsDir, "empty", NOW).path!;

    const state = readSnapshotState(snapshot);
    expect(state.transactions).toBe(0);
    expect(state.latestTransactionOn).toBeNull();
    expect(state.netWorthOn).toBe("2026-07-09"); // falls back to the balance cache
    expect(state.netWorthCents).toBe(111100);
  });

  test("no coverage is reported as nothing, never as $0", () => {
    const snapshot = preMutationSnapshot(bundle.sqlite, backupsDir, "bare", NOW).path!;
    const state = readSnapshotState(snapshot);
    expect(state.netWorthCents).toBeNull();
    expect(state.netWorthOn).toBeNull();
    expect(state.coveredAccounts).toBe(0);
  });

  test("reading a snapshot leaves the file AND the folder exactly as it found them", () => {
    seedLedger(bundle.sqlite);
    const snapshot = preMutationSnapshot(bundle.sqlite, backupsDir, "readonly", NOW).path!;
    const before = fs.statSync(snapshot);
    const dirBefore = fs.readdirSync(backupsDir).sort();

    readSnapshotState(snapshot);

    const after = fs.statSync(snapshot);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // (VACUUM INTO writes journal_mode=delete, so this one never had siblings;
    //  the WAL case — where SQLite MUST build a -shm — is the test below)
    expect(fs.readdirSync(backupsDir).sort()).toEqual(dirBefore);
  });

  test("reading a WAL snapshot leaves no -shm litter, and still counts its -wal", () => {
    // a raw-copied snapshot whose committed pages live in its -wal
    const hot = path.join(appDir, "hot.db");
    const sq = new Database(hot);
    sq.pragma("journal_mode = WAL");
    sq.exec(LEDGER_DDL);
    sq.prepare("INSERT INTO transactions VALUES ('t1', '2026-07-20', 'active', 'user')").run();
    fs.mkdirSync(backupsDir, { recursive: true });
    const copy = path.join(backupsDir, "pre-raw-2026-07-20.db");
    fs.copyFileSync(hot, copy);
    fs.copyFileSync(`${hot}-wal`, `${copy}-wal`);
    sq.close();
    const walBefore = fs.statSync(`${copy}-wal`);

    // the row is only right if the -wal was read, not skipped
    expect(readSnapshotState(copy).transactions).toBe(1);
    // the -wal was already there and holds committed pages — not ours to touch
    expect(fs.statSync(`${copy}-wal`).size).toBe(walBefore.size);
    // the -shm SQLite built to read it IS ours, and a Settings render that left
    // one behind per snapshot doubled the file count of the whole archive
    expect(fs.existsSync(`${copy}-shm`)).toBe(false);
    expect(fs.readdirSync(backupsDir).sort()).toEqual([
      "pre-raw-2026-07-20.db",
      "pre-raw-2026-07-20.db-wal",
    ]);
  });

  test("a file that is not a database throws rather than returning a wrong number", () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    const junk = path.join(backupsDir, "daily-2026-01-01.db");
    fs.writeFileSync(junk, "definitely not sqlite");
    expect(() => readSnapshotState(junk)).toThrow();
  });
});

describe("listSnapshots", () => {
  beforeEach(() => {
    fs.mkdirSync(backupsDir, { recursive: true });
    clearSnapshotStateCache();
  });
  afterEach(() => {
    clearSnapshotStateCache();
  });

  /** Writes a real (if minimal) ledger so the row can actually be summarised. */
  function writeSnapshot(name: string, atMs: number, txnRows = 0): string {
    const full = path.join(backupsDir, name);
    const sq = new Database(full);
    sq.exec(LEDGER_DDL);
    for (let i = 0; i < txnRows; i++) {
      sq.prepare("INSERT INTO transactions VALUES (?, '2026-07-20', 'active', 'user')").run(`t${i}`);
    }
    sq.close();
    fs.utimesSync(full, atMs / 1000, atMs / 1000);
    return full;
  }

  test("REGRESSION: a daily newer than every restore point is listed first", () => {
    // Reverse-name order put all 8 pre- files ahead of all 14 dailies, so the
    // owner's most recent snapshot was invisible on his own Settings page.
    writeSnapshot("pre-2026-07-01T090000-old-import.db", Date.UTC(2026, 6, 1));
    writeSnapshot("monthly-2026-07.db", Date.UTC(2026, 6, 2));
    writeSnapshot("daily-2026-07-28.db", Date.UTC(2026, 6, 28));

    const { snapshots } = listSnapshots(backupsDir);
    expect(snapshots.map((s) => s.name)).toEqual([
      "daily-2026-07-28.db",
      "monthly-2026-07.db",
      "pre-2026-07-01T090000-old-import.db",
    ]);
  });

  test("one unreadable file becomes one row that says so, not a dead page", () => {
    writeSnapshot("daily-2026-07-27.db", Date.UTC(2026, 6, 27));
    fs.writeFileSync(path.join(backupsDir, "daily-2026-07-28.db"), "corrupt");
    fs.utimesSync(path.join(backupsDir, "daily-2026-07-28.db"), 1_800_000, 1_800_000);

    const { snapshots } = listSnapshots(backupsDir);
    expect(snapshots).toHaveLength(2);
    const broken = snapshots.find((s) => s.name === "daily-2026-07-28.db")!;
    expect(broken.state).toBeNull();
    expect(broken.unreadable).not.toBeNull();
    expect(broken.sizeBytes).toBe(7); // still stat'd, still listed
    expect(snapshots.find((s) => s.name === "daily-2026-07-27.db")!.state).not.toBeNull();
  });

  test("counts the sidecars and the files no retention rule governs", () => {
    writeSnapshot("daily-2026-07-28.db", Date.UTC(2026, 6, 28));
    writeSnapshot("pre-clarify-peers-2026-07-23.db", Date.UTC(2026, 6, 23));
    fs.writeFileSync(path.join(backupsDir, "pre-clarify-peers-2026-07-23.db-wal"), "w");
    fs.writeFileSync(path.join(backupsDir, "pre-clarify-peers-2026-07-23.db-shm"), "s");

    const listing = listSnapshots(backupsDir);
    expect(listing.totalFiles).toBe(2); // sidecars are not snapshots
    expect(listing.sidecarFiles).toBe(2);
    expect(listing.ungovernedFiles).toBe(1);
    expect(listing.totalBytes).toBeGreaterThan(0);
  });

  test("the window is capped but the total is still reported honestly", () => {
    for (let d = 1; d <= 5; d++) {
      writeSnapshot(`daily-2026-07-0${d}.db`, Date.UTC(2026, 6, d));
    }
    const listing = listSnapshots(backupsDir, 2);
    expect(listing.snapshots.map((s) => s.name)).toEqual([
      "daily-2026-07-05.db",
      "daily-2026-07-04.db",
    ]);
    expect(listing.totalFiles).toBe(5);
  });

  test("no archive yet is an empty listing, not a throw", () => {
    const listing = listSnapshots(path.join(dir, "never-created"));
    expect(listing).toEqual({
      snapshots: [],
      totalFiles: 0,
      sidecarFiles: 0,
      ungovernedFiles: 0,
      totalBytes: 0,
    });
  });

  test("a rewritten file is re-read, not served from the memo", () => {
    const full = writeSnapshot("daily-2026-07-28.db", Date.UTC(2026, 6, 28));
    expect(listSnapshots(backupsDir).snapshots[0]!.state!.transactions).toBe(0);

    // replace it with a different ledger and give it a new mtime, as a rename would
    fs.rmSync(full);
    writeSnapshot("daily-2026-07-28.db", Date.UTC(2026, 6, 29), 3);

    expect(listSnapshots(backupsDir).snapshots[0]!.state!.transactions).toBe(3);
  });
});

describe("resolveSnapshotPath", () => {
  test("resolves a plain name inside the archive", () => {
    expect(resolveSnapshotPath("/tmp/backups", "daily-2026-07-28.db")).toBe(
      path.resolve("/tmp/backups/daily-2026-07-28.db"),
    );
  });

  test("refuses anything that reaches outside the archive", () => {
    for (const name of [
      "../moneyapp.db",
      "../../etc/passwd.db",
      "nested/daily.db",
      "/etc/hosts.db",
      "",
      ".",
    ]) {
      expect(() => resolveSnapshotPath("/tmp/backups", name)).toThrow();
    }
  });

  test("refuses a name that is not a snapshot file", () => {
    expect(() => resolveSnapshotPath("/tmp/backups", "notes.txt")).toThrow(/\.db/);
  });
});

describe("manualSnapshot", () => {
  test("writes a restore point on demand, in the same rotated namespace", () => {
    const result = manualSnapshot(writer);
    expect(result.status).toBe("created");
    expect(path.basename(result.path!)).toMatch(/^pre-\d{4}-\d{2}-\d{2}T\d{6}-manual-backup\.db$/);
    // beside the database it protects, so it rotates with the automatic ones
    expect(path.dirname(result.path!)).toBe(path.join(dir, "backups"));
  });
});

describe("restoreFromSnapshot", () => {
  let appDir: string;
  let dataDir: string;
  let livePath: string;
  let bundle: DbBundle;
  const opened: DbBundle[] = [];

  function open(p: string): DbBundle {
    const b = createDatabase(p);
    opened.push(b);
    return b;
  }

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-restore-"));
    dataDir = path.join(appDir, "data");
    livePath = path.join(dataDir, "moneyapp.db");
    bundle = open(livePath);
    bundle.sqlite.exec("CREATE TABLE t (v TEXT)");
    clearSnapshotStateCache();
  });

  afterEach(() => {
    for (const b of opened.splice(0)) {
      try {
        b.sqlite.close();
      } catch {
        // restore closes the one it replaced
      }
    }
    fs.rmSync(appDir, { recursive: true, force: true });
    clearSnapshotStateCache();
  });

  const archive = () => path.join(dataDir, "backups");
  const rows = (b: DbBundle) =>
    (b.sqlite.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c;

  test("puts the snapshot's ledger back and hands over a working connection", () => {
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('kept')").run();
    const snapshot = preMutationSnapshot(bundle.sqlite, archive(), "checkpoint", NOW).path!;
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('undone')").run();
    expect(rows(bundle)).toBe(2);

    const result = restoreFromSnapshot(bundle, snapshot);
    opened.push(result.reopened);

    expect(result.restoredFrom).toBe(path.basename(snapshot));
    expect(rows(result.reopened)).toBe(1);
    expect(result.reopened.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  test("restoring is itself undoable: the state it replaced is snapshotted first", () => {
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('a')").run();
    const snapshot = preMutationSnapshot(bundle.sqlite, archive(), "checkpoint", NOW).path!;
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('b')").run();

    const result = restoreFromSnapshot(bundle, snapshot);
    opened.push(result.reopened);

    expect(path.basename(result.preRestorePath!)).toMatch(/^pre-.*-restore\.db$/);
    const before = new Database(result.preRestorePath!, { readonly: true });
    // the pre-restore point holds the state as it was a moment earlier
    expect((before.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c).toBe(2);
    before.close();
  });

  test("an older snapshot is carried forward by the migrations that ran since", () => {
    // a snapshot taken before the app schema existed at all
    const bare = path.join(dataDir, "bare.db");
    const sq = new Database(bare);
    sq.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ancient')");
    sq.close();

    const result = restoreFromSnapshot(bundle, bare);
    opened.push(result.reopened);

    expect(rows(result.reopened)).toBe(1);
    // migrate() ran on reopen — the current schema is present over the old data
    const tables = result.reopened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("a snapshot's uncheckpointed -wal is restored with it, not silently dropped", () => {
    const hot = path.join(dataDir, "hot.db");
    const sq = new Database(hot);
    sq.pragma("journal_mode = WAL");
    sq.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one'), ('two'), ('three')");
    // copy while still open, so the rows live in the -wal and not in the .db
    fs.copyFileSync(hot, `${hot}.copy`);
    fs.copyFileSync(`${hot}-wal`, `${hot}.copy-wal`);
    sq.close();

    const result = restoreFromSnapshot(bundle, `${hot}.copy`);
    opened.push(result.reopened);
    expect(rows(result.reopened)).toBe(3);
  });

  test("a corrupt snapshot changes nothing and leaves no staged file behind", () => {
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('safe')").run();
    const junk = path.join(dataDir, "junk.db");
    fs.writeFileSync(junk, "not a database at all");

    expect(() => restoreFromSnapshot(bundle, junk)).toThrow(/nothing was changed/i);
    expect(rows(bundle)).toBe(1); // the live connection is still open and correct
    expect(fs.readdirSync(dataDir).filter((f) => f.includes(".restore-"))).toEqual([]);
  });

  test("a snapshot that is not there is refused before anything moves", () => {
    expect(() => restoreFromSnapshot(bundle, path.join(archive(), "daily-1999-01-01.db"))).toThrow(
      /No snapshot named/,
    );
    expect(rows(bundle)).toBe(0);
  });

  test("the live database is not a snapshot of itself", () => {
    expect(() => restoreFromSnapshot(bundle, livePath)).toThrow(/live database/);
    expect(rows(bundle)).toBe(0);
  });

  test("an in-memory database has no file to replace", () => {
    const memory = open(":memory:");
    expect(() => restoreFromSnapshot(memory, livePath)).toThrow(/no file to replace/);
  });

  test("the replaced database is left self-contained — no stale -wal or -shm", () => {
    bundle.sqlite.pragma("journal_mode = WAL");
    bundle.sqlite.prepare("INSERT INTO t (v) VALUES ('a')").run();
    const snapshot = preMutationSnapshot(bundle.sqlite, archive(), "checkpoint", NOW).path!;

    const result = restoreFromSnapshot(bundle, snapshot);
    result.reopened.sqlite.close();

    // reopening leaves its own -wal; what must never survive is one belonging
    // to the file that was replaced, so check with nothing attached
    expect(fs.existsSync(`${livePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${livePath}-shm`)).toBe(false);
    expect(fs.readdirSync(dataDir).filter((f) => f.includes(".restore-"))).toEqual([]);
  });

  test("the connection cache is swapped, so nothing later hands out the dead handle", () => {
    const cache = globalThis as { __moneyappDb?: DbBundle };
    const previous = cache.__moneyappDb;
    cache.__moneyappDb = bundle;
    try {
      const snapshot = preMutationSnapshot(bundle.sqlite, archive(), "checkpoint", NOW).path!;
      const result = restoreFromSnapshot(bundle, snapshot);
      opened.push(result.reopened);
      expect(cache.__moneyappDb).toBe(result.reopened);
      expect(cache.__moneyappDb).not.toBe(bundle);
    } finally {
      if (previous === undefined) delete cache.__moneyappDb;
      else cache.__moneyappDb = previous;
    }
  });

  test("a bundle that is not the cached one leaves the cache alone", () => {
    const cache = globalThis as { __moneyappDb?: DbBundle };
    const previous = cache.__moneyappDb;
    const sentinel = { sqlite: null, db: null } as unknown as DbBundle;
    cache.__moneyappDb = sentinel;
    try {
      const snapshot = preMutationSnapshot(bundle.sqlite, archive(), "checkpoint", NOW).path!;
      opened.push(restoreFromSnapshot(bundle, snapshot).reopened);
      expect(cache.__moneyappDb).toBe(sentinel);
    } finally {
      if (previous === undefined) delete cache.__moneyappDb;
      else cache.__moneyappDb = previous;
    }
  });
});
