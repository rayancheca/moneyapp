import { getDb } from "@/db/client";
import { txnHistory } from "@/services/txn-detail";
import { transactions } from "@/db/schema/transactions";
import { like, eq, and } from "drizzle-orm";

const line = (a: { accountName: string; count: number; outCount: number }) => {
  const rows = `${a.count} ${a.count === 1 ? "transaction" : "transactions"}`;
  if (a.outCount === 0) return `${a.accountName} · ${rows}, none of them spending`;
  if (a.outCount === a.count) return `${a.accountName} · ${rows}`;
  return `${a.accountName} · ${rows}, ${a.outCount} of them spending`;
};

const db = getDb();
const TODAY = "2026-09-11";
const rows = db.select({ id: transactions.id })
  .from(transactions)
  .where(and(eq(transactions.status, "active"), like(transactions.rawDescription, "%CAPITAL ONE MOBILE%")))
  .all();
console.log("CAPITAL ONE MOBILE rows:", rows.length);
if (rows.length) {
  const h = txnHistory(db, rows[0]!.id, TODAY)!;
  console.log("group count", h.count, "outCount", h.outCount, "total", h.totalCents, "sum(byAccount)", h.byAccount.reduce((s, a) => s + a.cents, 0));
  for (const a of h.byAccount) console.log("   ", line(a), "|", a.outCount === 0 ? "—" : `$${(a.cents / 100).toFixed(2)}`);
}
