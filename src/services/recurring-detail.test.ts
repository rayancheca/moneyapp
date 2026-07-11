import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import { isNull } from "drizzle-orm";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { detectRecurringSeries } from "./recurring";
import {
  renameSeries,
  searchAttachCandidates,
  seriesDetail,
  setSeriesOverrides,
} from "./recurring-detail";
import { attachTransactions } from "./recurring-links";

const TODAY = "2026-07-08";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

let dir: string;
let bundle: DbBundle;
let cardId: string;
let netflixId: string;
let subsCatId: string;
let seq = 0;

function insertTxn(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId?: string | null;
  categoryId?: string | null;
}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      merchantId: opts.merchantId ?? null,
      categoryId: opts.categoryId ?? null,
      dedupeHash: dedupeHash({
        accountId: cardId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function buildMonthlyNetflix(): void {
  for (const m of MONTHS) {
    insertTxn({
      postedOn: `${m}-15`,
      amountCents: -1549,
      rawDescription: "NETFLIX.COM",
      merchantId: netflixId,
      categoryId: subsCatId,
    });
  }
}

function netflix() {
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, netflixId)).get()!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-recdetail-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
  subsCatId = bundle.db.select().from(categories).where(eq(categories.name, "Subscriptions")).get()!.id;
  seq = 0;
  buildMonthlyNetflix();
  detectRecurringSeries(bundle.db, TODAY);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("seriesDetail", () => {
  test("closes the chain: merchant, modal category, account, and linked history", () => {
    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.merchant).toMatchObject({ name: "Netflix" });
    expect(d.category).toMatchObject({ name: "Subscriptions" });
    expect(d.accountName).toBe("Card");
    expect(d.kind).toBe("subscription");
    expect(d.linkedTxns).toHaveLength(6);
    // newest first
    expect(d.linkedTxns[0]!.postedOn).toBe("2026-06-15");
    expect(d.linkedTxns.at(-1)!.postedOn).toBe("2026-01-15");
    // amount history is the same rows oldest → newest, for the drift chart
    expect(d.amountHistory[0]!.date).toBe("2026-01-15");
    expect(d.amountHistory.at(-1)!.date).toBe("2026-06-15");
    expect(d.linkedTxns.every((t) => t.linkSource === "detected")).toBe(true);
  });

  test("reports the detected statistics and next 3 expected occurrences", () => {
    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.cadence).toBe("monthly");
    expect(d.annualizedCents).toBe(1549 * 12);
    expect(d.isActive).toBe(true);
    expect(d.nextExpected).toHaveLength(3);
    expect(d.nextExpected[0]!.date).toBe("2026-07-16");
    expect(d.nextExpected.every((o) => o.amountCents === -1549)).toBe(true);
  });

  test("throws on an unknown series", () => {
    expect(() => seriesDetail(bundle.db, "nope", TODAY)).toThrow(/Unknown recurring series/);
  });

  test("a long-interval annual series still returns 3 next-expected occurrences", () => {
    // 3 identical charges 378 days apart → annual, step 378. The old fixed
    // horizon (3*366+30=1128) dropped the 3rd (at +1134); size off step instead.
    for (const d of [addDays(TODAY, -756), addDays(TODAY, -378), TODAY]) {
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "ANNUAL FEE" });
    }
    detectRecurringSeries(bundle.db, TODAY);
    const annual = bundle.db.select().from(recurringSeries).where(isNull(recurringSeries.merchantId)).get()!;
    expect(annual.cadence).toBe("annual");
    expect(seriesDetail(bundle.db, annual.id, TODAY).nextExpected).toHaveLength(3);
  });

  test("effective values follow user overrides; merge candidates exclude self", () => {
    const id = netflix().id;
    setSeriesOverrides(bundle.db, id, { userCadence: "weekly", userAmountCents: -2000 });
    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.cadence).toBe("weekly");
    expect(d.nextExpectedAmountCents).toBe(-2000);
    expect(d.userCadence).toBe("weekly");
    expect(d.detectedCadence).toBe("monthly"); // detection column untouched
    expect(d.mergeCandidates.every((c) => c.id !== id)).toBe(true);
  });
});

describe("setSeriesOverrides / renameSeries", () => {
  test("clears an override with null", () => {
    const id = netflix().id;
    setSeriesOverrides(bundle.db, id, { userCadence: "weekly" });
    expect(seriesDetail(bundle.db, id, TODAY).cadence).toBe("weekly");
    setSeriesOverrides(bundle.db, id, { userCadence: null });
    expect(seriesDetail(bundle.db, id, TODAY).cadence).toBe("monthly");
  });

  test("a no-op patch and unknown-id are handled", () => {
    const id = netflix().id;
    expect(() => setSeriesOverrides(bundle.db, id, {})).not.toThrow();
    expect(() => setSeriesOverrides(bundle.db, "nope", { userAmountCents: 1 })).toThrow(
      /Unknown recurring series/,
    );
  });

  test("rejects a calendar-invalid next-expected date (would poison every projection)", () => {
    const id = netflix().id;
    expect(() => setSeriesOverrides(bundle.db, id, { userNextExpectedOn: "2026-02-31" })).toThrow(
      /Invalid next-expected date/,
    );
    // and the poison never landed — the series still projects fine
    expect(() => seriesDetail(bundle.db, id, TODAY)).not.toThrow();
    expect(seriesDetail(bundle.db, id, TODAY).nextExpectedOn).not.toBe("2026-02-31");
  });

  test("renames, trimming; rejects empty and unknown", () => {
    const id = netflix().id;
    expect(renameSeries(bundle.db, id, "  Netflix Premium  ")).toBe("Netflix Premium");
    expect(seriesDetail(bundle.db, id, TODAY).name).toBe("Netflix Premium");
    expect(() => renameSeries(bundle.db, id, "   ")).toThrow(/cannot be empty/);
    expect(() => renameSeries(bundle.db, "nope", "X")).toThrow(/Unknown recurring series/);
  });
});

describe("searchAttachCandidates", () => {
  test("a text query matches unlinked, non-future rows by description", () => {
    const rented = insertTxn({ postedOn: "2026-05-20", amountCents: -1549, rawDescription: "NETFLIX RENTAL" });
    insertTxn({ postedOn: "2026-08-01", amountCents: -1549, rawDescription: "NETFLIX FUTURE" }); // future → excluded
    const results = searchAttachCandidates(bundle.db, netflix().id, "NETFLIX", TODAY);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(rented);
    // the six linked charges are already tagged → never candidates
    expect(results.every((r) => r.description.includes("NETFLIX") || r.description.includes("Netflix"))).toBe(true);
    expect(results.some((r) => r.postedOn > TODAY)).toBe(false);
  });

  test("an empty query falls back to an amount window around the expected charge", () => {
    const near = insertTxn({ postedOn: "2026-05-21", amountCents: -1500, rawDescription: "SOME SUB" });
    const far = insertTxn({ postedOn: "2026-05-22", amountCents: -9999, rawDescription: "BIG SPEND" });
    const results = searchAttachCandidates(bundle.db, netflix().id, "", TODAY);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
  });

  test("throws on an unknown series", () => {
    expect(() => searchAttachCandidates(bundle.db, "nope", "x", TODAY)).toThrow(/Unknown recurring series/);
  });

  test("rows already linked to a series are never candidates", () => {
    const loose = insertTxn({ postedOn: "2026-05-23", amountCents: -1549, rawDescription: "NETFLIX EXTRA" });
    attachTransactions(bundle.db, netflix().id, [loose], TODAY);
    const results = searchAttachCandidates(bundle.db, netflix().id, "NETFLIX", TODAY);
    expect(results.map((r) => r.id)).not.toContain(loose);
  });
});
