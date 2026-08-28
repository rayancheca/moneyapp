import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { holdingEvents } from "@/db/schema/holding-events";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { regradeStatementPeriods } from "@/services/statement-periods";
import { rebuildAccount } from "@/services/derivation";
import { reconcileAccounts } from "./service";

/**
 * Direct coverage for `reconcileAccounts` — which had none.
 *
 * That absence is why a real double count survived: every existing test drives
 * reconciliation through a fixture import, and no fixture reproduces the shape
 * that broke the Chase Sapphire card. A payment recorded twice — once as the
 * line the bank printed, once as a hand-entered mirror carrying the bank's post
 * date a couple of days later — is invisible to `consumeIdentity` (both of its
 * lenses key on an EXACT day) and shows up only here, as a period that will not
 * close. These tests pin that it does not close, so the next such pair is caught
 * by the suite rather than by reading a chart with 323 blank days in it.
 */

let dir: string;
let bundle: DbBundle;

const ACCOUNT = "acct-card";
const FILE = "file-stmt";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reconcile-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);

  const institution = bundle.db.select().from(institutions).all()[0]!;
  bundle.db
    .insert(accounts)
    .values({ id: ACCOUNT, institutionId: institution.id, name: "Test Card", type: "credit" })
    .run();
  bundle.db
    .insert(importFiles)
    .values({
      id: FILE,
      fileName: "statement.pdf",
      fileSha256: "sha-statement",
      format: "pdf",
      institutionId: institution.id,
      parserProfile: "chase-card-statement-pdf",
      status: "parsed",
      storagePath: "statements/test/statement.pdf",
      importedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface RowSpec {
  postedOn: string;
  transactedOn?: string | null;
  amountCents: number;
  description: string;
  importFileId?: string | null;
}

function addRow(spec: RowSpec): string {
  const id = `txn-${spec.postedOn}-${spec.amountCents}-${spec.description.slice(0, 6)}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: ACCOUNT,
      importFileId: spec.importFileId === undefined ? FILE : spec.importFileId,
      postedOn: spec.postedOn,
      transactedOn: spec.transactedOn === undefined ? spec.postedOn : spec.transactedOn,
      amountCents: spec.amountCents,
      rawDescription: spec.description,
      normalizedDescription: spec.description.toLowerCase(),
      dedupeHash: dedupeHash({
        accountId: ACCOUNT,
        postedOn: spec.postedOn,
        amountCents: spec.amountCents,
        rawDescription: spec.description,
        occurrenceIndex: 0,
      }),
    })
    .run();
  return id;
}

/**
 * A card period: opens $500 in debt and takes one $200 payment, so it closes
 * $300 in debt — unless the caller declares more activity, in which case it
 * passes the closing balance that activity implies.
 */
function addPeriod(endingBalanceCents = -30_000): void {
  bundle.db
    .insert(statementPeriods)
    .values({
      id: "period-1",
      accountId: ACCOUNT,
      importFileId: FILE,
      periodStart: "2026-02-03",
      periodEnd: "2026-03-02",
      beginningBalanceCents: -50_000,
      endingBalanceCents,
      // the state a freshly-parsed period is written in, before any verdict
      reconciliation: "gap",
    })
    .run();
}

function period(): { reconciliation: string; gapCents: number | null } {
  const row = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.id, "period-1")).get()!;
  return { reconciliation: row.reconciliation, gapCents: row.gapCents };
}

function statusOf(id: string): string {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!.status;
}

describe("reconcileAccounts", () => {
  test("a period whose rows close the balance to the cent reconciles", () => {
    addPeriod();
    addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });

    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });
  });

  test("the same payment recorded twice, two days apart, leaves a gap the size of the payment", () => {
    addPeriod();
    addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });
    // the mirror: same money, the BANK's post date, and no transaction date at
    // all — which is exactly why neither dedupe lens can see it
    const mirror = addRow({
      postedOn: "2026-02-16",
      transactedOn: null,
      amountCents: 20_000,
      description: "PAYMENT — Checking",
      importFileId: null,
    });

    reconcileAccounts(bundle.db, [ACCOUNT]);

    // the double count reads as a gap of exactly the duplicated payment
    expect(period()).toEqual({ reconciliation: "gap", gapCents: -20_000 });
    // and the mirror keeps its status: the quarantine only reaches rows the
    // period's OWN file contributed, so a hand-entered duplicate stays in
    // balance replay and the money stays double-counted until someone acts
    expect(statusOf(mirror)).toBe("active");
  });

  test("retiring the mirror closes the period, and the statement row comes out of quarantine", () => {
    addPeriod();
    const printed = addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });
    const mirror = addRow({
      postedOn: "2026-02-16",
      transactedOn: null,
      amountCents: 20_000,
      description: "PAYMENT — Checking",
      importFileId: null,
    });

    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period().reconciliation).toBe("gap");
    expect(statusOf(printed)).toBe("quarantined");

    // what scripts/fix-card-payment-mirrors.ts does to the losing side
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, mirror)).run();
    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });
    expect(statusOf(printed)).toBe("active");
  });

  test("a row dated outside its own period is not counted, and the period gaps by its amount", () => {
    // the statement declares a $50 charge as well as the payment, so it closes
    // $350 in debt
    addPeriod(-35_000);
    addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });
    // Chase prints the TRANSACTION date, so a charge made on the last day of the
    // previous cycle is declared by THIS statement while dating before its window
    addRow({ postedOn: "2026-02-02", amountCents: -5_000, description: "BEST BUY" });

    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period()).toEqual({ reconciliation: "gap", gapCents: -5_000 });
  });

  test("pulling that row into the window closes the period", () => {
    addPeriod(-35_000);
    addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });
    const straddler = addRow({ postedOn: "2026-02-02", amountCents: -5_000, description: "BEST BUY" });

    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period().reconciliation).toBe("gap");

    bundle.db.update(transactions).set({ postedOn: "2026-02-03" }).where(eq(transactions.id, straddler)).run();
    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });
  });

  test("an `excluded` row still counts — it is hidden from analytics, not from the money", () => {
    addPeriod();
    const id = addRow({ postedOn: "2026-02-14", amountCents: 20_000, description: "Payment Thank You" });
    bundle.db.update(transactions).set({ status: "excluded" }).where(eq(transactions.id, id)).run();

    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period().reconciliation).toBe("reconciled");
  });

  test("an accepted period is never re-judged", () => {
    addPeriod();
    bundle.db
      .update(statementPeriods)
      .set({ reconciliation: "accepted", gapCents: -20_000 })
      .where(eq(statementPeriods.id, "period-1"))
      .run();

    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(period()).toEqual({ reconciliation: "accepted", gapCents: -20_000 });
  });
});

/**
 * PASS 74 — a stored verdict that cannot outlive the ledger beneath it.
 *
 * ⛔ `reconciliation` and `gap_cents` were written once, at import, and nothing
 * revisited them. A hand-entered +$3,579.67 plug held July 2026 at a stored gap
 * of $231.85 while the real figure was $3,811.52 — the check that found it
 * (`isVerdictStale`) could only report the drift after the fact.
 */
describe("regradeStatementPeriods", () => {
  test("re-grades against the CURRENT rows, not the ones that were there at import", () => {
    addPeriod();
    const payment = addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });

    // the money leaves the ledger AFTER the verdict was written
    bundle.db.delete(transactions).where(eq(transactions.id, payment)).run();
    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null }); // stale

    expect(regradeStatementPeriods(bundle.db, ACCOUNT)).toEqual({ changed: 1, examined: 1 });
    expect(period()).toEqual({ reconciliation: "gap", gapCents: 20_000 });
  });

  /*
   * ⛔ The reason this is not `reconcileAccounts`. Quarantine is a decision
   * about a FILE — these rows came in together and hold together until the
   * period is understood — and a rebuild the owner did not ask for must not
   * hide rows behind his back.
   */
  test("⛔ it grades and NOTHING else — no status moves", () => {
    // a period that CLOSES, so reconcileAccounts leaves both rows active
    addPeriod(-31_000);
    const payment = addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    const other = addRow({ postedOn: "2026-02-11", amountCents: -1_000, description: "COFFEE" });
    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period().reconciliation).toBe("reconciled");
    expect(statusOf(payment)).toBe("active");

    // …and now the ledger changes under it
    bundle.db.update(transactions).set({ amountCents: 15_000 }).where(eq(transactions.id, payment)).run();
    regradeStatementPeriods(bundle.db, ACCOUNT);

    expect(period()).toEqual({ reconciliation: "gap", gapCents: 5_000 });
    // ⛔ the verdict moved and the rows did not — `reconcileAccounts` would have
    // quarantined both of them here
    expect(statusOf(payment)).toBe("active");
    expect(statusOf(other)).toBe("active");
  });

  /*
   * ⛔ TWO PATHS, ONE ANSWER. `reconcileAccounts` writes its own verdict inside
   * the transaction that carries its quarantine; both go through `periodVerdict`
   * and so must agree. Asserted rather than promised in a comment.
   */
  test("after reconcileAccounts there is nothing left to re-grade", () => {
    addPeriod();
    addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    addRow({ postedOn: "2026-02-11", amountCents: -1_000, description: "COFFEE" });
    reconcileAccounts(bundle.db, [ACCOUNT]);

    expect(regradeStatementPeriods(bundle.db, ACCOUNT).changed).toBe(0);
  });

  /*
   * ⛔ `RECONCILE_STATUSES` is the definition of "money that moved", and it is
   * NOT the same as "money the analytics show": an `excluded` row is hidden from
   * every spend view and still left the account. A superseded one did not.
   */
  test("grades over the statuses that moved money, and only those", () => {
    addPeriod(-31_000);
    addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    addRow({ postedOn: "2026-02-11", amountCents: -1_000, description: "COFFEE" });
    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period().reconciliation).toBe("reconciled");

    // a superseded row is a row that is NOT in the ledger; counting it would
    // open a gap out of a duplicate the app already resolved
    const ghost = addRow({ postedOn: "2026-02-12", amountCents: -9_900, description: "GHOST" });
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, ghost)).run();

    expect(regradeStatementPeriods(bundle.db, ACCOUNT).changed).toBe(0);
    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });
  });

  /*
   * ⛔ The period is a WINDOW. A row outside it belongs to another statement,
   * and summing it here would grade this period against somebody else's money.
   */
  test("rows outside the period are not in its sum, on either side", () => {
    addPeriod(-31_000);
    addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    addRow({ postedOn: "2026-02-11", amountCents: -1_000, description: "COFFEE" });
    reconcileAccounts(bundle.db, [ACCOUNT]);

    // one the day BEFORE it opens, one the day AFTER it closes
    addRow({ postedOn: "2026-02-02", amountCents: -7_700, description: "BEFORE" });
    addRow({ postedOn: "2026-03-03", amountCents: -8_800, description: "AFTER" });

    expect(regradeStatementPeriods(bundle.db, ACCOUNT).changed).toBe(0);
    expect(period()).toEqual({ reconciliation: "reconciled", gapCents: null });
  });

  test("an accepted period is a decision, and a re-grade leaves it alone", () => {
    addPeriod();
    addRow({ postedOn: "2026-02-10", amountCents: 5_000, description: "PAYMENT" });
    bundle.db.update(statementPeriods).set({ reconciliation: "accepted", gapCents: 15_000 }).run();

    expect(regradeStatementPeriods(bundle.db, ACCOUNT)).toEqual({ changed: 0, examined: 0 });
    expect(period()).toEqual({ reconciliation: "accepted", gapCents: 15_000 });
  });

  /*
   * ⛔ The branch that matters most after pass 73, and the one the cash tests
   * above cannot reach. `rebuildAccount` returns EARLY for an investment
   * account with holding events — Robinhood Brokerage and Robinhood Crypto both
   * take that path — so the re-grade has to be on it too. And an investment
   * verdict's payload is `market_change_cents`, not `gap_cents`: a comparison
   * that only looked at the gap would call a moved market change "unchanged".
   */
  test("an investment account re-grades its market change, on the early-return path", () => {
    const institution = bundle.db.select().from(institutions).all()[0]!;
    const INV = "acct-inv";
    bundle.db
      .insert(accounts)
      .values({ id: INV, institutionId: institution.id, name: "Test Brokerage", type: "investment", subtype: "brokerage" })
      .run();
    bundle.db
      .insert(holdingEvents)
      .values({
        accountId: INV,
        assetType: "stock",
        symbol: "AAPL",
        occurredOn: "2026-02-05",
        quantityDeltaE8: 100_000_000,
        costCents: 20_000,
      })
      .run();
    bundle.db
      .insert(statementPeriods)
      .values({
        id: "period-inv",
        accountId: INV,
        importFileId: FILE,
        periodStart: "2026-02-03",
        periodEnd: "2026-03-02",
        beginningBalanceCents: 100_000,
        endingBalanceCents: 150_000,
        reconciliation: "gap",
      })
      .run();
    const contribution = bundle.db
      .insert(transactions)
      .values({
        id: "txn-inv",
        accountId: INV,
        importFileId: FILE,
        postedOn: "2026-02-10",
        amountCents: 20_000,
        rawDescription: "CONTRIBUTION",
        normalizedDescription: "contribution",
        dedupeHash: "hash-inv",
      })
      .returning({ id: transactions.id })
      .get().id;

    reconcileAccounts(bundle.db, [INV]);
    const invPeriod = () =>
      bundle.db.select().from(statementPeriods).where(eq(statementPeriods.id, "period-inv")).get()!;
    // 150,000 - 100,000 - 20,000 of contribution = 30,000 of market movement
    expect(invPeriod().reconciliation).toBe("value_anchor");
    expect(invPeriod().marketChangeCents).toBe(30_000);

    bundle.db.delete(transactions).where(eq(transactions.id, contribution)).run();
    rebuildAccount(bundle.db, INV, "2026-03-10");

    // with the contribution gone, all $500 of the move is the market
    expect(invPeriod().marketChangeCents).toBe(50_000);
    expect(invPeriod().gapCents).toBeNull();
  });

  test("an unknown account is not an error", () => {
    expect(regradeStatementPeriods(bundle.db, "no-such-account")).toEqual({ changed: 0, examined: 0 });
  });

  /*
   * The point of the whole pass: EVERY path that can change a balance comes
   * through `rebuildAccount`, so none of them can leave a verdict behind.
   */
  test("rebuildAccount re-grades on the way out", () => {
    addPeriod(-31_000);
    const payment = addRow({ postedOn: "2026-02-10", amountCents: 20_000, description: "PAYMENT" });
    const other = addRow({ postedOn: "2026-02-11", amountCents: -1_000, description: "COFFEE" });
    reconcileAccounts(bundle.db, [ACCOUNT]);
    expect(period().reconciliation).toBe("reconciled");

    /*
     * ⚠️ DELETED, not quarantined. `RECONCILE_STATUSES` includes `quarantined`
     * on purpose — it is how a held period can be graded back to closing — so
     * flipping a status changes no sum, and a test that flipped one would have
     * proved nothing while looking like it proved everything.
     */
    bundle.db.delete(transactions).where(eq(transactions.id, payment)).run();
    rebuildAccount(bundle.db, ACCOUNT, "2026-03-10");

    expect(period()).toEqual({ reconciliation: "gap", gapCents: 20_000 });
    // …and a rebuild nobody asked for did not move the surviving row
    expect(statusOf(other)).toBe("active");
  });
});
