import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase, type DbBundle } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { TOP_ROUTES, transfersCard, type TransfersCard } from "./transfers-card";

/**
 * The card's job is to separate three populations the `Transfers` total merges
 * — money between the owner's own accounts, money between him and somebody
 * else, and money the pairer has linked versus money it has not — and then to
 * count the first of those ONCE. So the tests that matter are the ones about
 * which rows land in which population, which end of a movement is added up, and
 * what happens when a denominator is empty.
 */

/** today is deliberately mid-month: the window must exclude the current month */
const TODAY = "2026-08-27";

let dir: string;
let bundle: DbBundle;
/** two checking accounts and a card — `Internal Transfer` and `Credit Card Payment` */
let A: string;
let B: string;
let CARD: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-transfers-card-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  A = createAccount(bundle.db, { institutionId: inst.id, name: "Alpha Checking", type: "checking" });
  B = createAccount(bundle.db, { institutionId: inst.id, name: "Bravo Savings", type: "savings" });
  CARD = createAccount(bundle.db, { institutionId: inst.id, name: "Charlie Card", type: "credit" });
  /*
   * ⛔ THE LEDGER HAS TO OPEN ON A MONTH BOUNDARY, or the card's window is not
   * six months long. `baselineWindow` floors at the first month the ledger
   * covers IN FULL — a stub month is not a month — so without this row the
   * earliest leg in a test dates the ledger and the window collapses. It is
   * UNCATEGORISED, so no transfer resolver claims it and no figure moves.
   */
  bundle.db
    .insert(transactions)
    .values({
      accountId: A,
      postedOn: "2025-01-01",
      amountCents: -1,
      rawDescription: "LEDGER OPENS",
      normalizedDescription: "LEDGER OPENS",
      categoryId: null,
      dedupeHash: "h-ledger-opens",
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function transfersTopId(): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Transfers"), isNull(categories.parentId)))
    .get()!.id;
}

function categoryId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, transfersTopId())))
    .get()!.id;
}

let seq = 0;
/** one row, in an explicit category, optionally carrying a transfer group */
function leg(
  accountId: string,
  postedOn: string,
  amountCents: number,
  categoryName: string,
  groupId: string | null = null,
): string {
  seq += 1;
  const raw = `LEG ${seq}`;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: categoryName === "" ? null : categoryId(categoryName),
      transferGroupId: groupId,
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .run();
  return id;
}

/** one clean paired transfer: `cents` leaves `from` and arrives at `to` */
function transfer(
  from: string,
  to: string,
  postedOn: string,
  cents: number,
  groupId: string,
  categoryName = "Internal Transfer",
): void {
  leg(from, postedOn, -cents, categoryName, groupId);
  leg(to, postedOn, cents, categoryName, groupId);
}

const card = (): TransfersCard | null => transfersCard(bundle.db, TODAY);
const cardOrThrow = (): TransfersCard => {
  const c = card();
  expect(c).not.toBeNull();
  return c!;
};

/** every sentence the card publishes, for the copy-level assertions */
function everySentence(c: TransfersCard): string[] {
  return [
    c.headline,
    c.headlineNoun,
    c.summary,
    c.otherRouteNote,
    c.proof.sentence,
    c.proof.mirrorNote,
    c.proof.strandedNote,
    c.churnNote,
    c.arrivalNote,
    c.otherPartyNote,
    ...c.routes.map((r) => `${r.fromLabel} → ${r.toLabel} ${r.countLabel}`),
  ].filter((s): s is string => s !== null);
}

describe("the happy path", () => {
  test("counts the departure once, names the route, and reports what is unpaired", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    transfer(A, CARD, "2026-04-10", 250_00, "g2", "Credit Card Payment");
    // a departure nobody has linked to anything
    leg(A, "2026-05-02", -75_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.movedCents).toBe(825_00);
    expect(c.departureCount).toBe(3);
    expect(c.headline).toBe("$825.00");
    expect(c.headlineNoun).toBe("left one account for another, Feb 2026 to Jul 2026");

    expect(c.routes).toHaveLength(2);
    expect(c.routes[0]).toMatchObject({
      fromLabel: "Alpha Checking",
      toLabel: "Bravo Savings",
      cents: 500_00,
      count: 1,
      countLabel: "1 transfer",
    });
    expect(c.routedCents).toBe(750_00);

    expect(c.proof.linkedCount).toBe(2);
    expect(c.proof.linkedCents).toBe(750_00);
    expect(c.proof.unpairedCount).toBe(1);
    expect(c.proof.unpairedCents).toBe(75_00);
    expect(c.proof.sentence).toContain("2 of 3 departures");
    expect(c.proof.sentence).toContain("$75.00");
  });

  test("the arrival leg of a linked pair is never added to the headline", () => {
    // ⛔ the double-count guard: $500 moved is $500, not $1,000
    transfer(A, B, "2026-03-04", 500_00, "g1");
    expect(cardOrThrow().movedCents).toBe(500_00);
  });

  test("a round trip counts twice, because the money really left twice", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    transfer(B, A, "2026-03-20", 500_00, "g2");

    const c = cardOrThrow();
    expect(c.movedCents).toBe(1000_00);
    // and the card says how much of it came straight back
    expect(c.churnCents).toBe(1000_00);
    expect(c.churnNote).toContain("$1,000.00");
  });

  test("churn is what came BACK, not what was routed", () => {
    // $500 out and $300 back: $800 was routed and $600 of it round-tripped.
    // Quoting the routed total here would be the same sentence with a wrong
    // number, and a symmetric round trip cannot tell the two apart.
    transfer(A, B, "2026-03-04", 500_00, "g1");
    transfer(B, A, "2026-03-20", 300_00, "g2");

    const c = cardOrThrow();
    expect(c.routedCents).toBe(800_00);
    expect(c.churnCents).toBe(600_00);
    expect(c.churnNote).toContain("$600.00");
    expect(c.churnNote).not.toContain("$800.00");
  });

  test("nothing came back: there is no churn clause at all", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    expect(cardOrThrow().churnCents).toBe(0);
    expect(cardOrThrow().churnNote).toBeNull();
  });

  test("counts transfers per route, not rows", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(A, B, "2026-03-05", 200_00, "g2");

    const c = cardOrThrow();
    expect(c.routes).toHaveLength(1);
    expect(c.routes[0]).toMatchObject({ cents: 300_00, count: 2, countLabel: "2 transfers" });
  });
});

describe("the null paths — a card of zeroes is worse than no card", () => {
  test("no transfer rows at all", () => {
    expect(card()).toBeNull();
  });

  test("no `Transfers` taxonomy, so nothing can be a transfer", () => {
    // the guard exists because `transferCategoryResolver` THROWS on a missing
    // category path rather than returning nothing
    bundle.db.delete(categories).where(eq(categories.kind, "transfer")).run();
    expect(card()).toBeNull();
  });

  test("transfer rows exist but nothing departed", () => {
    // every leg is an arrival: the headline would read "$0.00 left one account
    // for another" over $900 of real money
    leg(A, "2026-03-04", 500_00, "Internal Transfer");
    leg(B, "2026-04-04", 400_00, "Internal Transfer");
    expect(card()).toBeNull();
  });

  test("only rows the pairer never stamps — the card is not about them", () => {
    otherPartyCategory();
    leg(A, "2026-03-04", -500_00, "Handshake");
    expect(card()).toBeNull();
  });
});

describe("sign is DIRECTION, not refund-versus-purchase", () => {
  test("an arrival does not net against the departures", () => {
    // the netting bug: -500 + 500 = 0, and every working transfer vanishes
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(B, "2026-03-04", 500_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.movedCents).toBe(500_00);
    expect(c.departureCount).toBe(1);
  });

  test("an unlinked arrival is reported as arriving from nowhere, not as a departure", () => {
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(B, "2026-04-09", 321_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.departureCount).toBe(1);
    expect(c.arrivalCount).toBe(1);
    expect(c.arrivalCents).toBe(321_00);
    expect(c.arrivalNote).toContain("$321.00");
    // ⛔ EMPTY IS NOT MISSING: the money is in the ledger, its other END is not
    expect(c.arrivalNote).not.toMatch(/missing money|unchecked/i);
  });

  test("the arrival leg of a LINKED pair is not reported as arriving from nowhere", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    const c = cardOrThrow();
    expect(c.arrivalCount).toBe(0);
    expect(c.arrivalNote).toBeNull();
  });

  test("no figure the card publishes is ever negative zero", () => {
    // the shape that produced "-$0.00" on this dashboard once: a sign flip over
    // a value that rounds to zero. Every figure here is a magnitude, and this
    // asserts it stays that way.
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(B, "2026-03-04", 500_00, "Internal Transfer");
    otherPartyCategory();
    leg(A, "2026-03-06", -1, "Handshake");
    leg(B, "2026-03-06", 1, "Handshake");

    const c = cardOrThrow();
    for (const sentence of everySentence(c)) expect(sentence).not.toContain("-$");
    for (const n of [
      c.movedCents,
      c.routedCents,
      c.otherRouteCents,
      c.churnCents,
      c.arrivalCents,
      c.proof.linkedCents,
      c.proof.unpairedCents,
      c.proof.mirrorCents,
      c.proof.strandedCents,
    ]) {
      expect(Object.is(n, -0)).toBe(false);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("division guards", () => {
  test("the unpaired share is a finite percentage of the departures", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    leg(A, "2026-05-02", -500_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.proof.unpairedPct).toBe(50);
    expect(Number.isFinite(c.proof.unpairedPct)).toBe(true);
  });

  test("there is no card whose departure count is zero, so the share can never divide by it", () => {
    // the only route to a zero denominator is a window with no departures, and
    // that returns null before the division is reached
    leg(A, "2026-03-04", 500_00, "Internal Transfer");
    expect(card()).toBeNull();
  });

  test("every departure paired: the share is an exact zero and the verdict changes", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");

    const c = cardOrThrow();
    expect(c.proof.unpairedPct).toBe(0);
    expect(c.proof.unpairedCount).toBe(0);
    expect(c.proof.sentence).toContain("Every one of the 1 departure");
    expect(c.proof.mirrorNote).toBeNull();
  });
});

describe("the card's own arithmetic reconciles", () => {
  test("linked + unpaired = moved, routes + other = routed, routed + stranded = linked", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    transfer(A, CARD, "2026-04-10", 250_00, "g2", "Credit Card Payment");
    transfer(B, CARD, "2026-04-11", 120_00, "g3", "Credit Card Payment");
    leg(A, "2026-05-02", -75_00, "Internal Transfer");
    // a group whose partner posted before the window opened
    leg(A, "2026-02-02", -60_00, "Internal Transfer", "g4");
    leg(B, "2026-01-30", 60_00, "Internal Transfer", "g4");

    const c = cardOrThrow();
    expect(c.proof.linkedCents + c.proof.unpairedCents).toBe(c.movedCents);
    expect(c.routes.reduce((s, r) => s + r.cents, 0) + c.otherRouteCents).toBe(c.routedCents);
    expect(c.routedCents + c.proof.strandedCents).toBe(c.proof.linkedCents);
    expect(c.proof.strandedCents).toBeGreaterThanOrEqual(0);
  });

  test("the verdict prints BOTH halves, so a reader can add the card up to the headline", () => {
    // ⛔ the reconciliation has to be legible on screen, not just true in the
    // object: linked + unpaired = the headline, and all three figures are
    // printed. Dropping the linked figure leaves the reader unable to check it.
    transfer(A, B, "2026-03-04", 500_00, "g1");
    leg(A, "2026-05-02", -75_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.headline).toBe("$575.00");
    expect(c.proof.sentence).toContain("$500.00");
    expect(c.proof.sentence).toContain("$75.00");
  });

  test("a link whose partner is outside the window is LINKED, not unpaired", () => {
    // 🔴 a transfer_group_id is not a proof, and its absence is not the same
    // fault: this money did land, just before these months began
    leg(A, "2026-02-02", -60_00, "Internal Transfer", "g1");
    leg(B, "2026-01-30", 60_00, "Internal Transfer", "g1");
    transfer(A, B, "2026-03-04", 500_00, "g2");

    const c = cardOrThrow();
    expect(c.proof.unpairedCount).toBe(0);
    expect(c.proof.linkedCents).toBe(560_00);
    expect(c.routedCents).toBe(500_00);
    expect(c.proof.strandedCents).toBe(60_00);
    expect(c.proof.strandedNote).toContain("$60.00");
  });

  test("routes beyond the cut are summed into one line, never dropped", () => {
    const accounts = [A, B, CARD];
    let group = 0;
    // 7 distinct routes: A→B, A→CARD, B→A, B→CARD, CARD→A, CARD→B is only 6,
    // so add a second month on the largest to keep the cut meaningful
    for (const from of accounts) {
      for (const to of accounts) {
        if (from === to) continue;
        group += 1;
        transfer(from, to, "2026-03-04", group * 100_00, `g${group}`, "Credit Card Payment");
      }
    }

    const c = cardOrThrow();
    expect(c.routes).toHaveLength(TOP_ROUTES);
    expect(c.otherRouteCount).toBe(1);
    expect(c.routes.reduce((s, r) => s + r.cents, 0) + c.otherRouteCents).toBe(c.routedCents);
    expect(c.otherRouteNote).toBe("1 smaller route");
  });
});

describe("what counts as your own accounts", () => {
  /** a transfer-kind category the resolver can never produce */
  function otherParty(): void {
    otherPartyCategory();
  }

  test("a transfer category the pairer never stamps is excluded and reported", () => {
    otherParty();
    transfer(A, B, "2026-03-04", 500_00, "g1");
    leg(A, "2026-03-09", -300_00, "Handshake");
    leg(A, "2026-03-11", 200_00, "Handshake");

    const c = cardOrThrow();
    expect(c.movedCents).toBe(500_00);
    expect(c.departureCount).toBe(1);
    expect(c.otherPartyCount).toBe(2);
    expect(c.otherPartyNote).toContain("2 more transfer rows");
    expect(c.otherPartyNote).toContain("$200.00 in, $300.00 out");
    expect(c.otherPartyNote).toContain("not one of them is paired");
  });

  test("an excluded row that IS paired is reported as paired, not as an absence", () => {
    // ⛔ EMPTY IS NOT A WEAKNESS, and its converse: the clause reports what was
    // measured. Hard-coding "not one of them is paired" would read as a fault
    // on a ledger where the owner had linked some of these by hand.
    otherParty();
    transfer(A, B, "2026-03-04", 500_00, "g1");
    leg(A, "2026-03-09", -300_00, "Handshake", "g9");
    leg(B, "2026-03-09", 300_00, "Handshake", "g9");

    const c = cardOrThrow();
    expect(c.otherPartyCount).toBe(2);
    expect(c.otherPartyNote).toContain("2 of them are paired");
    expect(c.otherPartyNote).not.toContain("not one of them is paired");
    // …and it is still not counted in the headline
    expect(c.movedCents).toBe(500_00);
  });

  test("a row outside the Transfers subtree is not a transfer at all", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    const groceries = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!;
    bundle.db
      .insert(transactions)
      .values({
        id: "spend-1",
        accountId: A,
        postedOn: "2026-03-05",
        amountCents: -900_00,
        rawDescription: "SUPERMARKET",
        normalizedDescription: "SUPERMARKET",
        categoryId: groceries.id,
        status: "active",
        dedupeHash: "h-spend-1",
      })
      .run();

    const c = cardOrThrow();
    expect(c.movedCents).toBe(500_00);
    expect(c.otherPartyCount).toBe(0);
    expect(c.otherPartyNote).toBeNull();
  });
});

describe("the counterpart the app can already see", () => {
  test("an unpaired departure with an exact-amount mirror in another account is named", () => {
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(B, "2026-03-05", 500_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.proof.mirrorCount).toBe(1);
    expect(c.proof.mirrorCents).toBe(500_00);
    expect(c.proof.mirrorNote).toContain("$500.00");
  });

  test("a counterpart of a DIFFERENT amount is not called a mirror", () => {
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(B, "2026-03-05", 499_00, "Internal Transfer");

    const c = cardOrThrow();
    expect(c.proof.mirrorCount).toBe(0);
    expect(c.proof.mirrorNote).toBeNull();
  });

  test("a mirror in the SAME account is not a transfer and is not counted", () => {
    leg(A, "2026-03-04", -500_00, "Internal Transfer");
    leg(A, "2026-03-05", 500_00, "Internal Transfer");
    expect(cardOrThrow().proof.mirrorCount).toBe(0);
  });
});

describe("the window", () => {
  test("the running month is excluded — a part month beside whole ones reads as a fall", () => {
    transfer(A, B, "2026-03-04", 500_00, "g1");
    transfer(A, B, "2026-08-04", 900_00, "g2");

    const c = cardOrThrow();
    expect(c.movedCents).toBe(500_00);
    expect(c.fromMonth).toBe("2026-02");
    expect(c.toMonth).toBe("2026-07");
    expect(c.months).toBe(6);
  });

  test("the window opens on the first day of its first month and closes on the last of its last", () => {
    transfer(A, B, "2026-02-01", 100_00, "g1");
    transfer(A, B, "2026-07-31", 200_00, "g2");
    transfer(A, B, "2026-01-31", 400_00, "g3");

    expect(cardOrThrow().movedCents).toBe(300_00);
  });
});

/**
 * A transfer-kind category the owner added under `Transfers` that
 * `transferCategoryResolver` can never produce — this ledger really has four of
 * them (Reimbursements, Pass-through, Gifts received, Loans).
 */
function otherPartyCategory(): void {
  bundle.db
    .insert(categories)
    .values({
      id: "cat-handshake",
      name: "Handshake",
      parentId: bundle.db
        .select()
        .from(categories)
        .where(and(eq(categories.name, "Transfers"), isNull(categories.parentId)))
        .get()!.id,
      kind: "transfer",
      sortOrder: 99,
    })
    .run();
}
