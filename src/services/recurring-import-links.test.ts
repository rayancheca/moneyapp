import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions, type SeriesLinkSource } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { overdueForSeries } from "./arrears";
import { projectOccurrences, toProjectable } from "./recurring";
import { linkRowsMadeActive } from "./recurring-import-links";

/** The day the Breezeline row of 2026-09-10 was imported into the real ledger. */
const TODAY = "2026-09-14";

let dir: string;
let bundle: DbBundle;
let card: string;
let checking: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-importlinks-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  checking = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(opts: {
  postedOn: string;
  amountCents: number;
  raw: string;
  accountId?: string;
  seriesId?: string | null;
  linkSource?: SeriesLinkSource | null;
  transferGroupId?: string | null;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? card;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.raw,
      normalizedDescription: normalizeDescription(opts.raw),
      recurringSeriesId: opts.seriesId ?? null,
      seriesLinkSource: opts.linkSource ?? (opts.seriesId ? "detected" : null),
      transferGroupId: opts.transferGroupId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.raw}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** A series registered by hand: its schedule is what the owner typed. */
function register(opts: {
  name: string;
  amountCents: number;
  nextOn: string;
  cadence?: Cadence;
  kind?: SeriesKind;
  status?: SeriesStatus;
  accountId?: string | null;
  anchorDay?: number | null;
  toleranceDays?: number;
}): string {
  const cadence = opts.cadence ?? "monthly";
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind ?? "bill",
      cadence,
      status: opts.status ?? "confirmed",
      accountId: opts.accountId ?? null,
      intervalDaysAvg: cadence === "quarterly" ? 91 : 30,
      toleranceDays: opts.toleranceDays ?? 3,
      amountCentsAvg: opts.amountCents,
      nextExpectedOn: opts.nextOn,
      nextExpectedAmountCents: opts.amountCents,
      userAmountCents: opts.amountCents,
      anchorDay: opts.anchorDay ?? Number(opts.nextOn.slice(8, 10)),
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

const seriesOf = (txnId: string) =>
  bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
const seriesRow = (id: string) =>
  bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;

/** Every link and every stat a linking pass could write. */
function ledgerState() {
  return {
    txns: bundle.db
      .select({ id: transactions.id, s: transactions.recurringSeriesId, src: transactions.seriesLinkSource })
      .from(transactions)
      .orderBy(asc(transactions.id))
      .all(),
    series: bundle.db.select().from(recurringSeries).orderBy(asc(recurringSeries.id)).all(),
  };
}

describe("linking at import — the rows an operation made active, and only those", () => {
  /*
   * 🔴 The real shape, 2026-09-14. Breezeline (internet) is a confirmed bill the
   * owner registered at $50.00 on the 8th, carrying three linked postings:
   * 2026-06-20 -$40.32 under a different descriptor, then 2026-07-10 and
   * 2026-08-10 under "BREEZELINE 866-290-5400 MA". The 2026-09-10 charge was
   * imported that afternoon with that exact descriptor and nothing linked it,
   * so /recurring said "1 × -$50.00 (monthly), came due Sep 8 and has not
   * posted" beside the posting itself.
   *
   * ⛔ It needs three prior rows with an uneven first gap: the 4th is what
   * crosses MIN_OCCURRENCES and recomputes the interval to 27.33, and three
   * identical 30-day gaps could not express the drift 74dfdfe closed.
   */
  test("the Breezeline charge of 2026-09-10 links on import — and the Sep 8 bill is no longer owed", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08", anchorDay: 8 });
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-09-08", lastMatchedOn: "2026-08-10" })
      .where(eq(recurringSeries.id, breezeline))
      .run();
    post({ postedOn: "2026-06-20", amountCents: -4032, raw: "MOBILE* BREEZELINE REACHPLATFORM", seriesId: breezeline, linkSource: "user" });
    post({ postedOn: "2026-07-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const imported = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });

    // the fixture expresses the defect: unlinked, the bill reads as owed
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY).totalCents).toBe(5000);

    expect(linkRowsMadeActive(bundle.db, [imported], TODAY)).toEqual({ absorbed: 1 });

    expect(seriesOf(imported).recurringSeriesId).toBe(breezeline);
    expect(seriesOf(imported).seriesLinkSource).toBe("detected");
    expect(seriesRow(breezeline).lastMatchedOn).toBe("2026-09-10");
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY).totalCents).toBe(0);
    // …and the recompute the 4th posting triggers does not re-step the owner's
    // schedule: still the 8th, twelve charges a year
    const walk = projectOccurrences(toProjectable(seriesRow(breezeline)), "2026-09-15", "2027-09-14").map((o) => o.date);
    expect(walk).toHaveLength(12);
    expect(walk.every((d) => d.endsWith("-08"))).toBe(true);
  });

  test("a row outside the operation's scope is not claimed, though its description is owned", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08" });
    post({ postedOn: "2026-07-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const history = post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });
    const imported = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });

    linkRowsMadeActive(bundle.db, [imported], TODAY);

    expect(seriesOf(imported).recurringSeriesId).toBe(breezeline);
    expect(seriesOf(history).recurringSeriesId).toBeNull();
  });

  test("an empty scope writes nothing at all", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08" });
    post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const absorbable = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });
    const before = ledgerState();

    expect(linkRowsMadeActive(bundle.db, [], TODAY)).toEqual({ absorbed: 0 });
    expect(ledgerState()).toEqual(before);

    // the control: the same row in scope IS linked, so the empty set did it
    linkRowsMadeActive(bundle.db, [absorbable], TODAY);
    expect(seriesOf(absorbable).recurringSeriesId).toBe(breezeline);
  });
});
