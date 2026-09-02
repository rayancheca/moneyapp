/** READ-ONLY. What "would change N" claims now, against condition matches. */
import { getDb } from "@/db/client";
import { listRules } from "@/services/rules-manager";
import { countRuleMatches } from "@/services/rule-corrections";
import { rules } from "@/db/schema";

const db = getDb();
const byId = new Map(db.select().from(rules).all().map((r) => [r.id, r]));
let badgeSum = 0;
let matchSum = 0;
for (const v of listRules(db)) {
  const raw = byId.get(v.id)!;
  const cond = JSON.parse(raw.conditions);
  const matches = raw.isEnabled ? countRuleMatches(db, cond, { excludeUserSet: true }) : 0;
  badgeSum += v.matchCount;
  matchSum += matches;
  if (matches !== v.matchCount) {
    console.log(`${v.sentence.slice(0, 62).padEnd(62)} was="would change ${String(matches).padStart(3)}"  now=${String(v.matchCount).padStart(3)}  applied=${v.timesApplied}`);
  }
}
console.log(`\ntotal claimed BEFORE: ${matchSum}   AFTER: ${badgeSum}`);
