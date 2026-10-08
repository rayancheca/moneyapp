import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * The transaction sheet's "Link to a recurring series" list, from the action the sheet calls, against a real
 * (temporary) database.
 *
 * getDb() reads MONEYAPP_DB_PATH lazily on first call, so pointing it at a temp file before the action runs keeps the
 * owner's real database untouched; the connection is cached on globalThis, so any inherited handle is dropped first.
 * The action reads its day off the clock (`todayIso`), so the day is pinned where every other surface here pins it.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-sheet-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
process.env.MONEYAPP_FAKE_TODAY = "2026-10-08";
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { seedHisCarSeries } = await import("@/services/one-charge-fixture");
const { loadSeriesLinkPanel } = await import("./sheet-actions");

let unlinkedId: string;

beforeAll(() => {
  const { db } = getDbBundle();
  seedDatabase(db);
  const his = seedHisCarSeries(db);
  // a charge linked to no series yet — the row whose sheet offers the list
  unlinkedId = his.charge("2026-10-01", -2500, null);
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
  delete process.env.MONEYAPP_FAKE_TODAY;
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads "once · Nov 11" wherever a
 * cadence prints — here, each candidate's line under its name — and Car insurance, a monthly bill in its last months,
 * reads "monthly". 🔴 Review of 3044ea6 put this line back on the stored cadence ("monthly · ~$72.74") with every test
 * still green: nothing called the action.
 */
describe("loadSeriesLinkPanel — a schedule of one charge is offered as once, on its day", () => {
  test("the balance reads 'once · Nov 11 · ~$72.74', Car insurance 'monthly · ~$357.58'", async () => {
    const result = await loadSeriesLinkPanel(unlinkedId);
    if (!result.ok) throw new Error(result.error);
    const detailOf = (name: string): string | undefined => result.data.candidates.find((c) => c.name === name)?.detail;
    expect(detailOf("Car insurance — Nov 11 balance after the $1,000 early payment")).toBe("once · Nov 11 · ~$72.74");
    expect(detailOf("Car insurance")).toBe("monthly · ~$357.58");
  });
});
