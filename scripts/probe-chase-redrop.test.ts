import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { normalizeDescription } from "@/lib/normalize";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles } from "@/services/import/service";
import type { AccountHint, ParsedStatement, ParserProfile } from "@/services/import/types";
import { judge, readLedger, worthOnEveryDay } from "./probe-chase-redrop";

/**
 * Two ledgers the way step 3 of the §6A 23 runbook reads them: the restore point `pnpm import-statements` takes, and
 * the ledger after the re-drop. The before-ledger is the app's own import of lines as the v1 parser read them — the
 * statement's 20-digit margin identifier folded into the words — with the owner's hand work on one of them. Each
 * after-ledger is a byte copy of it with the re-read's outcome written in: ids are left alone, since the probe keys
 * lines by the money and never by the id a re-read replaces.
 *
 * The two +$20.00 Zelle deposits are the pair `claimCarry` once crossed on this very re-read (service.ts: Adam's
 * hand-set category landed on Lukas's line). Here BOTH carry a margin id, the case where the crossed carry and the
 * correct one move the same number of lines and the same number of 20-digit runs.
 */

const PREFIX = "probe-chase-redrop-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "3522" };
const ADAM = "Zelle Payment From Adam Godina Jpm99aaaa001";
const LUKAS = "Zelle Payment From Lukas M Iera 10000000001";
const ADAM_ID = "10352560302000000063";
const LUKAS_ID = "10352560202000000062";
/** the live ledger's 2023-04-11 row: the identifier sat on a line of its own between "Card" and the wrapped "7782" */
const MTA_CLEAN = "Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card 7782";
const MTA_V1 = "Card Purchase 04/11 Mta*Mnr Etix Ticket 877-690-5116 NY Card 19947370303000000063 7782";
const NOTE = "cab back from the airport — Adam paid me back";
/** a line the statement printed without an identifier: the re-drop leaves its words alone */
const SOFIA = "Zelle Payment To Sofia Reyes 10000000002";

const STATEMENT: ParsedStatement[] = [
  {
    accountHint: CHECKING,
    txns: [
      { postedOn: "2023-04-11", amountCents: -500, rawDescription: MTA_V1 },
      { postedOn: "2023-06-01", amountCents: -1_500, rawDescription: SOFIA },
      { postedOn: "2023-10-18", amountCents: 2_000, rawDescription: `${LUKAS} ${LUKAS_ID}` },
      { postedOn: "2023-10-18", amountCents: 2_000, rawDescription: `${ADAM} ${ADAM_ID}` },
    ],
    period: { start: "2023-04-01", end: "2023-10-31", beginCents: 100_000, endCents: 100_000 - 500 - 1_500 + 4_000 },
  },
];
const profile: ParserProfile = {
  id: "test-probe-chase-redrop",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: () => STATEMENT,
};

let dir: string;
let beforePath: string;

type Row = typeof transactions.$inferSelect;
type Patch = Partial<typeof transactions.$inferInsert>;

/** Live rows of a ledger by their words, as v1 printed them. */
function liveRows(bundle: DbBundle): Row[] {
  const live = ne(transactions.status, "superseded");
  return bundle.db.select().from(transactions).where(live).orderBy(transactions.postedOn).all();
}
const byWords = (rows: readonly Row[], words: string): Row => rows.find((r) => r.rawDescription.startsWith(words))!;

type Edit = (bundle: DbBundle, rows: Row[]) => void;
function write(file: string, edit: Edit): void {
  const bundle = createDatabase(file);
  try {
    edit(bundle, liveRows(bundle));
  } finally {
    bundle.sqlite.close();
  }
}
/** A byte copy of the before-ledger with `edit` written into it — the ledger a re-drop would leave. */
function afterLedger(name: string, edit: Edit): string {
  const file = path.join(dir, `${name}.db`);
  fs.copyFileSync(beforePath, file);
  write(file, edit);
  return file;
}
const patch = (bundle: DbBundle, id: string, set: Patch) =>
  bundle.db.update(transactions).set(set).where(eq(transactions.id, id)).run();
/** New words for a line, derived the way the import derives them. */
const reword = (bundle: DbBundle, row: Row, raw: string) =>
  patch(bundle, row.id, { rawDescription: raw, normalizedDescription: normalizeDescription(raw) });
/** What a correct re-read prints for each v1 line: its words, the margin identifier gone. */
function cleanup(bundle: DbBundle, rows: Row[]): void {
  reword(bundle, byWords(rows, ADAM), ADAM);
  reword(bundle, byWords(rows, LUKAS), LUKAS);
  reword(bundle, byWords(rows, "Card Purchase 04/11"), MTA_CLEAN);
}
const HAND = ["categoryId", "categorizationSource", "categorizationConfidence", "needsReview", "notes"] as const;
const handWork = (r: Row): Patch => Object.fromEntries(HAND.map((c) => [c, r[c]]));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-probe-chase-redrop-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  beforePath = path.join(dir, "before.db");
  PROFILES.unshift(profile);
  const bundle = createDatabase(beforePath);
  try {
    seedDatabase(bundle.db);
    const file = { name: `${PREFIX}20231031-statements-3522-.pdf`, buffer: Buffer.from("v1") };
    const [outcome] = await importStatementFiles(bundle.db, [file]);
    expect(outcome).toMatchObject({ status: "parsed", inserted: 4 });
    const refunds = bundle.db.select().from(categories).where(eq(categories.name, "Refunds & Reimbursements")).get()!;
    // his hand on Adam's deposit: a category and a note, the work a crossed carry hands to the neighbour
    const adam = byWords(liveRows(bundle), ADAM);
    patch(bundle, adam.id, {
      categoryId: refunds.id,
      categorizationSource: "user",
      categorizationConfidence: 1,
      needsReview: false,
      notes: NOTE,
    });
    expect(handWork(byWords(liveRows(bundle), LUKAS))).not.toEqual(handWork(byWords(liveRows(bundle), ADAM)));
  } finally {
    bundle.sqlite.close();
  }
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

const verdictOn = (after: string) => judge(readLedger(beforePath), readLedger(after));

describe("the cleanup the re-drop is for", () => {
  test("every line loses its margin identifier, wherever it sat, and nothing else moves: clean", () => {
    const v = verdictOn(afterLedger("cleaned", cleanup));
    expect(v.other).toEqual([]);
    // the three that carried one; the line printed without one is not a move at all
    expect(v.cleaned.map((m) => m.after?.raw_description).sort()).toEqual([MTA_CLEAN, ADAM, LUKAS].sort());
    expect(v.moved).toHaveLength(3);
    expect(v.sameWorth).toBe(true);
    expect(v.clean).toBe(true);
  });
});

describe("what the probe exists to refuse", () => {
  /**
   * 🔴 The review of uc/chase-redrop-runbook, 2026-09-28: paired by the fewest differing fields, each old line
   * paired with the NEIGHBOUR that took its hand work — the pair then differs only in words, and any change of words
   * passed — so a crossed carry read ONLY WORDS MOVED and exited 0.
   */
  test("the owner's category and note crossed onto the neighbouring charge of the same money: not clean", () => {
    const after = afterLedger("crossed", (bundle, rows) => {
      cleanup(bundle, rows);
      const adam = byWords(rows, ADAM);
      const lukas = byWords(rows, LUKAS);
      patch(bundle, lukas.id, handWork(adam));
      patch(bundle, adam.id, handWork(lukas));
    });
    const v = verdictOn(after);
    expect(v.clean).toBe(false);
    expect(v.other).toHaveLength(2);
    // both deposits are named, each against its OWN old line, and what moved on each is his hand work
    for (const [words, id] of [
      [ADAM, ADAM_ID],
      [LUKAS, LUKAS_ID],
    ]) {
      const move = v.other.find((m) => m.after?.raw_description === words);
      expect(move?.before?.raw_description).toBe(`${words} ${id}`);
      expect(move?.fields).toEqual(expect.arrayContaining(["category_id", "notes"]));
    }
  });

  test("words that moved beyond the margin identifier: not clean", () => {
    const after = afterLedger("reworded", (bundle, rows) => {
      cleanup(bundle, rows);
      reword(bundle, byWords(rows, ADAM), "Zelle Payment From Adam Godinez Jpm99aaaa001");
    });
    const v = verdictOn(after);
    expect(v.clean).toBe(false);
    expect(v.other.map((m) => m.after?.raw_description)).toEqual(["Zelle Payment From Adam Godinez Jpm99aaaa001"]);
  });

  test("an identifier that moved instead of leaving is not a cleanup either", () => {
    const after = afterLedger("moved-id", (bundle, rows) => {
      cleanup(bundle, rows);
      reword(bundle, byWords(rows, "Card Purchase 04/11"), `${MTA_CLEAN} 19947370303000000063`);
    });
    expect(verdictOn(after).clean).toBe(false);
  });

  test("the normalized words may follow the printed ones, never move on their own", () => {
    // a line that lost its identifier, whose derived words went somewhere its printed words do not lead
    const astray = afterLedger("astray", (bundle, rows) => {
      cleanup(bundle, rows);
      patch(bundle, byWords(rows, ADAM).id, { normalizedDescription: "LUKAS M IERA" });
    });
    expect(verdictOn(astray).other.map((m) => m.after?.raw_description)).toEqual([ADAM]);
    // a line whose printed words did not move at all, re-derived by a newer normalizer: not the margin id either
    write(beforePath, (bundle, rows) => {
      patch(bundle, byWords(rows, SOFIA).id, { normalizedDescription: SOFIA.toUpperCase() });
    });
    const rederived = afterLedger("rederived", (bundle, rows) => {
      cleanup(bundle, rows);
      patch(bundle, byWords(rows, SOFIA).id, { normalizedDescription: normalizeDescription(SOFIA) });
    });
    const v = verdictOn(rederived);
    expect(v.other.map((m) => [m.after?.raw_description, m.fields])).toEqual([[SOFIA, ["normalized_description"]]]);
    expect(v.clean).toBe(false);
  });
});

describe("net worth on every day the ledger had", () => {
  const day = (d: string, cents: number) => ({ day: d, cents });
  const had = [day("2026-10-01", 100), day("2026-10-02", 120)];

  test("identical series: same, nothing carried", () => {
    expect(worthOnEveryDay(had, [...had])).toEqual({ same: true, carried: [] });
  });

  test("days the re-read adds past the last carry its last value: same, and named", () => {
    // re-deriving Chase Checking carries its last balance to the day the import runs
    const after = [...had, day("2026-10-03", 120), day("2026-10-04", 120)];
    expect(worthOnEveryDay(had, after)).toEqual({ same: true, carried: ["2026-10-03", "2026-10-04"] });
  });

  test("a day the ledger had that moved, or went missing, is not the same", () => {
    expect(worthOnEveryDay(had, [day("2026-10-01", 100), day("2026-10-02", 121)]).same).toBe(false);
    expect(worthOnEveryDay(had, [day("2026-10-02", 120)]).same).toBe(false);
    expect(worthOnEveryDay(had, [day("2026-09-30", 100), ...had]).same).toBe(false);
  });

  test("an added day that does not carry the last value is not the same", () => {
    expect(worthOnEveryDay(had, [...had, day("2026-10-03", 119)]).same).toBe(false);
  });
});
