import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { balanceAnchors } from "@/db/schema/balances";
import {
  cutToObserved,
  frontierForSeries,
  ledgerReaches,
  observationFrontier,
  observedThrough,
  seriesAccountIds,
} from "./observation-frontier";

let dir: string;
let bundle: DbBundle;
let institutionId: string;
let seq = 0;

function addAccount(name: string, type: "checking" | "credit" | "investment"): string {
  return createAccount(bundle.db, { institutionId, name, type });
}

function addTxn(
  accountId: string,
  postedOn: string,
  opts: { status?: "active" | "excluded"; seriesId?: string } = {},
): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents: -100,
      rawDescription: `TXN ${seq}`,
      normalizedDescription: normalizeDescription(`TXN ${seq}`),
      status: opts.status ?? "active",
      recurringSeriesId: opts.seriesId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents: -100,
        rawDescription: `TXN ${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function addStatement(accountId: string, periodStart: string, periodEnd: string): void {
  seq += 1;
  const now = new Date().toISOString();
  const fileId = `f${seq}`;
  bundle.db
    .insert(importFiles)
    .values({
      id: fileId,
      fileName: `s${seq}.pdf`,
      fileSha256: `sha${seq}`,
      format: "pdf",
      institutionId,
      parserVersion: 1,
      status: "parsed",
      storagePath: `/tmp/s${seq}.pdf`,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  bundle.db
    .insert(statementPeriods)
    .values({
      id: `p${seq}`,
      importFileId: fileId,
      accountId,
      periodStart,
      periodEnd,
      reconciliation: "reconciled",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-frontier-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("observationFrontier", () => {
  test("takes the LATER of the two arbiters", () => {
    // Chase Sapphire on the real ledger: newest charge 2026-07-30, statement
    // closing 2026-08-02. Transactions alone would call three genuinely-empty
    // covered days unimported.
    const a = addAccount("Card", "credit");
    addTxn(a, "2026-07-30");
    addStatement(a, "2026-07-03", "2026-08-02");
    expect(observationFrontier(bundle.db).byAccount.get(a)).toBe("2026-08-02");
  });

  test("a CSV-only account with no statement is still observed", () => {
    // Cash on Hand has never had a statement and is imported through 2026-08-11.
    const a = addAccount("Wallet", "checking");
    addTxn(a, "2026-08-11");
    expect(observationFrontier(bundle.db).byAccount.get(a)).toBe("2026-08-11");
  });

  test("a statement with no charges in it still counts as shown", () => {
    const a = addAccount("Quiet", "checking");
    addStatement(a, "2026-07-01", "2026-07-31");
    expect(observationFrontier(bundle.db).byAccount.get(a)).toBe("2026-07-31");
  });

  test("an account with neither arbiter is absent, not null-valued", () => {
    // Absent rather than present-with-null so it cannot be mistaken for a
    // frontier of "the beginning of time" by a caller taking a minimum.
    const a = addAccount("Empty", "checking");
    expect(observationFrontier(bundle.db).byAccount.has(a)).toBe(false);
  });

  test("investment accounts are excluded", () => {
    // Their balances are marked to market, not walked from transactions, so
    // "imported through" is not a fact about them.
    const a = addAccount("Brokerage", "investment");
    addTxn(a, "2026-08-25");
    expect(observationFrontier(bundle.db).byAccount.has(a)).toBe(false);
  });

  test("excluded rows do not move the frontier", () => {
    const a = addAccount("Card", "credit");
    addTxn(a, "2026-07-31");
    addTxn(a, "2026-08-20", { status: "excluded" });
    expect(observationFrontier(bundle.db).byAccount.get(a)).toBe("2026-07-31");
  });

});

/*
 * 🔴 S32: the whole-ledger frontier counted TRANSACTIONS only, while its sibling
 * above takes a statement's end as proof a quiet day was looked at. Measured
 * 2026-09-14: the newest active row is Sep 12 and Venture X's statement closes
 * Sep 13, so the dashboard's pace tile read "2 days of September 2026 not
 * imported yet", the heatmap called Sep 13 "not imported yet" while it called
 * Sep 9 — covered by the SAME statement — "nothing spent or earned", and the
 * dashboard's MoversCard said "Venture X imported through Sep 13" in the same
 * breath.
 */
describe("ledgerReaches", () => {
  test("a statement that closes after the newest row counts as imported through its end", () => {
    const card = addAccount("Venture", "credit");
    addTxn(card, "2026-09-12");
    addStatement(card, "2026-08-15", "2026-09-13");
    expect(ledgerReaches(bundle.db)).toBe("2026-09-13");
  });

  test("an investment statement never moves it — a brokerage value is not an import of spending days", () => {
    const checking = addAccount("Checking", "checking");
    const brokerage = addAccount("Brokerage", "investment");
    addTxn(checking, "2026-09-12");
    addStatement(brokerage, "2026-08-01", "2026-09-30");
    expect(ledgerReaches(bundle.db)).toBe("2026-09-12");
  });

  test("a ledger whose only row is on an investment account still reaches that row", () => {
    // ⛔ why this is NOT max(observationFrontier.byAccount): that map drops
    // investment accounts, and would read null here
    const brokerage = addAccount("Brokerage", "investment");
    addTxn(brokerage, "2026-08-25");
    expect(ledgerReaches(bundle.db)).toBe("2026-08-25");
  });

  test("excluded rows do not move it, and an empty ledger reaches nothing", () => {
    expect(ledgerReaches(bundle.db)).toBeNull();
    const card = addAccount("Card", "credit");
    addTxn(card, "2026-07-31");
    addTxn(card, "2026-08-20", { status: "excluded" });
    expect(ledgerReaches(bundle.db)).toBe("2026-07-31");
  });
});

describe("frontierForSeries", () => {
  test("takes the EARLIEST of the accounts a series bills on", () => {
    // Netflix names Chase Sapphire and posted to Discover too. To say a charge
    // is missing from it, both have to have been looked at.
    const stale = addAccount("SoFi", "checking");
    const fresh = addAccount("Venture", "credit");
    addTxn(stale, "2026-07-31");
    addTxn(fresh, "2026-08-14");
    const f = observationFrontier(bundle.db);
    expect(frontierForSeries(f, new Set([stale, fresh]))).toBe("2026-07-31");
    expect(frontierForSeries(f, new Set([fresh]))).toBe("2026-08-14");
  });

  test("an unattributable series gets NO frontier, not the ledger's earliest", () => {
    // The rejected design: one dormant account dragging the floor back months,
    // after which nothing unattributable could ever be graded again — pass 45's
    // overdue-rent hazard rebuilt as a policy.
    const stale = addAccount("SoFi", "checking");
    const fresh = addAccount("Venture", "credit");
    addTxn(stale, "2026-07-31");
    addTxn(fresh, "2026-08-14");
    const f = observationFrontier(bundle.db);
    expect(frontierForSeries(f, undefined)).toBeNull();
    expect(frontierForSeries(f, new Set())).toBeNull();
  });

  test("an account that has never been imported vouches for nothing", () => {
    const fresh = addAccount("Venture", "credit");
    const never = addAccount("New", "checking");
    addTxn(fresh, "2026-08-14");
    const f = observationFrontier(bundle.db);
    // …and specifically does NOT borrow its live sibling's frontier.
    expect(frontierForSeries(f, new Set([never]))).toBeNull();
  });
});

describe("seriesAccountIds", () => {
  test("unions the series' own column with every account its postings touched", () => {
    const a = addAccount("A", "checking");
    const b = addAccount("B", "credit");
    const seriesId = "s-1";
    const now = new Date().toISOString();
    bundle.db.run(
      `insert into recurring_series (id, name, account_id, kind, cadence, tolerance_days, status, created_at, updated_at)
       values ('${seriesId}', 'Netflix', '${a}', 'subscription', 'monthly', 3, 'ended', '${now}', '${now}')`,
    );
    addTxn(b, "2026-05-01", { seriesId });

    expect(seriesAccountIds(bundle.db).get(seriesId)).toEqual(new Set([a, b]));
  });

  test("a series with a column and no postings still reports its account", () => {
    const a = addAccount("A", "checking");
    const seriesId = "s-2";
    const now = new Date().toISOString();
    bundle.db.run(
      `insert into recurring_series (id, name, account_id, kind, cadence, tolerance_days, status, created_at, updated_at)
       values ('${seriesId}', 'Merged away', '${a}', 'subscription', 'monthly', 3, 'ended', '${now}', '${now}')`,
    );
    expect(seriesAccountIds(bundle.db).get(seriesId)).toEqual(new Set([a]));
  });

  test("untagged rows are not attributed to any series", () => {
    const a = addAccount("A", "checking");
    addTxn(a, "2026-05-01");
    expect(seriesAccountIds(bundle.db).size).toBe(0);
  });
});

/*
 * S24 — the day a BALANCE was observed: the frontier above, plus the newest
 * balance recorded for the account. See `institution-groups.test.ts` for the
 * surfaces it dates.
 */
describe("observedThrough", () => {
  function addAnchor(accountId: string, anchoredOn: string): void {
    const now = new Date().toISOString();
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId, anchoredOn, balanceCents: 1_00, source: "manual", createdAt: now, updatedAt: now })
      .run();
  }

  test("takes the latest of the newest row, statement end and recorded balance", () => {
    const a = addAccount("Card", "credit");
    addTxn(a, "2026-07-30");
    addStatement(a, "2026-07-03", "2026-08-02");
    expect(observedThrough(bundle.db).get(a)).toBe("2026-08-02");
    addAnchor(a, "2026-08-05");
    expect(observedThrough(bundle.db).get(a)).toBe("2026-08-05");
  });

  test("an anchor OLDER than the frontier does not pull it back", () => {
    const a = addAccount("Wallet", "checking");
    addAnchor(a, "2026-08-03");
    addTxn(a, "2026-08-11");
    expect(observedThrough(bundle.db).get(a)).toBe("2026-08-11");
  });

  test("an account with only recorded balances, and an investment account, are absent — their series is not cut", () => {
    const anchorsOnly = addAccount("Safe", "checking");
    addAnchor(anchorsOnly, "2026-08-05");
    const brokerage = addAccount("Brokerage", "investment");
    addTxn(brokerage, "2026-08-01");
    expect(observedThrough(bundle.db).has(anchorsOnly)).toBe(false);
    expect(observedThrough(bundle.db).has(brokerage)).toBe(false);
  });
});

describe("cutToObserved", () => {
  const series = [
    { day: "2026-09-06", cents: 1 },
    { day: "2026-09-07", cents: 2 },
    // 09-08 is a gap day, already dropped from the covered series
    { day: "2026-09-09", cents: 3 },
    { day: "2026-09-14", cents: 3 },
  ];

  test("drops the days after the observed one", () => {
    expect(cutToObserved(series, "2026-09-07").map((p) => p.day)).toEqual(["2026-09-06", "2026-09-07"]);
  });

  test("keeps every covered day on or before it, when the observed day itself is not covered", () => {
    expect(cutToObserved(series, "2026-09-08").map((p) => p.day)).toEqual(["2026-09-06", "2026-09-07"]);
  });

  test("no observed day, or one at or past the newest point, leaves the series whole", () => {
    expect(cutToObserved(series, undefined)).toEqual(series);
    expect(cutToObserved(series, "2026-09-14")).toEqual(series);
    expect(cutToObserved(series, "2026-09-20")).toEqual(series);
  });

  test("⛔ a cut that would leave nothing keeps the series — a card is never nulled by its own date", () => {
    expect(cutToObserved(series, "2026-09-01")).toEqual(series);
    expect(cutToObserved([], "2026-09-01")).toEqual([]);
  });
});
