// READ-ONLY: the DRILL-DOWN CONTRACT for /spending -> /categories/<id> links.
const BASE = "http://localhost:3000";
const periods = process.argv.slice(2);
const NBSP = String.fromCharCode(160);
const MID = String.fromCharCode(183); // middot
const strip = (h) => h
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(new RegExp(NBSP, "g"), " ")
  .replace(/&[a-z]+;/g, " ")
  .replace(/\s+/g, " ");

for (const p of periods) {
  const url = `${BASE}/spending?${p}`;
  const html = await (await fetch(url)).text();
  const hrefs = [...new Set([...html.matchAll(/href="(\/categories\/[0-9a-f-]{36}[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
  let bare = 0;
  const notes = [];
  for (const h of hrefs) {
    const dest = await (await fetch(BASE + h)).text();
    const text = strip(dest);
    const re = new RegExp("(Spent|Earned|Net|Moved|Returned) " + MID + " ([A-Za-z0-9 ,\\u2013-]+?) (adds up|it was|[$-])");
    const m = text.match(re);
    const label = m ? `${m[1]} / ${m[2].trim()}` : "(not found)";
    const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "(NO PARAMS)";
    if (!h.includes("?")) bare++;
    notes.push(`  ${q.padEnd(32)} -> ${label}`);
  }
  console.log(`${url}  [${hrefs.length} category links, ${bare} bare]`);
  console.log([...new Set(notes)].slice(0, 10).join("\n"));
}
