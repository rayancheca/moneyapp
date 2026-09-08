#!/usr/bin/env node
/**
 * Read a running surface as its SENTENCES — including the ones only a screen
 * reader hears.
 *
 * ⭐ The highest-yield tool of the 2026-09-04 session. Four of that day's
 * twenty-two defects lived only in an attribute: a /budgets tooltip that named
 * its subtraction backwards, "Add an average cost to see TOTAL RETURN" one line
 * under the label corrected for exactly that, "Jul 27: no activity" of a day
 * holding 18 transactions, and "Monthly spending" as the accessible name of a
 * Salary chart. A browser screenshot shows none of them; `curl | sed` shows the
 * markup and not the reading order.
 *
 * `aria-label` and `title` are inlined into the text stream as ⟨aria-label: …⟩
 * and ⟨title: …⟩, so the page reads the way it is heard.
 *
 * Usage:  node scripts/read-surface.mjs / '/accounts?view=table' /budgets
 *
 * ⚠️ Reads whatever is serving :3000. A stale dev server can 404 a route that
 * exists — /summary/<year> did, for every year, on 2026-09-04. Restart before
 * believing a 404.
 */
// Fetch a route and dump its rendered text, block-by-block, one line per text node group.
const routes = process.argv.slice(2);
if (routes.length === 0) {
  console.error("usage: node scripts/read-surface.mjs <route> [route...]");
  process.exit(1);
}
function toText(html) {
  // drop script/style content
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // ⛔ An <svg> is dropped for its GEOMETRY, never for its sentence. A chart's
    // whole reading is its accessible name — "The largest move is Government,
    // down $2,250.00" is an `aria-label` on the <svg> itself, and stripping the
    // element wholesale took the sentence with the path data. The opening tag's
    // `aria-label`/`title` are kept and only the contents are thrown away.
    .replace(/<svg([^>]*)>[\s\S]*?<\/svg>/gi, (m, attrs) => `<span${attrs}></span>`)
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // aria-label / title attributes are content too
  s = s.replace(/<(\w+)([^>]*?)>/g, (m, tag, attrs) => {
    const al = /aria-label="([^"]*)"/.exec(attrs);
    const ti = /\btitle="([^"]*)"/.exec(attrs);
    let extra = '';
    if (al) extra += ` ⟨aria-label: ${al[1]}⟩ `;
    if (ti) extra += ` ⟨title: ${ti[1]}⟩ `;
    const block = /^(div|section|article|header|footer|main|nav|p|h[1-6]|li|tr|td|th|dt|dd|dl|table|ul|ol|button|a|label|figcaption|caption|summary|details|aside|option)$/i.test(tag);
    return (block ? '\n' : '') + extra;
  });
  s = s.replace(/<\/(div|section|article|header|footer|main|nav|p|h[1-6]|li|tr|dl|table|ul|ol|button|a|label|figcaption|caption|summary|details|aside)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&middot;/g,'·')
       .replace(/&mdash;/g,'—').replace(/&ndash;/g,'–').replace(/&hellip;/g,'…')
       .replace(/&#x([0-9a-f]+);/gi, (m,h)=>String.fromCodePoint(parseInt(h,16)))
       .replace(/&#(\d+);/g, (m,d)=>String.fromCodePoint(+d));
  return s.split('\n').map(l => l.replace(/[ \t]+/g,' ').trim()).filter(l => l.length).join('\n');
}
for (const r of routes) {
  const url = 'http://localhost:3000' + r;
  try {
    const res = await fetch(url, { headers: { 'accept': 'text/html' } });
    const html = await res.text();
    console.log('\n\n========== ' + r + '  [' + res.status + '] ==========');
    console.log(toText(html));
  } catch (e) {
    console.log('\n\n========== ' + r + '  [ERROR] ==========');
    console.log(String(e));
  }
}
