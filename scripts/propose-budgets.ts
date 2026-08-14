/**
 * Proposes a budget per category from measured data. DRY RUN unless --apply;
 * --apply takes a `VACUUM INTO` backup into data/backups/ first and prints the
 * whole table back after writing.
 *
 *   pnpm propose-budgets            # show the proposal
 *   pnpm propose-budgets --apply    # write it
 *
 * Rule (stated so it can be argued with):
 *   basis = MEDIAN of the trailing 6 full months — robust to one-off months, and
 *           they are everywhere here (Travel's $2,448.88 trip drags its mean to
 *           $600.65 against a $270.14 median).
 *   floor = the category's own live monthly RECURRING commitment. A budget below
 *           what is contractually owed is not a budget, it is a guaranteed
 *           overrun — Housing's $2,109 already sits under a $2,285.70 rent.
 *   budget = max(basis, floor), rounded UP to the nearest $5 so the floor is
 *           never rounded away.
 */
import fs from "node:fs"; import path from "node:path";
const APPLY = process.argv.includes("--apply");
const SRC = "data/moneyapp.db";
const S="/tmp/mp-prop"; const DB = APPLY ? SRC : path.join(S,"c.db");
if (!APPLY) {
  fs.rmSync(S,{recursive:true,force:true}); fs.mkdirSync(S,{recursive:true});
  for(const e of ["","-wal","-shm"]) if(fs.existsSync(SRC+e)) fs.copyFileSync(SRC+e,DB+e);
}
process.env.MONEYAPP_DB_PATH=DB; process.env.MONEYAPP_FAKE_TODAY="2026-08-14";
const {createDatabase}=await import("@/db/client");
const {categorySpending}=await import("@/services/analytics");
const {recurringSeriesIdsForCategory}=await import("@/services/analytics");
const {db,sqlite}=createDatabase(DB);
const m=(c:number)=>`$${(c/100).toFixed(2)}`;
const months=["2026-02","2026-03","2026-04","2026-05","2026-06","2026-07"];
const buds=sqlite.prepare("select b.id,b.amount_cents,b.category_id,c.name from budgets b join categories c on c.id=b.category_id order by c.name").all() as any[];
const plan:{id:string;name:string;from:number;to:number;median:number;floor:number}[]=[];
for(const b of buds){
  const vals=months.map(mo=>{
    const start=`${mo}-01`;
    const end=new Date(Number(mo.slice(0,4)),Number(mo.slice(5,7)),0).toISOString().slice(0,10);
    return Math.abs(categorySpending(db,{categoryId:b.category_id,from:start,to:end} as any).spentCents);
  });
  const s=[...vals].sort((a,c)=>a-c);
  const median=Math.round((s[2]!+s[3]!)/2);
  // CONFIRMED monthly commitments in this subtree. Not budgetTail: that applies
  // the staleness gate, which is right for a forecast and wrong for a floor —
  // the August rent has not posted yet, and what is owed does not depend on
  // whether it has arrived. `detected` is excluded as weaker evidence.
  const ids=[...recurringSeriesIdsForCategory(db,b.category_id)];
  const floor=ids.length===0?0:Math.abs((sqlite.prepare(
    `select coalesce(sum(coalesce(user_amount_cents,next_expected_amount_cents)),0) t
     from recurring_series where status='confirmed' and cadence='monthly'
       and coalesce(user_amount_cents,next_expected_amount_cents) < 0
       and id in (${ids.map(()=>"?").join(",")})`).get(...ids) as any).t);
  const raw=Math.max(median,floor);
  const to=Math.ceil(raw/500)*500; // up to the nearest $5
  plan.push({id:b.id,name:b.name,from:b.amount_cents,to,median,floor});
}
console.log("category           current   median    commit    PROPOSED   change");
for(const p of plan){
  const d=p.to-p.from;
  const mark=d===0?"  =":(d>0?"  ↑":"  ↓");
  console.log(`${p.name.padEnd(17)} ${m(p.from).padStart(9)} ${m(p.median).padStart(9)} ${m(p.floor).padStart(9)} ${m(p.to).padStart(10)} ${mark} ${d===0?"":m(Math.abs(d))}`);
}
const changed=plan.filter(p=>p.to!==p.from);
console.log(`\n${changed.length} of ${plan.length} budgets change.`);
if(!APPLY){ console.log("DRY RUN — pass --apply to write."); sqlite.close(); process.exit(0); }
const before=`data/backups/pre-budget-reset-${Date.now()}.db`;
fs.mkdirSync("data/backups",{recursive:true});
sqlite.prepare("VACUUM INTO ?").run(before);
console.log(`backup: ${before}`);
const upd=sqlite.prepare("update budgets set amount_cents=?, updated_at=? where id=?");
let n=0;
for(const p of changed){ upd.run(p.to,new Date("2026-08-14T12:00:00Z").toISOString(),p.id); n++; }
console.log(`updated ${n} rows`);
for(const r of sqlite.prepare("select c.name,b.amount_cents from budgets b join categories c on c.id=b.category_id order by c.name").all() as any[])
  console.log(`  ${r.name.padEnd(17)} ${m(r.amount_cents)}`);
sqlite.close();
