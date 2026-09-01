import { createDatabase } from "@/db/client";
import { dashboardData } from "@/services/dashboard";
import { formatCents as f } from "@/lib/money";
const { db } = createDatabase(process.env.MONEYAPP_DB_PATH!);
const d = dashboardData(db, process.argv[2]!) as any;
const b = d.upcoming;
console.log(`windowDays=${b.windowDays}  net ${f(b.netCents)}  items=${b.items.length}`);
for (const i of b.items) console.log(`   ${i.date}  ${String(i.name).padEnd(20)} ${f(i.amountCents)}`);
console.log(`beforePaycheck: ${b.beforePaycheck ? b.beforePaycheck.date + " " + f(b.beforePaycheck.cents) : "null"}`);
