import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { PROFILES } from "./profiles";
import { importStatementFiles, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";

/**
 * A day two statements print — one closes on it, the next opens the day after — holds ONE recorded balance, and it cites
 * whichever of the two was imported last (`upsertAnchor`). A re-read at a newer parser version renews the reads and must
 * leave that citation where it was: the provenance sheet of the day names the statement it named before.
 *
 * 🔴 A re-read retires its files' reads — each anchor they cite handed to another printer of the day, or let go
 * (`handOverPrintedAnchors`) — then writes the new reads oldest first (`oldestFirstWhereItMatters`), and the last to
 * write a day owns it. On a copy of the real ledger (2026-09-28) the re-read of 33 Robinhood statements moved 26
 * month-ends from citing the statement that closes on them to the next one's opening: same day, same balance, the other
 * statement in that day's provenance sheet — a change ⚖️ his rule for that re-read refuses (§6A 26).
 */

const PREFIX = "reread-citations-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "6203" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "BLUE BOTTLE 12" };
const RENT = { postedOn: "2026-04-03", amountCents: -1500, rawDescription: "APRIL RENT SHARE" };
const MONTHS: Record<string, ParsedStatement[]> = {
  march: [
    { accountHint: CHECKING, txns: [COFFEE], period: { start: "2026-03-01", end: "2026-03-31", beginCents: 10_000, endCents: 9_000 } },
  ],
  april: [
    { accountHint: CHECKING, txns: [RENT], period: { start: "2026-04-01", end: "2026-04-30", beginCents: 9_000, endCents: 7_500 } },
  ],
};

/** Every version reads each month the same: a re-read that renews the reads and nothing else. */
const profile: ParserProfile = {
  id: "test-reread-citations",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => MONTHS[f.text.trim()]!,
};

const MARCH: ImportInput = { name: `${PREFIX}1-march.csv`, buffer: Buffer.from("march") };
const APRIL: ImportInput = { name: `${PREFIX}2-april.csv`, buffer: Buffer.from("april") };

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reread-citations-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

/** The live read of a file: its row, and its period. */
function readOf(input: ImportInput): { file: string; period: string } {
  const file = bundle.db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.fileName, input.name), ne(importFiles.status, "superseded")))
    .get()!;
  const period = bundle.db.select().from(statementPeriods).where(eq(statementPeriods.importFileId, file.id)).get()!;
  return { file: file.id, period: period.id };
}

/** What the day's recorded balance says, and which statement it cites — as the day's provenance sheet reads it. */
function citation(day: string): { balanceCents: number; importFileId: string | null; statementPeriodId: string | null } {
  return bundle.db
    .select({
      balanceCents: balanceAnchors.balanceCents,
      importFileId: balanceAnchors.importFileId,
      statementPeriodId: balanceAnchors.statementPeriodId,
    })
    .from(balanceAnchors)
    .where(and(eq(balanceAnchors.anchoredOn, day), eq(balanceAnchors.source, "statement")))
    .get()!;
}

const cites = (input: ImportInput, balanceCents: number) => ({ balanceCents, importFileId: readOf(input).file, statementPeriodId: readOf(input).period });

describe("a re-read keeps each recorded balance citing the statement it cited", () => {
  test("a month-end the statement closing on it cited stays with that statement's new read — though the next month is read after it", async () => {
    // April first: March, imported last, closes on 03-31 and owns it
    await importStatementFiles(bundle.db, [APRIL]);
    await importStatementFiles(bundle.db, [MARCH]);
    expect(citation("2026-03-31")).toEqual(cites(MARCH, 9_000));
    profile.version = 2;

    const outcomes = await importStatementFiles(bundle.db, [MARCH, APRIL]);

    expect(outcomes.map((o) => o.status)).toEqual(["parsed", "parsed"]);
    expect(citation("2026-03-31")).toEqual(cites(MARCH, 9_000));
    expect(citation("2026-02-28")).toEqual(cites(MARCH, 10_000));
    expect(citation("2026-04-30")).toEqual(cites(APRIL, 7_500));
  });

  test("a month-end the next statement's opening cited stays with that statement's new read", async () => {
    // March first: April, imported last, opens the day after 03-31 and owns it
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [APRIL]);
    expect(citation("2026-03-31")).toEqual(cites(APRIL, 9_000));
    profile.version = 2;

    await importStatementFiles(bundle.db, [APRIL, MARCH]);

    expect(citation("2026-03-31")).toEqual(cites(APRIL, 9_000));
    expect(citation("2026-02-28")).toEqual(cites(MARCH, 10_000));
  });

  test("a re-read of one month leaves a day a statement it does not re-read cites with that statement", async () => {
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [APRIL]);
    const april = cites(APRIL, 9_000);
    expect(citation("2026-03-31")).toEqual(april);
    profile.version = 2;

    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    // April's read is untouched, and still cites the day it cited: March's new read prints it too, and takes nothing
    expect(citation("2026-03-31")).toEqual(april);
    expect(citation("2026-02-28")).toEqual(cites(MARCH, 10_000));
  });
});
