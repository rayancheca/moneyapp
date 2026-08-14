import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
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
import { applyUndoPatch } from "./bulk-edit";
import {
  attachTransactions,
  createSeriesFromTransaction,
  detachTransaction,
  mergeSeries,
  undoSeriesCreation,
} from "./recurring-links";

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

    const former = detachTransaction(bundle.db, target, TODAY).formerSeriesId;
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

    expect(attachTransactions(bundle.db, netflix.id, [foreign], TODAY).attached).toBe(1);
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

    expect(attachTransactions(bundle.db, spotify.id, [fresh], TODAY).attached).toBe(1);
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
    expect(attachTransactions(bundle.db, netflix.id, [], TODAY).attached).toBe(0);
  });

  test("a merge snapshots the pre-merge series first — it has no inverse", () => {
    // the archive lives beside the database it protects (.db only — reading a
    // snapshot back leaves -wal/-shm siblings behind)
    const snapshots = () => {
      const backups = path.join(dir, "backups");
      if (!fs.existsSync(backups)) return [];
      return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
    };

    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    expect(snapshots()).toEqual([]);

    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);

    const name = snapshots()[0]!;
    expect(name).toMatch(/-merge-series\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    const source = before.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.id, spotify.id))
      .get()!;
    expect(source.mergedIntoId).toBeNull(); // still live in the restore point
    expect(source.status).not.toBe("ended");
    before.sqlite.close();
    // …and ended in the live database
    expect(
      bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, spotify.id)).get()!
        .mergedIntoId,
    ).toBe(netflix.id);
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
      anchorDay: null,
    });
  });

  test("overrides win, and a cadence override abandons the detected interval", () => {
    const overridden = { ...base, userCadence: "weekly" as const, userAmountCents: -2000, userNextExpectedOn: "2026-07-20" };
    expect(effectiveSeries(overridden)).toEqual({
      cadence: "weekly",
      intervalDaysAvg: null, // stepping now follows the weekly nominal, not 30
      nextExpectedOn: "2026-07-20",
      nextExpectedAmountCents: -2000,
      anchorDay: null,
    });
    // projection honors the override end-to-end
    const occ = projectOccurrences(toProjectable(overridden), "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-20", "2026-07-27"]);
    expect(occ.every((o) => o.amountCents === -2000)).toBe(true);
  });

  /**
   * A detected anchor day must not survive a date the user typed. Otherwise
   * picking the 15th on a month-end series would be silently re-dayed to the
   * 31st, and the override would look like it had been ignored.
   */
  test("a user's own date beats the detected anchor day", () => {
    const monthEnd = { ...base, anchorDay: 31, nextExpectedOn: "2027-02-28" };
    expect(effectiveSeries(monthEnd).anchorDay).toBe(31);
    expect(projectOccurrences(toProjectable(monthEnd), "2027-03-01", "2027-03-31").map((o) => o.date))
      .toEqual(["2027-03-31"]);

    const pinned = { ...monthEnd, userNextExpectedOn: "2027-03-15" };
    expect(effectiveSeries(pinned).anchorDay).toBeNull();
    expect(projectOccurrences(toProjectable(pinned), "2027-03-01", "2027-03-31").map((o) => o.date))
      .toEqual(["2027-03-15"]);
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

describe("lossless link-ownership undo (S5 hardening)", () => {
  function txnRow(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("attach → undo restores BOTH the series id and the link ownership", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    const target = taggedIds(netflix.id)[0]!;
    const before = txnRow(target);
    expect(before.seriesLinkSource).toBe("detected"); // detector-owned

    const result = attachTransactions(bundle.db, spotify.id, [target], TODAY);
    expect(txnRow(target).seriesLinkSource).toBe("user");
    expect(txnRow(target).recurringSeriesId).toBe(spotify.id);

    applyUndoPatch(bundle.db, result.undo);
    const after = txnRow(target);
    expect(after.recurringSeriesId).toBe(before.recurringSeriesId);
    expect(after.seriesLinkSource).toBe("detected"); // detection owns it again
  });

  test("detach → undo restores the link without stamping user ownership", () => {
    const netflix = seriesFor(netflixId);
    const target = taggedIds(netflix.id)[0]!;
    const before = txnRow(target);

    const result = detachTransaction(bundle.db, target, TODAY);
    expect(txnRow(target).recurringSeriesId).toBeNull();
    expect(txnRow(target).seriesLinkSource).toBe("user");

    applyUndoPatch(bundle.db, result.undo);
    const after = txnRow(target);
    expect(after.recurringSeriesId).toBe(before.recurringSeriesId);
    expect(after.seriesLinkSource).toBe(before.seriesLinkSource);
  });
});

describe("createSeriesFromTransaction — the 'Make recurring' button", () => {
  function seriesById(id: string) {
    return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;
  }
  function txnRow(id: string) {
    return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  }

  test("creates a confirmed series from a txn with stable siblings and links them all user-owned", () => {
    const ids = ["2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10"].map((d) =>
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" }),
    );
    const result = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    expect(result.mode).toBe("created");
    const series = seriesById(result.seriesId);
    expect(series.status).toBe("confirmed");
    expect(series.cadence).toBe("monthly");
    expect(series.kind).toBe("bill");
    expect(series.accountId).toBe(cardId);
    // the 10th, every time — detection's own rule, and the day the bill lands.
    // The old last + median-gap (31d) walk put it on the 11th.
    expect(series.nextExpectedOn).toBe("2026-07-10");
    expect(taggedIds(result.seriesId).sort()).toEqual([...ids].sort());
    // detected-ownership keeps the rows in detection's grouping pool, so the
    // series keeps absorbing its own future charges (a user stamp would freeze it)
    for (const id of ids) expect(txnRow(id).seriesLinkSource).toBe("detected");

    // §4.3 invariant: a detection re-run changes nothing
    const after = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after);
  });

  test("the created series ABSORBS its next charge on the following detection run", () => {
    const ids = ["2026-03-10", "2026-04-10", "2026-05-10"].map((d) =>
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" }),
    );
    const result = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    const next = insertTxn({ postedOn: "2026-06-10", amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" });
    detectRecurringSeries(bundle.db, TODAY);
    expect(txnRow(next).recurringSeriesId).toBe(result.seriesId); // no duplicate series, no orphan
  });

  test("thin pattern (below the evidence bar) → monthly fallback seeded from the txn, seed-only link", () => {
    insertTxn({ postedOn: "2026-06-20", amountCents: -4032, rawDescription: "GYM MIAMI 001" });
    const seed = insertTxn({ postedOn: "2026-07-05", amountCents: -5000, rawDescription: "GYM MIAMI 001" });
    const result = createSeriesFromTransaction(bundle.db, seed, TODAY);
    expect(result.mode).toBe("created");
    const series = seriesById(result.seriesId);
    expect(series.status).toBe("confirmed");
    expect(series.cadence).toBe("monthly");
    expect(series.amountCentsAvg).toBe(-5000);
    expect(series.nextExpectedOn).toBe("2026-08-05"); // the seed's day-of-month, one month on
    expect(series.nextExpectedAmountCents).toBe(-5000);
    expect(series.confidence).toBeNull(); // honest: user-asserted, not evidenced
    expect(taggedIds(result.seriesId)).toEqual([seed]); // sibling NOT swept in without evidence

    // §4.3: a detection re-run neither dismantles the thin series nor re-groups its row
    const after = snapshot();
    detectRecurringSeries(bundle.db, TODAY);
    expect(snapshot()).toEqual(after);
  });

  test("the thin-evidence anchor is one calendar month on — and a month-end seed keeps its clamp", () => {
    /*
     * A series created `monthly` with a null intervalDaysAvg is CALENDAR
     * monthly, so its anchor decides its day-of-month for good: recomputeSeries
     * Stats declines to write while the evidence stays this thin, and detection
     * does not even link the second charge, so nothing corrects it until a third
     * one lands. A 30-day hop off Jan 31 would put this charge on March 2 and
     * keep it there.
     *
     * February has no 31st, so the stored anchor IS the clamp — unavoidable when
     * a schedule is one date. What is no longer inherited is the clamp itself:
     * `anchor_day` carries the 31 the user typed, so the walk returns to the
     * last day in March instead of sitting on the 28th forever.
     */
    const seed = insertTxn({ postedOn: "2026-01-31", amountCents: -5000, rawDescription: "MONTH END DUES" });
    const result = createSeriesFromTransaction(bundle.db, seed, TODAY);
    const series = seriesById(result.seriesId);
    expect(series.nextExpectedOn).toBe("2026-02-28");
    expect(series.anchorDay).toBe(31);

    const walk = projectOccurrences(
      toProjectable({ ...series, userEndsOn: null }),
      "2026-02-01",
      "2026-05-31",
    ).map((o) => o.date);
    expect(walk).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  test("a FUTURE-dated seed still becomes the member of its own series (no phantom)", () => {
    const seed = insertTxn({ postedOn: "2026-07-20", amountCents: -228570, rawDescription: "SCHEDULED RENT" });
    const result = createSeriesFromTransaction(bundle.db, seed, TODAY); // TODAY = 2026-07-08
    expect(result.mode).toBe("created");
    expect(result.linked).toBe(1);
    expect(taggedIds(result.seriesId)).toEqual([seed]);
    expect(seriesById(result.seriesId).accountId).toBe(cardId); // never a null-identity phantom
    // a second click can't mint a duplicate — the seed is already linked
    expect(() => createSeriesFromTransaction(bundle.db, seed, TODAY)).toThrow(/already/i);
  });

  test("a transfer-categorized seed creates a transfer-kind series (never income/bill)", () => {
    const catId = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Internal Transfer"))
      .get()!.id;
    const seed = insertTxn({ postedOn: "2026-07-01", amountCents: -90000, rawDescription: "MONTHLY VAULT SWEEP" });
    bundle.db.update(transactions).set({ categoryId: catId }).where(eq(transactions.id, seed)).run();
    const result = createSeriesFromTransaction(bundle.db, seed, TODAY);
    expect(seriesById(result.seriesId).kind).toBe("transfer");
  });

  test("description-identity (no merchant) attach: a fresh charge joins the created series", () => {
    const ids = ["2026-03-10", "2026-04-10", "2026-05-10"].map((d) =>
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" }),
    );
    const first = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    const fresh = insertTxn({ postedOn: "2026-06-10", amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" });
    const second = createSeriesFromTransaction(bundle.db, fresh, TODAY);
    expect(second.mode).toBe("attached"); // account+name identity found the live series
    expect(second.seriesId).toBe(first.seriesId);
  });

  test("a merge chain resolving to a LATER-dismissed target refuses with the revive hint", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    setSeriesStatus(bundle.db, netflix.id, "dismissed"); // the live target dies AFTER the merge
    const fresh = insertTxn({ postedOn: "2026-07-02", amountCents: -999, rawDescription: "SPOTIFY USA", merchantId: spotifyId });
    expect(() => createSeriesFromTransaction(bundle.db, fresh, TODAY)).toThrow(/Recurring page/i);
  });

  test("a positive seed with stable siblings creates an income-kind series", () => {
    const ids = ["2026-04-03", "2026-05-03", "2026-06-03"].map((d) =>
      insertTxn({ postedOn: d, amountCents: 50000, rawDescription: "SIDE GIG PAYOUT" }),
    );
    const result = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    expect(seriesById(result.seriesId).kind).toBe("income");
  });

  test("throws when the seed already belongs to a series", () => {
    const netflix = seriesFor(netflixId);
    const linked = taggedIds(netflix.id)[0]!;
    expect(() => createSeriesFromTransaction(bundle.db, linked, TODAY)).toThrow(/already/i);
  });

  test("same-merchant live series exists → attaches instead of duplicating", () => {
    const netflix = seriesFor(netflixId);
    const fresh = insertTxn({ postedOn: "2026-07-01", amountCents: -1549, rawDescription: "NETFLIX.COM", merchantId: netflixId });
    const before = bundle.db.select().from(recurringSeries).all().length;
    const result = createSeriesFromTransaction(bundle.db, fresh, TODAY);
    expect(result.mode).toBe("attached");
    expect(result.seriesId).toBe(netflix.id);
    expect(txnRow(fresh).recurringSeriesId).toBe(netflix.id);
    expect(txnRow(fresh).seriesLinkSource).toBe("user");
    expect(bundle.db.select().from(recurringSeries).all().length).toBe(before); // no new series
  });

  test("a merged-away identity forward-maps to its live target (never resurrects)", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    const fresh = insertTxn({ postedOn: "2026-07-02", amountCents: -999, rawDescription: "SPOTIFY USA", merchantId: spotifyId });
    const result = createSeriesFromTransaction(bundle.db, fresh, TODAY);
    expect(result.mode).toBe("attached");
    expect(result.seriesId).toBe(netflix.id);
  });

  test("matching series exists but is dismissed → throws with a revive hint", () => {
    const netflix = seriesFor(netflixId);
    setSeriesStatus(bundle.db, netflix.id, "dismissed");
    const fresh = insertTxn({ postedOn: "2026-07-03", amountCents: -1549, rawDescription: "NETFLIX.COM", merchantId: netflixId });
    expect(() => createSeriesFromTransaction(bundle.db, fresh, TODAY)).toThrow(/Recurring page/i);
  });

  test("never steals rows already linked to another series", () => {
    const netflix = seriesFor(netflixId);
    const stolen = insertTxn({ postedOn: "2026-05-12", amountCents: -700, rawDescription: "CORNER BAKERY" });
    attachTransactions(bundle.db, netflix.id, [stolen], TODAY);
    for (const d of ["2026-04-12", "2026-06-12", "2026-07-01"]) {
      insertTxn({ postedOn: d, amountCents: -700, rawDescription: "CORNER BAKERY" });
    }
    const seed = insertTxn({ postedOn: "2026-07-06", amountCents: -700, rawDescription: "CORNER BAKERY" });
    const result = createSeriesFromTransaction(bundle.db, seed, TODAY);
    expect(result.mode).toBe("created");
    expect(taggedIds(result.seriesId)).not.toContain(stolen);
    expect(txnRow(stolen).recurringSeriesId).toBe(netflix.id); // untouched
  });

  test("undoSeriesCreation restores each row's pre-creation link state and deletes the series", () => {
    const ids = ["2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10"].map((d) =>
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" }),
    );
    // one row carries a PRIOR user detach-marker — undo must preserve it, not blanket-null it
    bundle.db.update(transactions).set({ seriesLinkSource: "user" }).where(eq(transactions.id, ids[0]!)).run();
    const result = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    const undone = undoSeriesCreation(bundle.db, result.seriesId, result.undo);
    expect(undone.unlinked).toBe(4);
    expect(undone.alreadyUndone).toBe(false);
    expect(bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, result.seriesId)).get()).toBeUndefined();
    for (const id of ids) expect(txnRow(id).recurringSeriesId).toBeNull();
    expect(txnRow(ids[0]!).seriesLinkSource).toBe("user"); // the detach-marker survived
    expect(txnRow(ids[1]!).seriesLinkSource).toBeNull(); // creation fully unwound

    // a SECOND undo click is a tolerated no-op, not an error toast
    const again = undoSeriesCreation(bundle.db, result.seriesId, result.undo);
    expect(again).toEqual({ unlinked: 0, alreadyUndone: true });
  });

  test("undoSeriesCreation refuses when rows were attached AFTER creation", () => {
    const ids = ["2026-03-10", "2026-04-10", "2026-05-10"].map((d) =>
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "BREEZELINE 866-290-5400" }),
    );
    const result = createSeriesFromTransaction(bundle.db, ids.at(-1)!, TODAY);
    const later = insertTxn({ postedOn: "2026-06-25", amountCents: -742, rawDescription: "CORNER COFFEE" });
    attachTransactions(bundle.db, result.seriesId, [later], TODAY);
    expect(() => undoSeriesCreation(bundle.db, result.seriesId, result.undo)).toThrow(/attached/i);
    // the attached row is untouched — its link wasn't ours to destroy
    expect(txnRow(later).recurringSeriesId).toBe(result.seriesId);
  });

  test("undoSeriesCreation refuses a series that other series merged into", () => {
    const netflix = seriesFor(netflixId);
    const spotify = seriesFor(spotifyId);
    mergeSeries(bundle.db, spotify.id, netflix.id, TODAY);
    expect(() => undoSeriesCreation(bundle.db, netflix.id, { rows: [] })).toThrow(/merge/i);
  });
});
