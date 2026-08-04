import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { balanceAnchors } from "@/db/schema/balances";
import { MIN_FINANCIAL_DATE } from "@/lib/date-window";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { addManualTransaction, isCashWallet } from "./manual-transactions";
import { latestBalances } from "./derivation";
import {
  createCashWallet,
  listCashWallets,
  listCashWalletSummaries,
  setCashWalletOpening,
} from "./cash-wallets";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cash-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createCashWallet", () => {
  test("creates a cash wallet with a $0 opening anchor so the first txn derives a balance", () => {
    const id = createCashWallet(bundle.db, { name: "Wallet", openingOn: "2026-06-01" });

    // it IS a cash wallet, grouped under the find-or-created Cash institution
    expect(isCashWallet(bundle.db, id)).toBe(true);
    expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(1);

    // the deferred bug: without the seeded $0 anchor the first manual txn would
    // derive no balance. With it, spending $20 leaves the wallet at -$20.
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-05",
      amountCents: -2_000,
      description: "Coffee",
    });
    const balance = latestBalances(bundle.db).get(id);
    expect(balance).toBeDefined();
    expect(balance!.balanceCents).toBe(-2_000);
  });

  test("a first transaction dated ON the opening day still derives (default flow)", () => {
    // the critical bug: an anchor ON the opening day plus a same-day txn (both
    // default to today in the UI) derived $0 because derivation never adds the
    // anchor-day sum. The anchor now sits the day before, so same-day txns count.
    const id = createCashWallet(bundle.db, { name: "Same day", openingOn: "2026-06-01" });
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-01", // SAME day as the opening date
      amountCents: -2_000,
      description: "Coffee",
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(-2_000);
  });

  test("an opening balance lands on the books, so creating a wallet moves net worth", () => {
    // the reported bug: a wallet could only ever open at $0, so adding a cash
    // account with $200 in it changed no balance anywhere
    const id = createCashWallet(bundle.db, {
      name: "Pocket",
      openingOn: "2026-06-01",
      openingBalanceCents: 20_000,
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(20_000);

    // and it composes with transactions rather than replacing them
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-01", // same day as the opening date
      amountCents: -2_000,
      description: "Coffee",
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(18_000);
  });

  test("omitting the opening balance still opens the wallet empty", () => {
    const id = createCashWallet(bundle.db, { name: "Empty", openingOn: "2026-06-01" });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(0);
  });

  test("reuses the single Cash institution across wallets; defaults opening to today", () => {
    const a = createCashWallet(bundle.db, { name: "Wallet A" });
    const b = createCashWallet(bundle.db, { name: "Wallet B" });
    expect(a).not.toBe(b);
    expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(1);
  });

  test("rejects a blank name", () => {
    expect(() => createCashWallet(bundle.db, { name: "   " })).toThrow();
  });

  describe("a refused wallet leaves nothing behind", () => {
    function counts(): { accounts: number; anchors: number } {
      return {
        accounts: bundle.db.select().from(accounts).all().length,
        anchors: bundle.db.select().from(balanceAnchors).all().length,
      };
    }

    test("the opening date's own floor is refused BEFORE the account row is written", () => {
      // The wallet anchors the day BEFORE its opening date, so an opening date
      // of exactly MIN_FINANCIAL_DATE anchored at 1969-12-31 — outside the
      // financial window. addManualAnchor threw, but only after createAccount
      // had inserted the row, leaving a wallet that appeared in the account
      // list reading "no balance yet" while the user was told it had failed.
      const before = counts();
      expect(() =>
        createCashWallet(bundle.db, { name: "Edge wallet", openingOn: MIN_FINANCIAL_DATE }),
      ).toThrow(/on or after/);
      expect(counts()).toEqual(before);
    });

    test("a future opening date is refused by the service, not just the browser", () => {
      // measured: a 2027 opening date dragged the net-worth series past today.
      // Only the date input's `max` enforced it, and the server action is a
      // network boundary.
      const before = counts();
      expect(() => createCashWallet(bundle.db, { name: "Ahead", openingOn: "2027-01-01" })).toThrow(
        /future/,
      );
      expect(counts()).toEqual(before);
    });

    test("the first-ever wallet does not strand a Cash institution when it fails", () => {
      // cashInstitutionId find-or-creates as an ARGUMENT to createAccount, so
      // before the transaction wrap a failed first wallet left the institution
      // behind too
      expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(0);
      expect(() =>
        createCashWallet(bundle.db, { name: "Edge wallet", openingOn: MIN_FINANCIAL_DATE }),
      ).toThrow();
      expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(0);
    });
  });
});

describe("setCashWalletOpening", () => {
  test("changes the opening cash of an existing wallet, and the balance follows", () => {
    // the owner's actual problem: a wallet created before the "Cash on hand"
    // field existed opened at $0 and there was no way to say otherwise
    const id = createCashWallet(bundle.db, { name: "1800", openingOn: "2026-06-01" });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(0);

    const { anchoredOn } = setCashWalletOpening(bundle.db, { accountId: id, openingBalanceCents: 180_000 });

    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(180_000);
    // an UPSERT of the wallet's own opening anchor — never a second one, which
    // would turn the span between them into an unrenderable gap
    const anchors = bundle.db.select().from(balanceAnchors).where(eq(balanceAnchors.accountId, id)).all();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.anchoredOn).toBe(anchoredOn);
    expect(anchoredOn).toBe("2026-05-31");
  });

  test("composes with transactions already recorded against the wallet", () => {
    const id = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-05",
      amountCents: -2_000,
      description: "Coffee",
    });

    setCashWalletOpening(bundle.db, { accountId: id, openingBalanceCents: 5_000 });

    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(3_000);
  });

  test("refuses an account that is not a cash wallet", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: checkingId, anchoredOn: "2026-06-01", balanceCents: 5_000, source: "statement" })
      .run();

    expect(() =>
      setCashWalletOpening(bundle.db, { accountId: checkingId, openingBalanceCents: 100 }),
    ).toThrow(/Only cash wallets/);
  });

  test("refuses a credit account filed under Cash — cash on hand is not a debt", () => {
    // isCashWallet gates on the institution and the absence of imports, not on
    // type, and the ordinary Add-an-account form offers "credit" for any
    // institution. addManualAnchor NEGATES a liability, so the editor would
    // otherwise refuse to save back its own displayed value.
    const walletId = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    const cashInst = bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).get()!;
    const cardId = createAccount(bundle.db, { institutionId: cashInst.id, name: "Card", type: "credit" });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: cardId, anchoredOn: "2026-06-01", balanceCents: -5_000, source: "manual" })
      .run();

    expect(() => setCashWalletOpening(bundle.db, { accountId: cardId, openingBalanceCents: 100 })).toThrow(
      /you owe/,
    );
    // the ordinary wallet still works
    expect(() =>
      setCashWalletOpening(bundle.db, { accountId: walletId, openingBalanceCents: 100 }),
    ).not.toThrow();
  });

  test("rejects a negative opening balance", () => {
    const id = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    expect(() => setCashWalletOpening(bundle.db, { accountId: id, openingBalanceCents: -1 })).toThrow();
  });
});

describe("listCashWalletSummaries", () => {
  test("reports the opening figure and how many balances the wallet has recorded", () => {
    const id = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01", openingBalanceCents: 4_200 });

    const [summary] = listCashWalletSummaries(bundle.db);
    expect(summary).toMatchObject({ id, name: "Cash", openingCents: 4_200, anchorCount: 1 });
    // balanceCents is the field /accounts actually renders as the wallet's
    // figure. Every other balance assertion here goes through latestBalances(),
    // so without this the opening → displayed-balance path is untested and a
    // stale summary would reproduce the owner's original report exactly.
    expect(summary!.balanceCents).toBe(4_200);
  });

  test("the rendered balance follows an opening-balance EDIT, not just creation", () => {
    const id = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    expect(listCashWalletSummaries(bundle.db)[0]!.balanceCents).toBe(0);

    setCashWalletOpening(bundle.db, { accountId: id, openingBalanceCents: 180_000 });

    const [summary] = listCashWalletSummaries(bundle.db);
    expect(summary!.openingCents).toBe(180_000);
    expect(summary!.balanceCents).toBe(180_000);
  });

  test("counts a later recorded balance, so the UI can say the opening no longer drives the figure", () => {
    // derivation seeds its forward walk from the LAST anchor, so editing the
    // opening on a multi-anchor wallet moves nothing the owner can see
    const id = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01", openingBalanceCents: 4_200 });
    addManualAnchor(bundle.db, { accountId: id, anchoredOn: "2026-07-01", enteredCents: 9_000 });

    const [summary] = listCashWalletSummaries(bundle.db);
    expect(summary!.anchorCount).toBe(2);
    expect(summary!.openingCents).toBe(4_200);
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(9_000);
  });
});

describe("listCashWallets", () => {
  test("returns cash wallets and excludes import-fed accounts", () => {
    const walletId = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    // a regular account made import-fed by a statement-sourced anchor
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: checkingId, anchoredOn: "2026-06-01", balanceCents: 5_000, source: "statement" })
      .run();

    const wallets = listCashWallets(bundle.db);
    expect(wallets.map((w) => w.id)).toContain(walletId);
    expect(wallets.map((w) => w.id)).not.toContain(checkingId);
  });
});
