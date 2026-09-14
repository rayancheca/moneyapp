import fs from "node:fs";
import { parseChaseCardLines } from "@/services/import/profiles/chase-card-statement-profile";
import { extractLines } from "@/services/import/profiles/pdf-profile";
import type { PrintedLine } from "./sapphire-printed-lines";

/** One imported Sapphire card statement and the period it owns. */
export interface CardStatement {
  fileId: string;
  fileName: string;
  sha: string;
  storagePath: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Every line the statements print, read with the app's OWN extractor and
 * parser — the same two functions the importer ran — never re-derived here.
 *
 * Refuses on bytes that are not the imported file (sha256) and on a parsed
 * period that disagrees with the stored one: attaching a row to a document is
 * only honest if the document read is the document that was imported.
 */
export async function printedStatementLines(
  statements: readonly CardStatement[],
  sha256: (bytes: Buffer) => string,
): Promise<PrintedLine[]> {
  const out: PrintedLine[] = [];
  for (const s of statements) {
    const buffer = fs.readFileSync(s.storagePath);
    if (sha256(buffer) !== s.sha) {
      throw new Error(`REFUSED — ${s.storagePath} is not the imported ${s.fileName} (sha256 differs)`);
    }
    const parsed = parseChaseCardLines((await extractLines(buffer)).map((l) => l.text));
    if (parsed.periodStart !== s.periodStart || parsed.periodEnd !== s.periodEnd) {
      throw new Error(
        `REFUSED — ${s.fileName} prints ${parsed.periodStart}→${parsed.periodEnd}, stored ${s.periodStart}→${s.periodEnd}`,
      );
    }
    parsed.txns.forEach((t, order) => {
      out.push({
        fileId: s.fileId,
        fileName: s.fileName,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        day: t.postedOn,
        amountCents: t.amountCents,
        description: t.rawDescription,
        order,
      });
    });
  }
  return out;
}
