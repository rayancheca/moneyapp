import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, type SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, SERIES_STATUSES, type SeriesStatus } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { seriesDrawsAsRecurring } from "@/lib/series-evidence";
import { createAccount } from "./accounts";
import { linkIsNotRecurring, linkIsRecurring, rowIsRecurring, seriesIdsNotDrawnAsRecurring } from "./recurring-link";

let dir: string;
let bundle: DbBundle;
let accountId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reclink-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  accountId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addSeries(status: SeriesStatus): string {
  return bundle.db
    .insert(recurringSeries)
    .values({ name: `Series ${status}`, kind: "bill", cadence: "monthly", status })
    .returning({ id: recurringSeries.id })
    .get().id;
}

function addRow(recurringSeriesId: string | null): string {
  seq += 1;
  const rawDescription = `ROW ${seq}`;
  const amountCents = -1000 * seq;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: "2026-07-01",
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      recurringSeriesId,
      dedupeHash: dedupeHash({ accountId, postedOn: "2026-07-01", amountCents, rawDescription, occurrenceIndex: 0 }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function idsWhere(condition: SQL): Set<string> {
  return new Set(
    bundle.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(condition)
      .all()
      .map((r) => r.id),
  );
}

describe("recurring-link — a row's LINK is recurring only when its series is drawn as recurring", () => {
  test("the not-recurring set is exactly the series `seriesDrawsAsRecurring` refuses", () => {
    const byStatus = SERIES_STATUSES.map((status) => ({ status, id: addSeries(status) }));
    const notDrawn = seriesIdsNotDrawnAsRecurring(bundle.db);
    for (const { status, id } of byStatus) expect(notDrawn.has(id)).toBe(!seriesDrawsAsRecurring(status));
    // the owner's rule, stated: dismissed is the one status that is not recurring
    expect(byStatus.filter(({ id }) => notDrawn.has(id)).map((s) => s.status)).toEqual(["dismissed"]);
  });

  /*
   * ⛔ The two SQL forms are written separately — `and(isNotNull, notInArray)` and
   * `or(isNull, inArray)` — and they must be exact complements, or a surface that
   * adds "recurring" to "not recurring" loses or doubles a row. SQL's NULL makes
   * that easy to get wrong: `NOT IN` on a NULL link is neither true nor false.
   */
  test("the two SQL forms partition every row, and agree with the in-memory form", () => {
    const rows = [
      { id: addRow(null), seriesId: null as string | null },
      ...SERIES_STATUSES.map((status) => {
        const seriesId = addSeries(status);
        return { id: addRow(seriesId), seriesId: seriesId as string | null };
      }),
    ];
    const notDrawn = seriesIdsNotDrawnAsRecurring(bundle.db);
    const recurring = idsWhere(linkIsRecurring(notDrawn));
    const notRecurring = idsWhere(linkIsNotRecurring(notDrawn));

    for (const row of rows) {
      expect(recurring.has(row.id)).toBe(rowIsRecurring(row.seriesId, notDrawn));
      expect(notRecurring.has(row.id)).toBe(!rowIsRecurring(row.seriesId, notDrawn));
    }
    // detected, confirmed and ended rows are recurring; the unlinked and the dismissed are not
    expect(rows.filter((r) => recurring.has(r.id))).toHaveLength(3);
    expect(rows.filter((r) => notRecurring.has(r.id))).toHaveLength(2);
  });

  test("with nothing dismissed, the forms are the bare link", () => {
    const linked = addRow(addSeries("confirmed"));
    const unlinked = addRow(null);
    const notDrawn = seriesIdsNotDrawnAsRecurring(bundle.db);
    expect(notDrawn.size).toBe(0);
    expect(idsWhere(linkIsRecurring(notDrawn)).has(linked)).toBe(true);
    expect(idsWhere(linkIsRecurring(notDrawn)).has(unlinked)).toBe(false);
    expect(idsWhere(linkIsNotRecurring(notDrawn)).has(unlinked)).toBe(true);
    expect(idsWhere(linkIsNotRecurring(notDrawn)).has(linked)).toBe(false);
  });
});
