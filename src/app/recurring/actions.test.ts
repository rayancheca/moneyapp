import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The series-page membership actions against a real (temporary) database — what each one tells Next to refresh.
 *
 * ⚖️ Owner decision 2026-10-08 (§6A 54): merging a series in files its rows not filed yet under the target's category,
 * as attaching one does (§6A 47). A merge is a filing write, so it refreshes every page attaching refreshes.
 * 🔴 It refreshed the two series pages and /recurring only: the attach and "Make recurring" actions revalidate
 * /transactions because they file rows, and the merge was left out when it began to (review of §6A 54, 2026-10-08).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// getDb() reads MONEYAPP_DB_PATH lazily on first call, so pointing it at a temp
// file before any action runs keeps the owner's real database untouched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-recurring-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// the connection is cached on globalThis — drop any inherited handle so this file can never write another database
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { revalidatePath } = await import("next/cache");
const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { transactions } = await import("@/db/schema/transactions");
const { recurringSeries } = await import("@/db/schema/recurring");
const { MERGE_FILING_CHANGED, mergeFilings } = await import("@/services/recurring-links");
const { seedHisCarSeries } = await import("@/services/one-charge-fixture");
const {
  attachToSeriesAction,
  confirmSeriesAction,
  detectNowAction,
  dismissSeriesAction,
  mergeIntoSeriesAction,
} = await import("./actions");
const { refusalShownFields } = await import("@/components/ui/ErrorBanner");

type Ledger = ReturnType<typeof seedHisCarSeries>;
let his: Ledger;

beforeAll(() => {
  const { db } = getDbBundle();
  seedDatabase(db);
  his = seedHisCarSeries(db);
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
});

/** A row on his Checking not filed yet, linked to `seriesId` (null: to none) — its id. */
function unfiledCharge(postedOn: string, amountCents: number, seriesId: string | null): string {
  const id = his.charge(postedOn, amountCents, seriesId);
  getDbBundle().db.update(transactions).set({ categoryId: null }).where(eq(transactions.id, id)).run();
  return id;
}

/** The paths an action asked Next to refresh. */
async function refreshedBy(act: () => Promise<{ ok: boolean }>): Promise<string[]> {
  vi.mocked(revalidatePath).mockClear();
  const result = await act();
  expect(result.ok).toBe(true);
  return vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
}

describe("mergeIntoSeriesAction", () => {
  test("a merge that files rows refreshes /transactions — every page attaching refreshes", async () => {
    const attached = unfiledCharge("2026-10-01", -35758, null);
    const attachPaths = await refreshedBy(() =>
      attachToSeriesAction({ seriesId: his.insuranceId, transactionIds: [attached] }),
    );
    expect(attachPaths).toContain("/transactions");

    // the Nov 11 balance carries a row not filed yet; merged into Car insurance, it is filed under Transport
    unfiledCharge("2026-10-02", -7274, his.balanceId);
    const shown = mergeFilings(getDbBundle().db, his.insuranceId, [his.balanceId]).get(his.balanceId) ?? null;
    let filed: number | undefined;
    const mergePaths = await refreshedBy(async () => {
      const r = await mergeIntoSeriesAction({ sourceId: his.balanceId, targetId: his.insuranceId, shown });
      filed = r.ok ? r.data.filed?.count : undefined;
      return r;
    });
    expect(filed).toBe(1);
    expect(mergePaths).toEqual(expect.arrayContaining(attachPaths));
    expect(mergePaths).toContain(`/recurring/${his.balanceId}`);
  });
});

/*
 * ⚖️ §6A 54 (2026-10-08): the confirmation names what the merge files before he presses. 🔴 Review of §6A 54: it was
 * read when the page rendered and the merge re-read when he pressed, and nothing checked they still agreed. The press
 * now carries what the confirmation showed, and the merge refuses anything else in words he can act on.
 */
describe("mergeIntoSeriesAction — the press carries what the confirmation showed", () => {
  test("a merge that would file other than he read is refused, plainly, and nothing moves", async () => {
    const { db } = getDbBundle();
    const source = db
      .insert(recurringSeries)
      .values({ name: "PROGRESSIVE — a second schedule", kind: "bill", cadence: "monthly", status: "detected" })
      .returning({ id: recurringSeries.id })
      .get().id;
    const row = unfiledCharge("2026-10-03", -7274, source);
    const shown = mergeFilings(db, his.insuranceId, [source]).get(source) ?? null;
    expect(shown?.count).toBe(1);
    // filed by hand in another tab after the confirmation was read
    db.update(transactions).set({ categoryId: shown!.categoryId }).where(eq(transactions.id, row)).run();

    const r = await mergeIntoSeriesAction({ sourceId: source, targetId: his.insuranceId, shown });

    expect(r).toEqual({ ok: false, error: MERGE_FILING_CHANGED });
    expect(MERGE_FILING_CHANGED).toBe(
      "Nothing was merged — what it would file has changed since you opened it. Read it again before you merge.",
    );
    expect(db.select().from(transactions).where(eq(transactions.id, row)).get()!.recurringSeriesId).toBe(source);
  });
});

/*
 * 🔴 Review of §6A 54 (2026-10-08): the merge's toast names what it filed; attaching — the same rule, §6A 47 — said only
 * "1 attached". The action now hands back what it filed, for its toast to name.
 */
describe("attachToSeriesAction — what it filed comes back with it", () => {
  test("a row not filed yet, attached to Car insurance, comes back as filed under its category", async () => {
    const row = unfiledCharge("2026-10-04", -35758, null);

    const r = await attachToSeriesAction({ seriesId: his.insuranceId, transactionIds: [row] });

    expect(r.ok && r.data.attached).toBe(1);
    expect(r.ok && r.data.filed?.count).toBe(1);
    expect(r.ok && r.data.filed?.categoryPath).toBe("Transport");
  });
});

/*
 * 🔴 The review of 425ae02c (2026-11-05): /recurring's three forms — Detect now, and a suggestion's Confirm and Not
 * recurring — returned on a success, so a refusal's `?error=` outlived the next press that landed, as it had on
 * /imports. Each, landing while the page shows a refusal, goes back to /recurring with none (`landBack`).
 */
describe("/recurring's form adapters land back on it — with the refusal, or without one", () => {
  const shown = (form: FormData = new FormData()): FormData => {
    for (const [name, value] of Object.entries(refusalShownFields("Detection failed"))) form.set(name, value);
    return form;
  };
  const series = (seriesId: string): FormData => {
    const form = new FormData();
    form.set("seriesId", seriesId);
    return form;
  };

  test("Detect now, landing while a refusal shows, goes back to /recurring with none", async () => {
    await expect(detectNowAction(shown())).rejects.toThrow(/^NEXT_REDIRECT:\/recurring$/);
  });

  test("…and with none showing it stays where it is", async () => {
    await expect(detectNowAction(new FormData())).resolves.toBeUndefined();
  });

  test("a suggestion confirmed or dismissed while a refusal shows goes back with none", async () => {
    await expect(confirmSeriesAction(shown(series(his.insuranceId)))).rejects.toThrow(/^NEXT_REDIRECT:\/recurring$/);
    await expect(dismissSeriesAction(shown(series(his.balanceId)))).rejects.toThrow(/^NEXT_REDIRECT:\/recurring$/);
  });

  test("a refusal still lands on `?error=`", async () => {
    await expect(confirmSeriesAction(new FormData())).rejects.toThrow(/^NEXT_REDIRECT:\/recurring\?error=/);
  });
});
