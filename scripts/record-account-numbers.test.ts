import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accountNumbers } from "@/db/schema/account-numbers";
import { accounts } from "@/db/schema/accounts";
import { importFiles } from "@/db/schema/imports";
import { PROFILES } from "@/services/import/profiles";
import { findAccountId, importStatementFiles, resolveAccount, unimportFile, type ImportInput } from "@/services/import/service";
import type { ParsedStatement, ParserProfile } from "@/services/import/types";
import { scanNumbers, writeNumbers } from "./record-account-numbers";

/** Venture X's shape: a statement printed under the card's earlier number, filed by the owner under the reissued card. */
const PREFIX = "reissued-statement-";
const profile: ParserProfile = {
  id: "test-reissued-statement",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f): ParsedStatement[] => {
    const [last4, month] = f.text.trim().split(" ") as [string, string];
    return [
      {
        accountHint: { institution: "Capital One", type: "credit", last4, name: "Venture X" },
        txns: [{ postedOn: `2026-${month}-10`, amountCents: -1000, rawDescription: `PURCHASE ${month}` }],
        period: { start: `2026-${month}-01`, end: `2026-${month}-28`, beginCents: 0, endCents: -1000 },
      },
    ];
  },
};
const statement = (last4: string, month: string): ImportInput => ({ name: `${PREFIX}${month}.txt`, buffer: Buffer.from(`${last4} ${month}`) });

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-numbers-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

/** Two statements under 9082 and one under 4208, all filed under one card that now carries 4208. */
async function mergedByHand(): Promise<string> {
  await importStatementFiles(bundle.db, [statement("9082", "02"), statement("9082", "03")]);
  const card = bundle.db.select().from(accounts).where(eq(accounts.last4, "9082")).get()!.id;
  bundle.db.update(accounts).set({ last4: "4208" }).where(eq(accounts.id, card)).run();
  await importStatementFiles(bundle.db, [statement("4208", "04")]);
  return card;
}

describe("record-account-numbers — the numbers a card's filed statements print", () => {
  test("records the earlier number once, from the statements filed under the card, and a re-import then finds the card", async () => {
    const card = await mergedByHand();
    const hint = { institution: "Capital One", type: "credit", last4: "9082" } as const;
    expect(findAccountId(bundle.db, hint)).toBeNull();

    const scan = await scanNumbers(bundle, 0, 100);
    expect(scan.planned.map((p) => [p.accountId, p.last4, p.evidence.length])).toEqual([[card, "9082", 2]]);
    writeNumbers(bundle, scan.planned);

    expect(bundle.db.select().from(accountNumbers).all().map((r) => [r.accountId, r.last4])).toEqual([[card, "9082"]]);
    expect(findAccountId(bundle.db, hint)).toBe(card);
    const again = await scanNumbers(bundle, 0, 100);
    expect({ planned: again.planned.length, alreadyRecorded: again.alreadyRecorded }).toEqual({ planned: 0, alreadyRecorded: 2 });

    const february = bundle.db.select().from(importFiles).where(eq(importFiles.fileName, statement("9082", "02").name)).get()!;
    unimportFile(bundle.db, february.id);
    await importStatementFiles(bundle.db, [statement("9082", "02")]);
    expect(bundle.db.select().from(accounts).where(eq(accounts.name, "Venture X")).all().map((a) => a.id)).toEqual([card]);
  });

  test("refuses a number another account at the institution carries", async () => {
    await mergedByHand();
    resolveAccount(bundle.db, { institution: "Capital One", type: "credit", last4: "9082", name: "Quicksilver" });

    const scan = await scanNumbers(bundle, 0, 100);

    expect(scan.planned).toEqual([]);
    expect(scan.skipped.filter((s) => s.includes("Quicksilver carries that number"))).toHaveLength(2);
  });
});
