/** READ-ONLY smoke render: does the card produce valid, nesting-safe markup? */
import { renderToStaticMarkup } from "react-dom/server";
import { MoversCard } from "@/components/dashboard/MoversCard";
import { getDb } from "@/db/client";
import { moversCard } from "@/services/movers-card";

const data = moversCard(getDb(), "2026-08-26")!;
const html = renderToStaticMarkup(<MoversCard data={data} />);
console.log(html.replace(/></g, ">\n<"));
// the rule 8 check: no block-level element may sit inside a <p>
const paragraphs = html.match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? [];
console.log("\nparagraphs:", paragraphs.length);
console.log("any <div> inside a <p>:", paragraphs.some((p) => p.includes("<div")));
console.log("any <ul>/<li> inside a <p>:", paragraphs.some((p) => p.includes("<ul") || p.includes("<li")));
console.log('any "-$0.00":', html.includes("-$0.00"), ' any "Infinity":', html.includes("Infinity"), ' any "NaN":', html.includes("NaN"));
