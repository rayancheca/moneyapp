import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { holdingEvents } from "@/db/schema/holding-events";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { VERDICT_PRESENTATION } from "@/lib/provenance-verdict";
import { addManualAnchor } from "./anchors";
import { createCashWallet } from "./cash-wallets";
import { rebuildAccount } from "./derivation";
import { addManualTransaction } from "./manual-transactions";
import { provenanceFor } from "./provenance";
import { trustCard } from "./trust-card";

/**
 * The card that says how much of the app is standing on a document.
 *
 * Its failure mode is not a wrong number — it is a REASSURING one. A card that
 * quietly calls carried days unchecked, or an empty account a hole, teaches the
 * reader to stop reading the badge, and then the whole provenance layer is
 * worth less than nothing. So the honest answers are pinned as hard as the
 * confident ones, and both directions of every judgement have a test.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;

const TODAY = "2026-08-26";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-trust-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();
let order = 0;

function addAccount(id: string, name: string, type: string): string {
  order += 1;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: type as never,
      currency: "USD",
      isActive: true,
      displayOrder: order,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function addDays(accountId: string, rows: { day: string; basis: string }[]): void {
  for (const r of rows) {
    bundle.db
      .insert(dailyBalances)
      .values({ accountId, day: r.day, balanceCents: 1000, basis: r.basis as never })
      .run();
  }
}

let txnSeq = 0;
function addTxn(accountId: string, day: string, opts: { cents?: number; status?: string } = {}): string {
  txnSeq += 1;
  const id = `txn-${txnSeq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: opts.cents ?? -1234,
      rawDescription: "COFFEE",
      normalizedDescription: "COFFEE",
      status: (opts.status ?? "active") as never,
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

/** A balance recorded for an account on a day — a statement's, or one he typed (`manual`). */
function addAnchor(accountId: string, day: string, source: "statement" | "manual"): void {
  bundle.db
    .insert(balanceAnchors)
    .values({ accountId, anchoredOn: day, balanceCents: 1000, source, createdAt: now(), updatedAt: now() })
    .run();
}

/** An account whose chain closes: anchored, derived, and a row to replay. */
function addVerifiedAccount(id: string, name: string): string {
  addAccount(id, name, "checking");
  addDays(id, [
    { day: "2026-08-01", basis: "anchored" },
    { day: "2026-08-02", basis: "derived" },
  ]);
  addTxn(id, "2026-08-02");
  return id;
}

const groupOf = (card: NonNullable<ReturnType<typeof trustCard>>, grade: string) =>
  card.groups.find((g) => g.grade === grade);

/* ── the empty path ───────────────────────────────────────────────────── */

describe("trustCard — when there is nothing to be honest about", () => {
  test("returns null with no accounts at all, rather than a card of zeroes", () => {
    expect(trustCard(bundle.db, TODAY)).toBeNull();
  });

  test("one account is enough to publish a card", () => {
    addVerifiedAccount("a", "Chase Checking");
    expect(trustCard(bundle.db, TODAY)).not.toBeNull();
  });
});

/* ── the division guard ───────────────────────────────────────────────── */

describe("trustCard — division guards", () => {
  /**
   * An account with no derived days at all makes the unchecked share `0 / 0`,
   * which is NaN and renders as "NaN% of them" — the exact shape of the
   * "Infinity×" defect the house rule exists to prevent.
   */
  test("no derived days at all publishes no share, not NaN", () => {
    addAccount("a", "Capital One 360 Checking", "checking");
    const card = trustCard(bundle.db, TODAY)!;

    expect(card.days.total).toBe(0);
    expect(card.days.restOnNothingSharePct).toBeNull();
    expect(card.days.sentence).not.toMatch(/NaN|Infinity/);
    expect(card.days.sentence).toContain("No day of balances has been derived yet");
  });

  /**
   * A remainder that rounds to "0.0%" reads as none, and none is the one thing
   * it is not. 1 unchecked day in 2,000 is 0.05% — real, and worth a word that
   * does not say zero.
   */
  test("a share too small to print is named, never rounded away to 0.0%", () => {
    addAccount("b", "SoFi Checking", "checking");
    addTxn("b", "2020-01-02");
    addDays(
      "b",
      Array.from({ length: 1999 }, (_, i) => ({ day: isoFromIndex(i), basis: "derived" })),
    );
    addDays("b", [{ day: isoFromIndex(1999), basis: "derived_unverified" }]);

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.days.total).toBe(2000);
    expect(card.days.unchecked).toBe(1);
    expect(card.days.restOnNothingSharePct).toBeGreaterThan(0);
    expect(card.days.restOnNothingSharePct).toBeLessThan(0.1);
    expect(card.days.sentence).toContain("under 0.1%");
    expect(card.days.sentence).not.toContain("0.0%");
  });
});

function isoFromIndex(i: number): string {
  const base = Date.UTC(2020, 0, 1) + i * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/* ── grouping, and the vocabulary it borrows ──────────────────────────── */

describe("trustCard — groups speak the badges' language", () => {
  test("each group wears VERDICT_PRESENTATION's own word, glyph and tone", () => {
    addVerifiedAccount("a", "Chase Checking");
    addAccount("b", "Robinhood Brokerage", "investment");
    addDays("b", [{ day: "2026-08-01", basis: "derived" }]);

    const card = trustCard(bundle.db, TODAY)!;
    const verified = groupOf(card, "verified")!;
    const market = groupOf(card, "market_value")!;

    expect(verified.word).toBe(VERDICT_PRESENTATION.derived.word);
    expect(verified.icon).toBe(VERDICT_PRESENTATION.derived.icon);
    expect(verified.tone).toBe(VERDICT_PRESENTATION.derived.tone);
    expect(market.word).toBe(VERDICT_PRESENTATION.market_value.word);
    expect(market.tone).toBe(VERDICT_PRESENTATION.market_value.tone);
  });

  test("the weakest footing is listed first", () => {
    addVerifiedAccount("a", "Chase Checking");
    addAccount("b", "Robinhood Cash", "checking");
    addDays("b", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
    ]);
    addTxn("b", "2026-08-02");
    addAccount("c", "SoFi Checking", "checking");
    addDays("c", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
    ]);
    addTxn("c", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.groups.map((g) => g.grade)).toEqual(["broken", "unverified", "verified"]);
    expect(card.groups[0]!.word).toBe(VERDICT_PRESENTATION.broken.word);
  });

  test("the account clause is provenance's own, never re-worded here", () => {
    addVerifiedAccount("a", "Chase Checking");
    const card = trustCard(bundle.db, TODAY)!;
    const nw = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;

    const line = groupOf(card, "verified")!.accounts[0]!;
    expect(line.detail).toBe(nw.inputs.find((i) => i.label === "Chase Checking")!.detail);
  });

  test("the headline is the same figure the net-worth badge shows", () => {
    addVerifiedAccount("a", "Chase Checking");
    addVerifiedAccount("b", "SoFi Checking");
    addAccount("c", "Robinhood Brokerage", "investment");
    addDays("c", [{ day: "2026-08-01", basis: "derived" }]);

    const card = trustCard(bundle.db, TODAY)!;
    const nw = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;

    expect(card.headline).toBe("2 of 3");
    expect(nw.badgeWord).toBe(`${card.headline} add up`);
    expect(card.verdict).toBe(nw.verdict);
  });

  /**
   * The headline and provenance's sentence are the same claim, and the card
   * would otherwise print it twice — once in 30px and once in 12px. The
   * sentence must be provenance's own words with that opening REMOVED, never
   * a paraphrase, so reassembling the two has to give the original back.
   */
  test("the sentence is provenance's, minus the clause the headline already says", () => {
    addVerifiedAccount("a", "Chase Checking");
    addVerifiedAccount("b", "SoFi Checking");
    addAccount("c", "Robinhood Brokerage", "investment");
    addDays("c", [{ day: "2026-08-01", basis: "derived" }]);
    // a holding prices it — with no holding events the clause reads "held at its recorded balance"
    bundle.db
      .insert(holdingEvents)
      .values({
        id: "he-c",
        accountId: "c",
        symbol: "AAPL",
        assetType: "stock",
        occurredOn: "2026-08-01",
        quantityDeltaE8: 100_000_000,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    const card = trustCard(bundle.db, TODAY)!;
    const nw = provenanceFor(bundle.db, { kind: "netWorth", day: TODAY })!;

    expect(card.summary).not.toContain(card.headline);
    expect(card.summary).toContain("priced from holdings");
    expect(`${card.headline} ${card.headlineNoun}, ${card.summary}`).toBe(nw.headline);
  });

  test("with every account checked the sentence still carries the weakest-part rule", () => {
    addVerifiedAccount("a", "Chase Checking");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.headline).toBe("1 of 1");
    // ⛔ provenance says "accounts add up" at every count; the card must not
    // invent a singular the badge beside net worth does not use
    expect(card.headlineNoun).toBe("accounts add up against a document");
    expect(card.summary).toBe("A total is only as proven as its weakest part.");
  });
});

/* ── ⛔ carried is not a weakness ─────────────────────────────────────── */

describe("trustCard — carried days", () => {
  /**
   * `deriveForward` writes `sawTxn ? "derived_unverified" : "carried"`, so a
   * carried day is one where nothing happened and the proven balance still
   * stands. Counting it as unchecked made an earlier draft of the provenance
   * service announce "0 of 12 accounts add up" on a ledger with zero gap days,
   * and this card counts days for a living.
   */
  test("an account of nothing but carried days still adds up and carries no unchecked days", () => {
    addAccount("a", "Chase Checking", "checking");
    addDays("a", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "carried" },
      { day: "2026-08-03", basis: "carried" },
    ]);
    addTxn("a", "2026-08-01");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.headline).toBe("1 of 1");
    expect(card.days.carried).toBe(2);
    expect(card.days.unchecked).toBe(0);
    expect(groupOf(card, "verified")!.accounts[0]!.uncheckedDays).toBe(0);
    expect(card.days.sentence).toContain("rests on a chain that closes");
    expect(card.days.carriedNote).toContain("not a gap");
  });
});

/* ── ⛔ a day on his count is not a chain that closes ─────────────────── */

describe("trustCard — days that rest on his count", () => {
  /*
   * 🔴 HIS COUNT, CALLED A CHAIN THAT CLOSES. The card counted a day unchecked only when it was `derived_unverified`
   * or `gap`, so a wallet resting on nothing but his counts read "Every one of 66 days of balances rests on a chain
   * that closes." beside its own line "you counted it on Aug 20, 2026, and nothing else checks it" and its Aug 15
   * balance proof "Both are your own counts, so nothing else confirms Cash on Hand" (temp ledger through the real
   * services at ef8b764 and 2295ab8, review 2026-10-06). ⚖️ ONE verb for a balance he typed, "counted" (his answer,
   * 2026-10-05).
   */
  test("a wallet that rests on nothing but his counts says so, never 'a chain that closes'", () => {
    const id = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-04", openingBalanceCents: 500_000 });
    addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-08-11", amountCents: -500_000, description: "Car" });
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-08-20", enteredCents: 0 });

    const card = trustCard(bundle.db, "2026-09-16")!;
    // the rebuild carries his count to the real clock's today, so the total is read rather than pinned
    const total = card.days.total.toLocaleString("en-US");
    expect(card.days.unchecked).toBe(0);
    expect(card.days.counted).toBe(card.days.total);
    expect(card.days.sentence).toBe(
      `Every one of ${total} days of balances rests on a balance you counted — ${total} in Cash on Hand — your word, not a check. No day rests on nothing, and none fails to add up.`,
    );
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-15" })!.headline).toMatch(
      /Both are your own counts, so nothing else confirms Cash on Hand on Aug 15, 2026\.$/,
    );
  });

  /*
   * 🔴 …and of a value he typed on an investment account no holding prices: "Every one of 33 days of balances rests
   * on a chain that closes." beside the summary's "1 is held at a balance you counted" (same review). A statement's
   * value held flat is not his count.
   */
  test("a value he typed on an investment account is his count too; a statement's is not", () => {
    addVerifiedAccount("chk", "Chase Checking");
    addAccount("brk", "Brokerage", "investment");
    addAnchor("brk", "2026-08-01", "manual");
    addDays("brk", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "carried" },
    ]);
    addAccount("ira", "Old IRA", "investment");
    addAnchor("ira", "2026-08-01", "statement");
    addDays("ira", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "carried" },
    ]);

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.days.counted).toBe(2);
    expect(card.days.sentence).toBe(
      "2 of 6 days of balances (33.3% of them) rest on a balance you counted — 2 in Brokerage — your word, not a check. No day rests on nothing, and none fails to add up.",
    );
  });

  /*
   * ⛔ A count of his that a replay from a statement lands on IS checked (`chainFooting`), and so is a day carried
   * from it — those days do rest on a chain that closes.
   */
  test("a count of his that a closed replay lands on is a check, not his word alone", () => {
    addAccount("chk", "Chase Checking", "checking");
    addAnchor("chk", "2026-08-01", "statement");
    addAnchor("chk", "2026-08-03", "manual");
    addDays("chk", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "carried" },
    ]);
    addTxn("chk", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.days.counted).toBe(0);
    expect(card.days.sentence).toBe("Every one of 4 days of balances rests on a chain that closes.");
  });
});

/* ── ⛔ an empty account is not a hole ────────────────────────────────── */

describe("trustCard — empty accounts versus holes", () => {
  test("an account with no rows and no balance is set aside, not sorted above real weakness", () => {
    addAccount("a", "Capital One 360 Checking", "checking");
    addAccount("b", "Robinhood Cash", "checking");
    addDays("b", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
    ]);
    addTxn("b", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.emptyAccounts.map((a) => a.name)).toEqual(["Capital One 360 Checking"]);
    expect(card.groups.some((g) => g.accounts.some((a) => a.name === "Capital One 360 Checking"))).toBe(false);
    // the loudest thing on the card is the account with unchecked days, not the
    // empty shelf that `unknown` would otherwise sort above it
    expect(card.groups[0]!.grade).toBe("unverified");
    expect(card.emptyNote).toContain("nothing missing");
    // still counted, so the headline matches the badge's denominator
    expect(card.accountsCounted).toBe(2);
  });

  test("an account with rows and no balance IS a hole, and says so", () => {
    addAccount("a", "Wells Fargo Everyday Checking", "checking");
    addTxn("a", "2026-08-20");
    addTxn("a", "2026-08-21");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.emptyAccounts).toEqual([]);
    const line = groupOf(card, "unknown")!.accounts[0]!;
    expect(line.isHole).toBe(true);
    expect(line.isEmpty).toBe(false);
    expect(line.strandedRows).toBe(2);
    expect(line.detail).toContain("no recorded balance");
  });

  /**
   * The other direction, and the one a mutation caught missing: a hole is
   * rows WITHOUT a balance. An account whose chain closes holds as many rows as
   * it likes and is in every total, so labelling it "not in any total" would
   * put the card's loudest warning on its healthiest account.
   */
  test("an account with a balance is never a hole, however many rows it holds", () => {
    addVerifiedAccount("a", "Chase Checking");
    addTxn("a", "2026-08-02");
    addTxn("a", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    const line = groupOf(card, "verified")!.accounts[0]!;
    expect(line.strandedRows).toBe(0);
    expect(line.isHole).toBe(false);
  });

  /**
   * ⛔ The refund trap, in this card's currency.
   *
   * The obvious query for "does this account hold anything" is
   * `WHERE amount_cents < 0`, and it is wrong for the same reason it is wrong
   * for spending: an inflow is a real row. An account whose only rows are a
   * refund and a deposit would read EMPTY under that filter, and a hole full of
   * money would be reported as a shelf with nothing on it.
   */
  test("an inflow-only account is a hole, not an empty shelf", () => {
    addAccount("a", "Wells Fargo Everyday Checking", "checking");
    addTxn("a", "2026-08-20", { cents: 240000 });
    addTxn("a", "2026-08-21", { cents: 1550 });

    const card = trustCard(bundle.db, TODAY)!;
    const line = groupOf(card, "unknown")!.accounts[0]!;
    expect(line.strandedRows).toBe(2);
    expect(line.isHole).toBe(true);
    expect(card.emptyAccounts).toEqual([]);
  });

  /**
   * `excluded` hides a row from analytics and NOT from the balance replay —
   * pass 59 found a fabricated plug living in exactly that gap. An account
   * holding only excluded rows is still money no total can see.
   */
  test("excluded rows still count as rows", () => {
    addAccount("a", "Wells Fargo Everyday Checking", "checking");
    addTxn("a", "2026-08-20", { status: "excluded" });

    const card = trustCard(bundle.db, TODAY)!;
    expect(groupOf(card, "unknown")!.accounts[0]!.strandedRows).toBe(1);
  });
});

/* ── how far the picture is checked ───────────────────────────────────── */

describe("trustCard — checked through", () => {
  test("the oldest verified date bounds the whole picture, not the newest", () => {
    addAccount("a", "SoFi Checking", "checking");
    addDays("a", [
      { day: "2026-07-30", basis: "anchored" },
      { day: "2026-07-31", basis: "derived" },
    ]);
    addTxn("a", "2026-07-31");
    addAccount("b", "Chase Checking", "checking");
    addDays("b", [
      { day: "2026-08-24", basis: "anchored" },
      { day: "2026-08-25", basis: "derived" },
    ]);
    addTxn("b", "2026-08-25");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.checkedThrough).toBe("2026-07-31");
    expect(card.daysSinceChecked).toBe(26);
    expect(card.checkedThroughAgo).toBe("26 days ago");
  });

  /*
   * 🔴 A BALANCE HE TYPED BOUNDED THE PICTURE. Cash on Hand's only balance is
   * one he counted on Aug 3, 2026 (real ledger, measured 2026-09-16), and every
   * `anchored` day counted as a closed chain — so it entered "the first account
   * that stops being checked" as if checked through Aug 3. Not live there only
   * because SoFi's Jul 31 is older; with every other account newer, this card
   * read "checked through Aug 3, 2026" of his own count.
   */
  test("a balance he typed is not a day the picture was checked through", () => {
    addAccount("coh", "Cash on Hand", "checking");
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: "coh", anchoredOn: "2026-08-03", balanceCents: 500000, source: "manual", createdAt: now(), updatedAt: now() })
      .run();
    addDays("coh", [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-10", basis: "carried" },
      { day: "2026-08-11", basis: "derived_unverified" },
    ]);
    addTxn("coh", "2026-08-11");
    addAccount("b", "Chase Checking", "checking");
    addDays("b", [
      { day: "2026-08-24", basis: "anchored" },
      { day: "2026-08-25", basis: "derived" },
    ]);
    addTxn("b", "2026-08-25");

    /*
     * 🔴 …and leaving it out of the comparison let the date run past the day this
     * card calls unchecked: "checked through Aug 25" over "nothing checks it
     * since Aug 11". His count stands through Aug 10, so that is the bound, and
     * the card's sentence says whose word it is.
     */
    const card = trustCard(bundle.db, TODAY)!;
    expect(card.checkedThrough).toBe("2026-08-10");
    const line = card.groups.flatMap((g) => g.accounts).find((a) => a.name === "Cash on Hand")!;
    expect(line.detail).toBe("you counted it on Aug 3, 2026, and nothing checks it since Aug 11, 2026");
    expect(card.summary).toMatch(
      /The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/,
    );
  });

  /*
   * 🔴 …AND A RECOUNT THAT DOES NOT ADD UP DATED IT PAST ITS BREAK. The count's rule took a broken wallet as if his
   * count still stood: "checked through" the day before the run open past the recount, beside its own line "stopped
   * adding up on Aug 4, 2026" (temp ledger through the real services, 2026-10-05). ⚖️ His answer, 2026-10-05: it
   * bounds the picture the day before it broke, and the sentence says it broke after that.
   */
  test("a wallet whose recount does not add up bounds the picture the day before it broke, and says so", () => {
    addAccount("coh", "Cash on Hand", "checking");
    for (const day of ["2026-08-03", "2026-08-20"]) {
      bundle.db
        .insert(balanceAnchors)
        .values({ accountId: "coh", anchoredOn: day, balanceCents: 500000, source: "manual", createdAt: now(), updatedAt: now() })
        .run();
    }
    addDays("coh", [
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "gap" },
      { day: "2026-08-11", basis: "gap" },
      { day: "2026-08-20", basis: "anchored" },
      { day: "2026-08-21", basis: "carried" },
      { day: "2026-08-24", basis: "derived_unverified" },
    ]);
    addTxn("coh", "2026-08-11");
    addTxn("coh", "2026-08-24");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.checkedThrough).toBe("2026-08-03");
    const line = card.groups.flatMap((g) => g.accounts).find((a) => a.name === "Cash on Hand")!;
    expect(line.detail).toBe("stopped adding up on Aug 4, 2026");
    expect(card.summary).toMatch(
      / The date it is checked through, Aug 3, 2026, is the last day before Cash on Hand stopped adding up on Aug 4, 2026; until then it rests on the balance you counted on Aug 3, 2026 — your word, not a check\.$/,
    );
  });

  test("nothing verified means no date at all, never today", () => {
    addAccount("a", "Robinhood Cash", "checking");
    addDays("a", [{ day: "2026-08-02", basis: "derived_unverified" }]);
    addTxn("a", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.checkedThrough).toBeNull();
    expect(card.daysSinceChecked).toBeNull();
    expect(card.checkedThroughAgo).toBeNull();
  });

  /**
   * 🔴 The card printed `${daysSinceChecked} days ago`, so the two states an
   * up-to-date ledger actually reaches read "0 days ago" and "1 days ago" —
   * the exact pair `agoPhrase` exists to refuse, and the exact pair the
   * unchecked-days row six lines above this sentence already gets right.
   */
  test("a picture checked through yesterday is one day old, not '1 days'", () => {
    addAccount("a", "SoFi Checking", "checking");
    addDays("a", [{ day: "2026-08-25", basis: "anchored" }]);
    addTxn("a", "2026-08-25");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.daysSinceChecked).toBe(1);
    expect(card.checkedThroughAgo).toBe("1 day ago");
  });

  test("a picture checked through today is not aged at all", () => {
    addAccount("a", "SoFi Checking", "checking");
    addDays("a", [{ day: TODAY, basis: "anchored" }]);
    addTxn("a", TODAY);

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.daysSinceChecked).toBe(0);
    expect(card.checkedThroughAgo).toBe("today");
  });
});

/* ── the unchecked days, named ────────────────────────────────────────── */

describe("trustCard — the unchecked days", () => {
  test("derived_unverified and gap are counted together and told apart", () => {
    addAccount("a", "Robinhood Cash", "checking");
    addDays("a", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
      { day: "2026-08-03", basis: "derived_unverified" },
    ]);
    addTxn("a", "2026-08-02");
    addAccount("b", "Cash on Hand", "checking");
    addDays("b", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
    ]);
    addTxn("b", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.days.derivedUnverified).toBe(2);
    expect(card.days.gap).toBe(1);
    expect(card.days.unchecked).toBe(3);
    expect(card.uncheckedByAccount).toEqual([
      { name: "Robinhood Cash", days: 2 },
      { name: "Cash on Hand", days: 1 },
    ]);
    // a break must not hide inside a backlog of unimported statements
    expect(card.days.sentence).toContain("1 of them provably does not add up");
  });

  /*
   * 🔴 HIS COUNT, CALLED A RECORDED BALANCE. A wallet whose $40.00 recount for Sep 1 does not add up read "28 of them
   * provably do not add up: the replay missed the next recorded balance." (temp ledger through the real services,
   * 2026-10-06), while every one of those 28 days' own balance proof reads "The replay did NOT land on Cash on Hand's
   * next balance, the one you counted on Sep 1, 2026." ⚖️ ONE verb for a balance he typed, "counted" (his answer,
   * 2026-10-05); a statement's balance keeps its words.
   */
  test("a replay that missed his count says the balance it missed is one he counted, as that day's proof does", () => {
    const id = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-04", openingBalanceCents: 500_000 });
    addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-08-11", amountCents: -500_000, description: "Car" });
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-09-01", enteredCents: 4_000 });
    addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-09-10", amountCents: -1_000, description: "Lunch" });

    const card = trustCard(bundle.db, "2026-09-16")!;
    expect(card.days.gap).toBe(28);
    expect(card.days.sentence).toMatch(
      / 28 of them provably do not add up: the replay missed the next balance, the one you counted on Sep 1, 2026\.$/,
    );
    expect(provenanceFor(bundle.db, { kind: "accountBalance", accountId: id, day: "2026-08-20" })!.headline).toMatch(
      /^The replay did NOT land on Cash on Hand's next balance, the one you counted on Sep 1, 2026\./,
    );
  });

  test("a replay that missed a statement's balance keeps its words", () => {
    addAccount("chase", "Chase Checking", "checking");
    addAnchor("chase", "2026-08-01", "statement");
    addAnchor("chase", "2026-08-03", "statement");
    addDays("chase", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
      { day: "2026-08-03", basis: "anchored" },
    ]);
    addTxn("chase", "2026-08-02");

    expect(trustCard(bundle.db, TODAY)!.days.sentence).toMatch(
      / 1 of them provably does not add up: the replay missed the next recorded balance\.$/,
    );
  });

  test("replays that missed several of his counts say so without naming one of them", () => {
    addAccount("coh", "Cash on Hand", "checking");
    for (const day of ["2026-08-01", "2026-08-03", "2026-08-05"]) addAnchor("coh", day, "manual");
    addDays("coh", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
      { day: "2026-08-03", basis: "anchored" },
      { day: "2026-08-04", basis: "gap" },
      { day: "2026-08-05", basis: "anchored" },
    ]);
    addTxn("coh", "2026-08-02");
    addTxn("coh", "2026-08-04");

    expect(trustCard(bundle.db, TODAY)!.days.sentence).toMatch(
      / 2 of them provably do not add up: the replay missed the next balance you counted\.$/,
    );
  });

  test("a statement's balance and his count, both missed, are each named in their own words", () => {
    addAccount("chase", "Chase Checking", "checking");
    addAnchor("chase", "2026-08-01", "statement");
    addAnchor("chase", "2026-08-03", "statement");
    addDays("chase", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
      { day: "2026-08-03", basis: "anchored" },
    ]);
    addTxn("chase", "2026-08-02");
    addAccount("coh", "Cash on Hand", "checking");
    addAnchor("coh", "2026-08-01", "manual");
    addAnchor("coh", "2026-08-05", "manual");
    addDays("coh", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "gap" },
      { day: "2026-08-05", basis: "anchored" },
    ]);
    addTxn("coh", "2026-08-02");

    expect(trustCard(bundle.db, TODAY)!.days.sentence).toMatch(
      / 2 of them provably do not add up: the replay missed the next recorded balance, or the one you counted on Aug 5, 2026\.$/,
    );
  });

  test("with nothing broken the card says so rather than leaving it ambiguous", () => {
    addAccount("a", "Robinhood Cash", "checking");
    addDays("a", [
      { day: "2026-08-01", basis: "anchored" },
      { day: "2026-08-02", basis: "derived_unverified" },
    ]);
    addTxn("a", "2026-08-02");

    const card = trustCard(bundle.db, TODAY)!;
    expect(card.days.gap).toBe(0);
    expect(card.days.sentence).toContain("No day provably fails to add up");
  });
});

/* ── ⚖️ the days before a first balance ───────────────────────────────── */

/*
 * ⚖️ His answer, 2026-10-05 (§6A 35): days BEFORE an account's first balance — replayed backwards
 * from it, with nothing earlier to check them against — do not on their own make it one nothing
 * is checking. Measured on a copy of his ledger: Robinhood Agentic (26 such days, Jun 4–29, first
 * balance Jun 30, closed through Aug 31, no run open) graded `unverified` on them alone, so net
 * worth read "3 have nothing checking them" — Cash on Hand, Robinhood Cash and Agentic — of a
 * balance three reconciled statements stand on. Under his rule only Agentic moves, and it keeps
 * naming those days. Built through the rebuild, in those three shapes.
 */
describe("trustCard — the days before a first balance do not grade an account", () => {
  function anchorAt(accountId: string, day: string, source: "statement" | "manual"): void {
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId, anchoredOn: day, balanceCents: 500_000, source, createdAt: now(), updatedAt: now() })
      .run();
  }
  /** three statements that agree, the row that funded it before the first, and maybe a later row */
  function statementAccount(id: string, name: string, laterRow: string | null): void {
    addAccount(id, name, "checking");
    for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) anchorAt(id, day, "statement");
    addTxn(id, "2026-06-05");
    if (laterRow !== null) addTxn(id, laterRow);
    rebuildAccount(bundle.db, id, "2026-09-15");
  }

  test("Robinhood Agentic adds up, still named with its unchecked days; two have nothing checking them", () => {
    statementAccount("agentic", "Robinhood Agentic", null);
    // a run open past its newest statement, as Robinhood Cash's is from Sep 1
    statementAccount("rh-cash", "Robinhood Cash", "2026-09-05");
    // his count, and a row he entered after it
    addAccount("coh", "Cash on Hand", "checking");
    anchorAt("coh", "2026-08-03", "manual");
    addTxn("coh", "2026-08-11");
    rebuildAccount(bundle.db, "coh", "2026-09-15");

    const nw = provenanceFor(bundle.db, { kind: "netWorth", day: "2026-10-01" })!;
    expect(nw.headline).toContain("1 of 3 accounts add up against a document, 2 have nothing checking them.");
    const card = trustCard(bundle.db, "2026-10-01")!;
    expect(card.headline).toBe("1 of 3");
    // most unchecked days first: 37 (26 before its first balance, 11 open) and 36 since Aug 11
    expect(groupOf(card, "unverified")!.accounts.map((a) => a.name)).toEqual(["Robinhood Cash", "Cash on Hand"]);
    expect(groupOf(card, "verified")!.accounts).toEqual([
      expect.objectContaining({
        name: "Robinhood Agentic",
        verdict: "derived",
        detail: "adds up through Aug 31, 2026, and unchecked days before that",
        uncheckedDays: 26,
      }),
    ]);
  });

  /*
   * ⚖️ His answer, 2026-10-05: its line reads with its group's verb. Under "adds up" Agentic read
   * "checked through Aug 31, 2026, and unchecked days before that" beside "adds up through Aug 31,
   * 2026" of an account the same statements check — two verbs for one fact in one list.
   */
  test("under 'adds up', its line has its neighbours' verb, and only the days before set it apart", () => {
    statementAccount("agentic", "Robinhood Agentic", null);
    // the same three statements, and no row before the first of them: a charge and its refund in July
    addAccount("twin", "Twin", "checking");
    for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) anchorAt("twin", day, "statement");
    addTxn("twin", "2026-07-10", { cents: -1_234 });
    addTxn("twin", "2026-07-15", { cents: 1_234 });
    rebuildAccount(bundle.db, "twin", "2026-09-15");

    const verified = groupOf(trustCard(bundle.db, "2026-10-01")!, "verified")!.accounts;
    const lineOf = (name: string) => verified.find((a) => a.name === name)!.detail;
    expect(lineOf("Twin")).toBe("adds up through Aug 31, 2026");
    expect(lineOf("Robinhood Agentic")).toBe(`${lineOf("Twin")}, and unchecked days before that`);
  });

  /*
   * 🔴 The footer was the second reader of the same count, and it still read it the old way (review of
   * 2deb764): every account's unchecked days went into one sentence — "… rest on nothing — 37 in
   * Robinhood Cash, 36 in Cash on Hand, 26 in Robinhood Agentic" — painted amber, while Agentic's row
   * above it carried the same 26 quietly under "adds up". A verified account's days, every one before
   * its first balance, are a note of their own now; the sentence counts and names the rest.
   */
  test("the footer's sentence names what nothing checks; a verified account's days before are a note", () => {
    statementAccount("agentic", "Robinhood Agentic", null);
    statementAccount("rh-cash", "Robinhood Cash", "2026-09-05");
    addAccount("coh", "Cash on Hand", "checking");
    anchorAt("coh", "2026-08-03", "manual");
    addTxn("coh", "2026-08-11");
    rebuildAccount(bundle.db, "coh", "2026-09-15");

    const { days } = trustCard(bundle.db, "2026-10-01")!;
    // every unchecked day is still counted: the identity `derivedUnverified + gap` holds
    expect(days.unchecked).toBe(26 + 37 + 36);
    expect(days.beforeFirstBalance).toBe(26);
    expect(days.restOnNothing).toBe(37 + 36);
    expect(days.restOnNothingSharePct).toBeCloseTo((73 / days.total) * 100, 10);
    expect(days.sentence).toContain(
      `73 of ${days.total} days of balances (${((73 / days.total) * 100).toFixed(1)}% of them) rest on nothing — ` +
        "37 in Robinhood Cash, 36 in Cash on Hand.",
    );
    expect(days.sentence).not.toContain("Robinhood Agentic");
    expect(days.beforeFirstBalanceNote).toBe(
      "Robinhood Agentic's 26 days before its first balance are unchecked — replayed backwards from it, " +
        "with nothing earlier to check them against, and not days its balance rests on.",
    );
  });

  test("with every account adding up, nothing rests on nothing: the days before are the note alone", () => {
    statementAccount("agentic", "Robinhood Agentic", null);
    statementAccount("sofi", "SoFi Savings", null);

    const card = trustCard(bundle.db, "2026-10-01")!;
    expect(card.groups.map((g) => g.grade)).toEqual(["verified"]);
    const { days } = card;
    expect(days.unchecked).toBe(52);
    expect(days.restOnNothing).toBe(0);
    expect(days.sentence).toBe(
      `Every one of ${days.total - 52} days of balances from each account's first balance on rests on a chain ` +
        "that closes.",
    );
    expect(days.beforeFirstBalanceNote).toBe(
      "52 days before an account's first balance are unchecked — 26 in Robinhood Agentic, 26 in SoFi Savings — " +
        "replayed backwards from it, with nothing earlier to check them against, and not days its balance rests on.",
    );
  });

  /*
   * ⚖️ Both answers at once (§6A 33 and 35, his, 2026-10-05): with nothing resting on nothing, the days on his count
   * are said as counted — never "a chain that closes" — and a verified account's days before its first balance stay
   * the note's, out of the sentence's count.
   */
  test("his count and a verified account's days before its first balance: counted, and said apart", () => {
    statementAccount("agentic", "Robinhood Agentic", null);
    const id = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-04", openingBalanceCents: 500_000 });
    addManualTransaction(bundle.db, { accountId: id, postedOn: "2026-08-11", amountCents: -500_000, description: "Car" });
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-08-20", enteredCents: 0 });

    const { days } = trustCard(bundle.db, "2026-09-16")!;
    expect(days.restOnNothing).toBe(0);
    expect(days.beforeFirstBalance).toBe(26);
    expect(days.counted).toBeGreaterThan(0);
    const closing = days.total - 26;
    const share = ((days.counted / closing) * 100).toFixed(1);
    const counted = days.counted.toLocaleString("en-US");
    expect(days.sentence).toBe(
      `${counted} of ${closing.toLocaleString("en-US")} days of balances from each account's first balance on ` +
        `(${share}% of them) rest on a balance you counted — ${counted} in Cash on Hand — your word, not a check. ` +
        "No day rests on nothing, and none fails to add up.",
    );
    expect(days.sentence).not.toContain("a chain that closes");
    expect(days.beforeFirstBalanceNote).toMatch(/^Robinhood Agentic's 26 days before its first balance are unchecked/);
  });
});
