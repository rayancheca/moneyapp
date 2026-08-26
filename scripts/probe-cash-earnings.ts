import { getDb } from "@/db/client";
import { cashEarningsReadings } from "@/services/cash-earnings";
console.log(JSON.stringify(cashEarningsReadings(getDb(), { from: "2026-02-01", to: "2026-07-31", today: "2026-08-26" }), null, 1));
