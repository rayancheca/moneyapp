import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import {
  detectRecurringSeries,
  effectiveSeries,
  isSeriesActive,
  projectOccurrences,
  setSeriesStatus,
  toProjectable,
  type SeriesOverrides,
} from "./recurring";
import { attachTransactions, detachTransaction, mergeSeries } from "./recurring-links";

const TODAY = "2026-07-08";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

let dir: string;
let bundle: DbBundle;
let cardId: string;
let netflixId: string;
let spotifyId: string;
let seq = 0;

function insertTxn(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId?: string | null;
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

/** Two clean monthly merchant series so grouping is deterministic. */
function buildTwoMonthlySeries(): void {
  for (const m of MONTHS) {
    insertTxn({ postedOn: `${m}-15`, amountCents: -1549, rawDescription: "NETFLIX.COM", merchantId: netflixId });
    insertTxn({ postedOn: `${m}-05`, amountCents: -999, rawDescription: "SPOTIFY USA", merchantId: spotifyId });
  }
}

function seriesFor(merchantId: string) {
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, merchantId)).get()!;
}

/** The link + stat state the "detection changes nothing" invariant protects. */
function snapshot() {
  const series = bundle.db
    .select({
      id: recurringSeries.id,
      status: recurringSeries.status,
      cadence: recurringSeries.cadence,
      amountCentsAvg: recurringSeries.amountCentsAvg,
      nextExpectedOn: recurringSeries.nextExpectedOn,
      nextExpectedAmountCents: recurringSeries.nextExpectedAmountCents,
      lastMatchedOn: recurringSeries.lastMatchedOn,
      mergedIntoId: recurringSeries.mergedIntoId,
    })
    .from(recurringSeries)
    .orderBy(asc(recurringSeries.id))
    .all();
  const txns = bundle.db
    .select({
      id: transactions.id,
      recurringSeriesId: transactions.recurringSeriesId,
      seriesLinkSource: transactions.seriesLinkSource,
    })
    .from(transactions)
    .orderBy(asc(transactions.id))
    .all();
  return { series, txns };
}

function taggedIds(seriesId: string): string[] {
  return bundle.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.recurringSeriesId, seriesId))
    .all()
    .map((r) => r.id)
    .sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reclinks-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
  spotifyId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Spotify")).get()!.id;
  seq = 0;
  buildTwoMonthlySeries();
  detectRecurringSeries(bundle.db, TODAY);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("detection respects user decisions (§4.3): a re-run changes nothing", () => {
  test("baseline: two monthly series, six rows each, all detection-owned", () => {
    const netflix = seriesFor(netflixId);
    expect(netflix.cadence).toBe("monthly");
    expect(taggedIds(netflix.id)).toHaveLength(6);
    const before = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(before); // idempotent with no user action
  });

  test("UNLINK: a detached row stays unlinked; re-detection never re-tags it", () => {
    const netflix = seriesFor(netflixId);
    const target = taggedIds(netflix.id).sort()[0]!;

    const former = detachTransaction(bundle.db, target, TODAY);
    expect(former).toBe(netflix.id);
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, target)).get()!;
    expect(row.recurringSeriesId).toBeNull();
    expect(row.seriesLinkSource).toBe("user");
    expect(taggedIds(netflix.id)).toHaveLength(5);

    const after = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after); // the unlink is NOT reverted
  });

  test("ATTACH: a hand-attached row stays attached; re-detection never moves it", () => {
    const netflix = seriesFor(netflixId);
    const foreign = insertTxn({ postedOn: "2026-06-20", amountCents: -742, rawDescription: "CORNER COFFEE" });

    expect(attachTransactions(bundle.db, netflix.id, [foreign], TODAY)).toBe(1);
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, foreign)).get()!;
    expect(row.recurringSeriesId).toBe(netflix.id);
    expect(row.seriesLinkSource).toBe("user");

    const after = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after); // the attach is NOT reverted
  });

  test("MERGE: source ends and its rows relink; re-detection never resurrects it", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);

    const result = mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    expect(result).toEqual({ relinked: 6, targetId: netflix.id });

    const endedSpotify = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, spotify.id)).get()!;
    expect(endedSpotify.status).toBe("ended");
    expect(endedSpotify.mergedIntoId).toBe(netflix.id);
    // all 12 occurrences now hang off Netflix, the 6 relinked ones user-owned
    expect(taggedIds(netflix.id)).toHaveLength(12);
    const spotifyRows = bundle.db
      .select({ seriesLinkSource: transactions.seriesLinkSource })
      .from(transactions)
      .where(eq(transactions.merchantId, spotifyId))
      .all();
    expect(spotifyRows.every((r) => r.seriesLinkSource === "user")).toBe(true);

    const after = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after); // Spotify is NOT resurrected, rows stay on Netflix
  });

  test("a NEW charge of a merged-away merchant forward-maps to the target, not a new series", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    const seriesCountBefore = bundle.db.select().from(recurringSeries).all().length;

    // a fresh, detection-owned Spotify charge arrives
    const fresh = insertTxn({ postedOn: "2026-07-05", amountCents: -999, rawDescription: "SPOTIFY USA", merchantId: spotifyId });
    detectRecurringSeries(bundle.db, TODAY);

    const row = bundle.db.select().from(transactions).where(eq(transactions.id, fresh)).get()!;
    expect(row.recurringSeriesId).toBe(netflix.id); // routed to the merge target
    // no phantom Spotify series was created
    expect(bundle.db.select().from(recurringSeries).all().length).toBe(seriesCountBefore);
  });
});

describe("merge mechanics + error guards", () => {
  test("merging into a series that was itself merged follows the chain", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    // a third series to chain: give Spotify a merge target of Netflix, then
    // merge a new source into Spotify — it must land on Netflix
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    const third = insertTxn({ postedOn: "2026-06-25", amountCents: -500, rawDescription: "HULU" });
    // stand up a throwaway series to merge from
    const hulu = bundle.db
      .insert(recurringSeries)
      .values({ name: "HULU", kind: "subscription", cadence: "monthly", status: "detected" })
      .returning({ id: recurringSeries.id })
      .get().id;
    bundle.db.update(transactions).set({ recurringSeriesId: hulu }).where(eq(transactions.id, third)).run();

    const result = mergeSeries(bundle.db, hulu, spotify.id, TODAY);
    expect(result.targetId).toBe(netflix.id); // followed spotify → netflix
  });

  test("rejects re-merging an already-merged source (no split brain)", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    const apple = bundle.db
      .insert(recurringSeries)
      .values({ name: "Apple", kind: "subscription", cadence: "monthly", status: "detected" })
      .returning({ id: recurringSeries.id })
      .get().id;

    expect(() => mergeSeries(bundle.db, spotify.id, apple, TODAY)).toThrow(/already been merged/);
    // the original merge record survives intact — nothing is stranded/split
    const still = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, spotify.id)).get()!;
    expect(still.mergedIntoId).toBe(netflix.id);
    expect(taggedIds(netflix.id)).toHaveLength(12);
  });

  test("attaching to a merged-away series routes to the live target", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    const fresh = insertTxn({ postedOn: "2026-07-02", amountCents: -1200, rawDescription: "ONE OFF" });

    expect(attachTransactions(bundle.db, spotify.id, [fresh], TODAY)).toBe(1);
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, fresh)).get()!;
    expect(row.recurringSeriesId).toBe(netflix.id); // NOT the ended Spotify series
    expect(row.seriesLinkSource).toBe("user");
  });

  test("rejects self-merge and unknown ids", () => {
    const netflix = seriesFor(netflixId);
    expect(() => mergeSeries(bundle.db, netflix.id, netflix.id, TODAY)).toThrow(/into itself/);
    expect(() => mergeSeries(bundle.db, "nope", netflix.id, TODAY)).toThrow(/Unknown recurring series/);
    expect(() => mergeSeries(bundle.db, netflix.id, "nope", TODAY)).toThrow(/Unknown recurring series/);
    expect(() => attachTransactions(bundle.db, "nope", ["x"], TODAY)).toThrow(/Unknown recurring series/);
    expect(() => detachTransaction(bundle.db, "nope", TODAY)).toThrow(/Unknown transaction/);
  });

  test("attaching zero transactions is a no-op", () => {
    const netflix = seriesFor(netflixId);
    expect(attachTransactions(bundle.db, netflix.id, [], TODAY)).toBe(0);
  });
});

describe("user overrides shadow detection (§4.4)", () => {
  const base: SeriesOverrides & { id: string; name: string; kind: "subscription" } = {
    id: "s1",
    name: "Netflix",
    kind: "subscription",
    cadence: "monthly",
    userCadence: null,
    intervalDaysAvg: 30,
    nextExpectedOn: "2026-07-15",
    userNextExpectedOn: null,
    nextExpectedAmountCents: -1549,
    userAmountCents: null,
  };

  test("effectiveSeries returns detected values when no override is set", () => {
    expect(effectiveSeries(base)).toEqual({
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-07-15",
      nextExpectedAmountCents: -1549,
    });
  });

  test("overrides win, and a cadence override abandons the detected interval", () => {
    const overridden = { ...base, userCadence: "weekly" as const, userAmountCents: -2000, userNextExpectedOn: "2026-07-20" };
    expect(effectiveSeries(overridden)).toEqual({
      cadence: "weekly",
      intervalDaysAvg: null, // stepping now follows the weekly nominal, not 30
      nextExpectedOn: "2026-07-20",
      nextExpectedAmountCents: -2000,
    });
    // projection honors the override end-to-end
    const occ = projectOccurrences(toProjectable(overridden), "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-20", "2026-07-27"]);
    expect(occ.every((o) => o.amountCents === -2000)).toBe(true);
  });
});

describe("isSeriesActive (Active/Inactive split, §4.1)", () => {
  const s = (over: Partial<SeriesOverrides & { status: string; lastMatchedOn: string | null }>) =>
    ({
      status: "confirmed",
      cadence: "monthly",
      userCadence: null,
      intervalDaysAvg: 30,
      nextExpectedOn: null,
      userNextExpectedOn: null,
      nextExpectedAmountCents: null,
      userAmountCents: null,
      lastMatchedOn: "2026-06-15",
      ...over,
    }) as SeriesOverrides & { status: "confirmed"; lastMatchedOn: string | null };

  test("a recent charge is active; a long-stale one is inactive", () => {
    expect(isSeriesActive(s({ lastMatchedOn: "2026-06-15" }), "2026-07-08")).toBe(true);
    // > 1.5 × 30 + grace days since last charge
    expect(isSeriesActive(s({ lastMatchedOn: "2026-01-15" }), "2026-07-08")).toBe(false);
  });

  test("dismissed, ended, and never-matched series are never active", () => {
    expect(isSeriesActive(s({ status: "dismissed" }), "2026-07-08")).toBe(false);
    expect(isSeriesActive(s({ status: "ended" }), "2026-07-08")).toBe(false);
    expect(isSeriesActive(s({ lastMatchedOn: null }), "2026-07-08")).toBe(false);
  });
});

describe("merge/confirm guards (§4.3 money-integrity)", () => {
  test("merging into a dismissed/ended target is rejected (would vanish the money)", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    setSeriesStatus(bundle.db, netflix.id, "dismissed");
    expect(() => mergeSeries(bundle.db, spotify.id, netflix.id, TODAY)).toThrow(
      /Cannot merge into an inactive series/,
    );
    // spotify's rows stayed put — nothing stranded
    expect(taggedIds(spotify.id)).toHaveLength(6);
  });

  test("a merged-away series cannot be re-confirmed (would resurrect phantom money)", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY); // spotify → ended, merged
    expect(() => setSeriesStatus(bundle.db, spotify.id, "confirmed")).toThrow(
      /Cannot re-confirm a merged series/,
    );
    // dismiss is still allowed on a merged series (it is already dead)
    expect(() => setSeriesStatus(bundle.db, spotify.id, "dismissed")).not.toThrow();
  });
});
