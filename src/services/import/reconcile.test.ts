import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
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
      status: "imported",
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
