import path from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "@/db/client";
import { accounts, categories } from "@/db/schema";
import { latestBalances } from "@/services/derivation";
import { setCashWalletOpening } from "@/services/cash-wallets";
import { addManualTransaction } from "@/services/manual-transactions";

/**
 * Records the car's $5,000 cash down payment and empties the safe.
 *
 * The owner, 2026-08-11: "i put 5k in cash today", "no more cash after i give
 * the 5k", and "1800 i had and ive been saving the cash from getting paid from
 * work." So the safe held exactly $5,000 this morning and holds nothing tonight
 * — but the ledger only ever recorded $1,800 of it.
 *
 * The other $3,200 is cash pay he earned and never deposited, which no
 * statement has ever seen. That made zeroing the wallet an INCOME question, not
 * a balance edit, and he was asked which way to take it. He chose **option (b):
 * treat the safe as an untracked float** — correct the opening figure, book the
 * payment, and leave income alone. So this script deliberately does NOT create
 * an income row: `docs/income-ground-truth.md` is hand-maintained and passes 15
 * and 28 both had to UNDO income contamination. $3,200 of real earnings stays
 * invisible to income totals, and that is the owner's explicit choice.
 *
 * ⚠️ Honest limitation of option (b): the opening anchor is dated 2026-08-03, so
 * raising it to $5,000 asserts the safe held $5,000 from the 3rd, when in truth
 * he was still accumulating through the 10th. The overstatement is at most
 * $3,200 across 8 days. The alternative — a second anchor on the 10th — is
 * worse and is explicitly warned against in `cash-wallets.ts:113-122`: two
 * unequal chain-grade anchors with no transactions between them turn every day
 * in the span to basis='gap', dropping them from the chart, the latest balance
 * and net-worth coverage.
 *
 *   pnpm tsx scripts/record-car-down-payment.ts            # dry run
 *   pnpm tsx scripts/record-car-down-payment.ts --confirm
 */

const CONFIRMED = process.argv.includes("--confirm");
const DB_PATH =
  process.argv.find((a) => a.startsWith("--db="))?.slice("--db=".length) ??
  path.join("data", "moneyapp.db");

const WALLET = "Cash on Hand";
const CATEGORY = "Car Payment";
const PAID_ON = "2026-08-11";
const OPENING_CENTS = 500_000; // the safe's true holding before the payment
const PAYMENT_CENTS = -500_000;

function money(c: number): string {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function main(): void {
  const { db, sqlite } = createDatabase(path.resolve(process.cwd(), DB_PATH));

  const wallet = db.select().from(accounts).where(eq(accounts.name, WALLET)).get();
  if (!wallet) throw new Error(`No "${WALLET}" account`);
  const category = db.select().from(categories).where(eq(categories.name, CATEGORY)).get();
  if (!category) throw new Error(`No "${CATEGORY}" category — create it first`);
  if (category.kind !== "expense") throw new Error(`"${CATEGORY}" is ${category.kind}, expected expense`);

  const before = latestBalances(db).get(wallet.id);
  console.log(`db=${DB_PATH}`);
  console.log(`wallet "${WALLET}" now: ${before?.balanceCents != null ? money(before.balanceCents) : "(none)"}`);
  console.log(`  1. opening anchor -> ${money(OPENING_CENTS)}   (was $1,800.00; +$3,200.00 of undeposited cash pay)`);
  console.log(`  2. ${PAID_ON}  ${money(PAYMENT_CENTS)}  "${CATEGORY}" — car lease down payment`);
  console.log(`  => wallet ends at $0.00, and NO income row is created (owner's option b)`);

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm.");
    sqlite.close();
    return;
  }

  // Not wrapped in one transaction on purpose: setCashWalletOpening takes a
  // pre-mutation restore point, which VACUUMs, and that throws inside a
  // transaction (cash-wallets.ts:124-125 / the durable gotcha).
  const { anchoredOn } = setCashWalletOpening(db, {
    accountId: wallet.id,
    openingBalanceCents: OPENING_CENTS,
  });
  console.log(`opening anchor rewritten on ${anchoredOn}`);

  const id = addManualTransaction(db, {
    accountId: wallet.id,
    postedOn: PAID_ON,
    amountCents: PAYMENT_CENTS,
    description: "Car lease down payment (cash)",
    categoryId: category.id,
  });
  console.log(`manual transaction ${id} inserted`);

  const after = latestBalances(db).get(wallet.id);
  console.log(`wallet "${WALLET}" now: ${after?.balanceCents != null ? money(after.balanceCents) : "(none)"}`);

  sqlite.close();
}

main();
