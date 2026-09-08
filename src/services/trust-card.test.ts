import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { VERDICT_PRESENTATION } from "@/lib/provenance-verdict";
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
    expect(card.days.uncheckedSharePct).toBeNull();
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
    expect(card.days.uncheckedSharePct).toBeGreaterThan(0);
    expect(card.days.uncheckedSharePct).toBeLessThan(0.1);
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
