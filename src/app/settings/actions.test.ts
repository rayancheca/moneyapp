import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The settings form action against a real (temporary) database. The interesting
 * branch is `Number("abc")` → NaN: it used to fail a throwing `.parse()`, which
 * Next turns into an error digest that replaces the whole Settings page.
 */

const redirects = vi.hoisted(() => [] as string[]);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-settings-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// the backup actions WRITE — point the archive at this temp dir so a test can
// never add to (or rotate) the owner's real one
process.env.MONEYAPP_BACKUPS_DIR = path.join(dir, "backups");
// the connection is cached on globalThis — drop any inherited handle so this
// file can never write another file's (or the owner's real) database
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDb, getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { readSettings } = await import("@/services/settings");
const { writeSetting } = await import("@/services/settings");
const {
  backUpNowAction,
  downloadSnapshotAction,
  restoreSnapshotAction,
  updateSettingsAction,
  updateSettingsResultAction,
} = await import("./actions");

beforeAll(() => {
  seedDatabase(getDbBundle().db);
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
  delete process.env.MONEYAPP_BACKUPS_DIR;
});

const VALID = {
  aiMonthlyCapUsd: "25",
  priceStalenessHours: "12",
  reviewCreditThresholdUsd: "10",
  categorizationConfidenceMin: "0.7",
};

function form(overrides: Partial<typeof VALID> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...VALID, ...overrides })) fd.set(k, v);
  return fd;
}

describe("updateSettingsResultAction", () => {
  test("writes every setting and echoes the parsed values", async () => {
    const result = await updateSettingsResultAction(form());
    expect(result).toEqual({
      ok: true,
      data: {
        aiMonthlyCapUsd: 25,
        priceStalenessHours: 12,
        reviewCreditThresholdCents: 1_000,
        categorizationConfidenceMin: 0.7,
      },
    });
    const saved = readSettings(getDbBundle().db);
    expect(saved.aiMonthlyCapUsd).toBe(25);
    expect(saved.reviewCreditThresholdCents).toBe(1_000);
  });

  test("a non-numeric threshold reports the field instead of throwing", async () => {
    const result = await updateSettingsResultAction(form({ reviewCreditThresholdUsd: "abc" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Review credit threshold: /);
  });

  test("a non-numeric threshold does NOT silently write zero", async () => {
    const before = readSettings(getDbBundle().db).reviewCreditThresholdCents;
    await updateSettingsResultAction(form({ reviewCreditThresholdUsd: "abc" }));
    expect(readSettings(getDbBundle().db).reviewCreditThresholdCents).toBe(before);
  });

  test("an out-of-range confidence names its field", async () => {
    const result = await updateSettingsResultAction(form({ categorizationConfidenceMin: "5" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Minimum categorization confidence: /);
  });

  test("a zero staleness window is rejected (the schema floor is 1 hour)", async () => {
    const result = await updateSettingsResultAction(form({ priceStalenessHours: "0" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Price staleness window: /);
  });
});

describe("updateSettingsAction (the <form action> adapter)", () => {
  test("a bad value redirects to /settings?error= instead of a 500", async () => {
    redirects.length = 0;
    await expect(updateSettingsAction(form({ aiMonthlyCapUsd: "nope" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    const url = new URL(redirects[0]!, "http://localhost");
    expect(url.pathname).toBe("/settings");
    expect(url.searchParams.get("error")).toMatch(/^Monthly AI cap: /);
  });

  test("a valid submission does not redirect at all", async () => {
    redirects.length = 0;
    await expect(updateSettingsAction(form())).resolves.toBeUndefined();
    expect(redirects).toEqual([]);
  });
});

/**
 * The backup actions against the same real (temporary) database. The one that
 * matters is restore: it closes the connection the whole app shares, so these
 * assert through getDb() rather than through the returned handle — a restore
 * that leaves the cached connection pointing at the replaced file would pass
 * every direct assertion and brick the running app.
 */
describe("backUpNowAction", () => {
  test("writes a restore point on demand and names the file", async () => {
    const result = await backUpNowAction();
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.name).toMatch(
      /^pre-\d{4}-\d{2}-\d{2}T\d{6}-manual-backup\.db$/,
    );
    expect(fs.existsSync(path.join(dir, "backups", (result as { data: { name: string } }).data.name))).toBe(
      true,
    );
  });
});

describe("restoreSnapshotAction", () => {
  /** Takes a snapshot of the current state and returns its file name. */
  async function snapshotNow(): Promise<string> {
    const result = await backUpNowAction();
    if (!result.ok || result.data.name === null) throw new Error("could not take a snapshot");
    return result.data.name;
  }

  test("the typed word is re-checked on the server, not just in the dialog", async () => {
    const name = await snapshotNow();
    writeSetting(getDbBundle().db, "priceStalenessHours", 99);

    const result = await restoreSnapshotAction({ name, confirmation: "yes" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/confirmation word/);
    // and the ledger is untouched
    expect(readSettings(getDbBundle().db).priceStalenessHours).toBe(99);
  });

  test("a name that reaches outside the archive is refused", async () => {
    for (const name of ["../t.db", "/etc/hosts.db", "nested/x.db"]) {
      const result = await restoreSnapshotAction({ name, confirmation: "RESTORE" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/backups folder|snapshot/i);
    }
  });

  test("restores the state, and the app's OWN connection sees it", async () => {
    writeSetting(getDbBundle().db, "priceStalenessHours", 6);
    const name = await snapshotNow();
    writeSetting(getDbBundle().db, "priceStalenessHours", 48);
    expect(readSettings(getDb()).priceStalenessHours).toBe(48);

    const result = await restoreSnapshotAction({ name, confirmation: "restore" });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.restoredFrom).toBe(name);
    // getDb() is what every page calls: it must hand back the RESTORED database
    expect(readSettings(getDb()).priceStalenessHours).toBe(6);
  });

  test("the state it replaced is saved first, so the restore is reversible", async () => {
    writeSetting(getDb(), "priceStalenessHours", 12);
    const name = await snapshotNow();
    writeSetting(getDb(), "priceStalenessHours", 36);

    const result = await restoreSnapshotAction({ name, confirmation: "RESTORE" });
    expect(result.ok).toBe(true);
    const preRestoreName = result.ok === true ? result.data.preRestoreName : null;
    // -2 when a second restore lands in the same second: both points are kept
    expect(preRestoreName).toMatch(/^pre-.*-restore(-\d+)?\.db$/);

    // walking the restore back returns the 36
    const back = await restoreSnapshotAction({ name: preRestoreName!, confirmation: "RESTORE" });
    expect(back.ok).toBe(true);
    expect(readSettings(getDb()).priceStalenessHours).toBe(36);
  });

  test("a snapshot that is not in the archive reports it instead of throwing", async () => {
    const result = await restoreSnapshotAction({
      name: "daily-1999-01-01.db",
      confirmation: "RESTORE",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/No snapshot named/);
  });
});

describe("downloadSnapshotAction", () => {
  test("hands back the file's exact bytes", async () => {
    const created = await backUpNowAction();
    const name = created.ok === true ? created.data.name! : "";

    const result = await downloadSnapshotAction(name);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filename).toBe(name);
    const onDisk = fs.readFileSync(path.join(dir, "backups", name));
    expect(Buffer.from(result.data.base64, "base64").equals(onDisk)).toBe(true);
    expect(result.data.sizeBytes).toBe(onDisk.byteLength);
  });

  test("refuses a name that reaches outside the archive", async () => {
    const result = await downloadSnapshotAction("../t.db");
    expect(result.ok).toBe(false);
  });
});
