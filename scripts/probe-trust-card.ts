/** READ-ONLY. */
import { getDb } from "@/db/client";
import { trustCard } from "@/services/trust-card";
import { provenanceFor } from "@/services/provenance";

const db = getDb();
const TODAY = "2026-08-26";
const c = trustCard(db, TODAY);
if (!c) {
  console.log("trustCard returned null");
} else {
  console.log(JSON.stringify(c, null, 2));
  // the one figure this card shares with the net-worth badge: they must agree
  const nw = provenanceFor(db, { kind: "netWorth", day: TODAY })!;
  console.log("\nbadgeWord =", JSON.stringify(nw.badgeWord));
  console.log("card says =", JSON.stringify(`${c.headline} add up`));
  console.log("agree     =", nw.badgeWord === `${c.headline} add up`);
}
