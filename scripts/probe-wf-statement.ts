/** READ-ONLY. Dump the Wells Fargo statement's text so it can be read before anything parses it. */
import fs from "node:fs";
import { getDocumentProxy } from "unpdf";

const buf = new Uint8Array(fs.readFileSync(process.argv[2]!));
const doc = await getDocumentProxy(buf);
console.log(`pages: ${doc.numPages}`);
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const items = (content.items as { str: string; transform: number[] }[])
    .filter((it) => it.str.trim().length > 0)
    .map((it) => ({ x: Math.round(it.transform[4]!), y: Math.round(it.transform[5]!), s: it.str }));
  // cluster by y (rows), print left-to-right
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const it of items) {
    const key = Math.round(it.y / 3) * 3;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push({ x: it.x, s: it.s });
  }
  console.log(`\n═══════════ PAGE ${i}`);
  for (const y of [...rows.keys()].sort((a, b) => b - a)) {
    const line = rows.get(y)!.sort((a, b) => a.x - b.x).map((c) => c.s).join(" ").replace(/\s+/g, " ").trim();
    if (line) console.log(line);
  }
}
