import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { preMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { readLeftOutAcknowledgements, writeLeftOutAcknowledgements } from "./left-out-acknowledgements";

let dir: string;
let bundle: DbBundle;
const opened: DbBundle[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-left-out-acks-"));
  bundle = createDatabase(path.join(dir, "ledger.db"));
  opened.push(bundle);
});

afterEach(() => {
  for (const b of opened.splice(0)) {
    if (b.sqlite.open) b.sqlite.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// the owner's Wells Fargo Everyday Checking, by the id his ledger gives it
const WF = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
const OPENING = {
  accountId: WF,
  printedOn: "2026-07-27",
  amountCents: 2500,
  printedWords: "WFB OPENING DEPOSIT FROM CARD",
  printerSha256: "1f".repeat(32),
  description: "WFB Opening Deposit From Card",
  acknowledgedOn: "2026-10-05",
};

describe("the acknowledgements a ledger keeps (`left_out_acknowledgements`)", () => {
  test("a migrated ledger holds none", () => {
    expect(readLeftOutAcknowledgements(bundle.db)).toEqual([]);
  });

  test("one written reads back as written, with an id and the moment it was recorded", () => {
    const before = new Date().toISOString();
    writeLeftOutAcknowledgements(bundle.db, [OPENING]);
    const [stored] = readLeftOutAcknowledgements(bundle.db);
    expect(stored).toMatchObject(OPENING);
    expect(stored!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored!.createdAt >= before).toBe(true);
  });

  test("two lines alike are two acknowledgements — one each", () => {
    writeLeftOutAcknowledgements(bundle.db, [OPENING, OPENING]);
    expect(readLeftOutAcknowledgements(bundle.db)).toHaveLength(2);
  });

  test("nothing to write writes nothing — the check touches the ledger only when told to", () => {
    const changes = () => (bundle.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    writeLeftOutAcknowledgements(bundle.db, []);
    expect(changes()).toBe(before);
  });

  test("a copy made from the ledger carries them — a rehearsal reads what the ledger acknowledged", () => {
    writeLeftOutAcknowledgements(bundle.db, [OPENING]);
    const snap = preMutationSnapshot(bundle.sqlite, path.join(dir, "rehearsal"), "rehearsal");
    const copy = createDatabase(snap.path!);
    opened.push(copy);
    expect(readLeftOutAcknowledgements(copy.db)).toEqual(readLeftOutAcknowledgements(bundle.db));
  });
});
