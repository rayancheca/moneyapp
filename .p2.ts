import { getDb } from "@/db/client";
import { cashFlowByPeriod } from "@/services/spending";
import { resolvePeriod } from "@/lib/period";
import { txnHistory } from "@/services/txn-detail";
import { accountHistoryLine } from "@/components/transactions/TransactionSheet";
import { apportionPercents } from "@/lib/apportion";

const db = getDb();
const TODAY = "2026-09-11";
// 1. net identity across every bucket of every month
let bad = 0, buckets = 0, withRefund = 0;
for (let y = 2022; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
  const k = `${y}-${String(m).padStart(2, "0")}`;
  const p = resolvePeriod({ period: k }, TODAY);
  const f = cashFlowByPeriod(db, p, TODAY);
  for (const b of f.buckets) {
    buckets++;
    if (b.refundsCents !== 0) withRefund++;
    if (b.netCents !== b.incomeCents + b.refundsCents - b.spendingCents) { bad++; if (bad < 4) console.log("  MISMATCH", k, b.key, b); }
  }
}
console.log(`net identity: ${bad} bad of ${buckets} buckets; ${withRefund} buckets carry a refund`);

// 2. apportion with a negative part
try { console.log("apportion([-5, 105]) =", apportionPercents([-5, 105])); } catch (e: any) { console.log("apportion negative THREW:", e.message); }
try { console.log("apportion([-50, -50, 210]) =", apportionPercents([-50, -50, 210])); } catch (e: any) { console.log("apportion 2 THREW:", e.message); }
