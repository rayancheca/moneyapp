/** READ-ONLY. Series ids for spot-reading detail pages. */
import { getDb } from "@/db/client";
import { recurringSeries } from "@/db/schema";
import { inArray } from "drizzle-orm";
const db = getDb();
for (const r of db.select().from(recurringSeries).where(inArray(recurringSeries.status, ["detected", "confirmed"])).all()) {
  console.log(`${r.id}  ${r.kind.padEnd(12)} ${r.name}`);
}
