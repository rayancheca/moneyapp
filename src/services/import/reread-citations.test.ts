import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { fileSha256 } from "@/lib/hash";
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
const LUNCH = { postedOn: "2026-02-10", amountCents: -1000, rawDescription: "FEBRUARY LUNCH" };
const COFFEE = { postedOn: "2026-03-05", amountCents: -1000, rawDescription: "BLUE BOTTLE 12" };
const RENT = { postedOn: "2026-04-03", amountCents: -1500, rawDescription: "APRIL RENT SHARE" };
const MARCH_PERIOD = { start: "2026-03-01", end: "2026-03-31", beginCents: 10_000, endCents: 9_000 };

/** What each file prints, by its text — as each month was printed; a test may change one before it is imported. */
const printed = (): Record<string, ParsedStatement[]> => ({
  february: [
    { accountHint: CHECKING, txns: [LUNCH], period: { start: "2026-02-01", end: "2026-02-28", beginCents: 11_000, endCents: 10_000 } },
  ],
  march: [{ accountHint: CHECKING, txns: [COFFEE], period: { ...MARCH_PERIOD } }],
  // March downloaded a second time, in other bytes: the same statement
  "march again": [{ accountHint: CHECKING, txns: [COFFEE], period: { ...MARCH_PERIOD } }],
  april: [
    { accountHint: CHECKING, txns: [RENT], period: { start: "2026-04-01", end: "2026-04-30", beginCents: 9_000, endCents: 7_500 } },
  ],
});
let months = printed();

/** Every version reads each month the same: a re-read that renews the reads and nothing else. */
const profile: ParserProfile = {
  id: "test-reread-citations",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => structuredClone(months[f.text.trim()]!),
};

const FEBRUARY: ImportInput = { name: `${PREFIX}0-february.csv`, buffer: Buffer.from("february") };
const MARCH: ImportInput = { name: `${PREFIX}1-march.csv`, buffer: Buffer.from("march") };
const MARCH_AGAIN: ImportInput = { name: `${PREFIX}1-march (1).csv`, buffer: Buffer.from("march again") };
/** …or saved over the first download's name, as Chase names every download of a statement alike */
const MARCH_AGAIN_SAME_NAME: ImportInput = { name: MARCH.name, buffer: Buffer.from("march again") };
const APRIL: ImportInput = { name: `${PREFIX}2-april.csv`, buffer: Buffer.from("april") };

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reread-citations-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  months = printed();
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

/** A file as the day's provenance sheet names it: which download (by its bytes), and which read of it. */
function fileNamed(importFileId: string | null): string | null {
  if (importFileId === null) return null;
  const file = bundle.db.select().from(importFiles).where(eq(importFiles.id, importFileId)).get()!;
  const text = Object.keys(months).find((t) => fileSha256(Buffer.from(t)) === file.fileSha256) ?? file.fileName;
  return `${text}@v${file.parserVersion}`;
}

/** The day's recorded balance, the download it cites and the span of the period it cites — ids read as what they name. */
function citing(day: string): { balanceCents: number; cites: string | null; period: string | null } {
  const { balanceCents, importFileId, statementPeriodId } = citation(day);
  const period =
    statementPeriodId === null ? undefined : bundle.db.select().from(statementPeriods).where(eq(statementPeriods.id, statementPeriodId)).get();
  return { balanceCents, cites: fileNamed(importFileId), period: period === undefined ? null : `${period.periodStart}..${period.periodEnd}` };
}

/** March's one period: the download that holds it, its balances and its verdict. */
function marchPeriod() {
  const p = bundle.db
    .select()
    .from(statementPeriods)
    .where(and(eq(statementPeriods.periodStart, "2026-03-01"), eq(statementPeriods.periodEnd, "2026-03-31")))
    .all();
  expect(p).toHaveLength(1);
  const [{ importFileId, beginningBalanceCents, endingBalanceCents, reconciliation, gapCents }] = p as [(typeof p)[number]];
  return { held: fileNamed(importFileId), beginningBalanceCents, endingBalanceCents, reconciliation, gapCents };
}

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

/**
 * A second download of a statement prints every day the first prints, and holds no period: it adopted the first's
 * (`writeMember`) and is recorded as a copy of it (`statement_copies`). The day's balance cites it when it wrote the day
 * last, and it cites the first download's period — as `upsertAnchor` records it.
 *
 * 🔴 `keepCitations` looked for a period the cited file HOLDS, found none for a copy, and let the day go: a re-read of the
 * first download, or of a neighbour that prints the day too, took it — and with a neighbour's own figure, the balance
 * moved (the review of uc/reread-34-runbook, 2026-09-29, probes E1/E2).
 */
describe("a day a second download of a statement cites", () => {
  test("stays with it through a re-read of the neighbour that prints the day too — though the neighbour prints another figure", async () => {
    // April opens on a figure March does not close on
    months.april![0]!.period!.beginCents = 8_950;
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [APRIL]);
    await importStatementFiles(bundle.db, [MARCH_AGAIN]);
    // the premise: the second download, imported last, wrote the day — on March's period, which it adopted
    const before = citing("2026-03-31");
    expect(before).toEqual({ balanceCents: 9_000, cites: "march again@v1", period: "2026-03-01..2026-03-31" });
    profile.version = 2;

    const [outcome] = await importStatementFiles(bundle.db, [APRIL]);

    expect(outcome!.status).toBe("parsed");
    expect(citing("2026-03-31")).toEqual(before);
    expect(citing("2026-04-30")).toEqual({ balanceCents: 7_500, cites: "april@v2", period: "2026-04-01..2026-04-30" });
  });

  test("stays with it through a re-read of the first download", async () => {
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [MARCH_AGAIN]);
    const before = [citing("2026-02-28"), citing("2026-03-31")];
    expect(before).toEqual([
      { balanceCents: 10_000, cites: "march again@v1", period: "2026-03-01..2026-03-31" },
      { balanceCents: 9_000, cites: "march again@v1", period: "2026-03-01..2026-03-31" },
    ]);
    profile.version = 2;

    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    expect([citing("2026-02-28"), citing("2026-03-31")]).toEqual(before);
    // the first download's new read holds the period again, and the second download still prints it
    expect(marchPeriod().held).toBe("march@v2");
  });
});

/**
 * A second download that prints other balances than the first — the bank reissued the statement — wins them: the one
 * period takes the reissued figures and is graded again (`writeMember`: "reissued balances win and re-reconcile").
 *
 * 🔴 A re-read of the FIRST download took the period back from the copy it was lent to (`lendToCopies`,
 * `reclaimFromCopy`) and wrote its own older figures over the reissue: the period's balances, its verdict and the
 * month-end balance all moved, and the day came to cite the first download (probe E2b, 2026-09-29: 10,000/9,100 `gap`
 * citing the second download → 10,000/9,000 `reconciled` citing the first).
 */
describe("a statement whose second download reissued its balances", () => {
  test("a re-read of the first download leaves the reissued balances, the verdict they give, and the days that cite them", async () => {
    months["march again"]![0]!.period!.endCents = 9_100;
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [MARCH_AGAIN]);
    // the premise: the reissue won — March closes on 9,100 now, 100 more than its lines leave
    const period = marchPeriod();
    expect(period).toEqual({
      held: "march@v1",
      beginningBalanceCents: 10_000,
      endingBalanceCents: 9_100,
      reconciliation: "gap",
      gapCents: expect.any(Number),
    });
    const before = [citing("2026-02-28"), citing("2026-03-31")];
    expect(before[1]).toEqual({ balanceCents: 9_100, cites: "march again@v1", period: "2026-03-01..2026-03-31" });
    profile.version = 2;

    const [outcome] = await importStatementFiles(bundle.db, [MARCH]);

    expect(outcome!.status).toBe("parsed");
    expect(marchPeriod()).toEqual({ ...period, held: "march@v2" });
    expect([citing("2026-02-28"), citing("2026-03-31")]).toEqual(before);
  });
});

/**
 * Each turn of a re-read keeps the citations it found (`citationsBefore`) — so a day a turn took from a second download
 * stayed taken: the second download's own re-read wrote the day, and was overruled by the citation the turn before left.
 *
 * 🔴 Probes E6–E8 (2026-09-29), against 5821be6, which gave the day back: both downloads re-read, one upload each, or one
 * upload with the month before — the Chase re-drop's shape — ended citing the first download or the month before.
 */
describe("a second download and its first download both read again", () => {
  test.each([
    ["the first download first", [MARCH], [MARCH_AGAIN]],
    ["the second download first", [MARCH_AGAIN], [MARCH]],
  ])("an upload each, %s: each day the second download cited, its new read cites", async (_, first, second) => {
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [MARCH_AGAIN]);
    profile.version = 2;

    await importStatementFiles(bundle.db, first);
    await importStatementFiles(bundle.db, second);

    expect([citing("2026-02-28"), citing("2026-03-31")]).toEqual([
      { balanceCents: 10_000, cites: "march again@v2", period: "2026-03-01..2026-03-31" },
      { balanceCents: 9_000, cites: "march again@v2", period: "2026-03-01..2026-03-31" },
    ]);
  });

  test("one upload with the month before, the two downloads under one name — as Chase's are", async () => {
    await importStatementFiles(bundle.db, [FEBRUARY]);
    await importStatementFiles(bundle.db, [MARCH]);
    await importStatementFiles(bundle.db, [MARCH_AGAIN_SAME_NAME]);
    // the premise: the second download wrote both of March's days last; February's own closing day is March's opening
    expect([citing("2026-01-31"), citing("2026-02-28"), citing("2026-03-31")].map((c) => c.cites)).toEqual([
      "february@v1",
      "march again@v1",
      "march again@v1",
    ]);
    profile.version = 2;

    const outcomes = await importStatementFiles(bundle.db, [FEBRUARY, MARCH, MARCH_AGAIN_SAME_NAME]);

    expect(outcomes.map((o) => o.status)).toEqual(["parsed", "parsed", "parsed"]);
    expect([citing("2026-01-31"), citing("2026-02-28"), citing("2026-03-31")]).toEqual([
      { balanceCents: 11_000, cites: "february@v2", period: "2026-02-01..2026-02-28" },
      { balanceCents: 10_000, cites: "march again@v2", period: "2026-03-01..2026-03-31" },
      { balanceCents: 9_000, cites: "march again@v2", period: "2026-03-01..2026-03-31" },
    ]);
  });
});
