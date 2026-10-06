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
  reason: "July statement, page 1: the bank's opening deposit, reversed the same day by the card it came from",
};

const changes = () => (bundle.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

describe("the acknowledgements a ledger keeps (`left_out_acknowledgements`)", () => {
  test("a migrated ledger holds none", () => {
    expect(readLeftOutAcknowledgements(bundle.db)).toEqual([]);
  });

  test("one written reads back as written — its reason too — with an id and the moment it was recorded", () => {
    const before = new Date().toISOString();
    writeLeftOutAcknowledgements(bundle.db, [OPENING]);
    const [stored] = readLeftOutAcknowledgements(bundle.db);
    expect(stored).toMatchObject(OPENING);
    expect(stored!.reason).toBe(OPENING.reason);
    expect(stored!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored!.createdAt >= before).toBe(true);
  });

  /* ⛔ "an entry without a reason is a check that has been quieted" (ledger-check's BASELINE): the table holds none */
  test("⛔ the table refuses a row with no reason", () => {
    const columns = bundle.sqlite.prepare("PRAGMA table_info(left_out_acknowledgements)").all() as { name: string; notnull: number }[];
    expect(columns.find((c) => c.name === "reason")).toEqual(expect.objectContaining({ notnull: 1 }));
    const insert = bundle.sqlite.prepare(
      "INSERT INTO left_out_acknowledgements (id, account_id, printed_on, amount_cents, printed_words, printer_sha256, " +
        "description, acknowledged_on, created_at) VALUES ('a', ?, '2026-07-27', 2500, 'W', 'S', 'D', '2026-10-05', 'T')",
    );
    expect(() => insert.run(WF)).toThrow(/NOT NULL constraint failed: left_out_acknowledgements\.reason/);
  });

  /*
   * 🔴 "Never blank" was the writer's alone: a raw INSERT with reason '   ' was stored, and ledger-check printed
   * "Acknowledged on 2026-10-05:    " — a check quieted. The table refuses it now, whoever writes.
   */
  test("⛔ the table refuses a reason that says nothing, from a raw INSERT too", () => {
    const insert = bundle.sqlite.prepare(
      "INSERT INTO left_out_acknowledgements (id, account_id, printed_on, amount_cents, printed_words, printer_sha256, " +
        "description, acknowledged_on, reason, created_at) VALUES (?, ?, '2026-07-27', 2500, 'W', 'S', 'D', '2026-10-05', ?, 'T')",
    );
    const refused = /CHECK constraint failed: left_out_acknowledgements_reason_says_something/;
    for (const [i, reason] of ["", "   ", "\n\t", " \r\n ", "\v\f "].entries()) {
      expect(() => insert.run(`blank-${i}`, WF, reason)).toThrow(refused);
    }
    expect(readLeftOutAcknowledgements(bundle.db)).toEqual([]);
    // what the session read, padded or not, is a reason
    insert.run("read", WF, " Printed on the July statement. ");
    expect(readLeftOutAcknowledgements(bundle.db).map((a) => a.reason)).toEqual([" Printed on the July statement. "]);
  });

  test("⛔ a reason that says nothing refuses the whole write — nothing is written", () => {
    for (const reason of ["", "   ", "\n\t"]) {
      const before = changes();
      expect(() => writeLeftOutAcknowledgements(bundle.db, [OPENING, { ...OPENING, reason }])).toThrow(
        /an acknowledgement says what the session read on the statement/,
      );
      expect(changes()).toBe(before);
    }
    expect(readLeftOutAcknowledgements(bundle.db)).toEqual([]);
  });

  test("two lines alike are two acknowledgements — one each", () => {
    writeLeftOutAcknowledgements(bundle.db, [OPENING, OPENING]);
    expect(readLeftOutAcknowledgements(bundle.db)).toHaveLength(2);
  });

  test("nothing to write writes nothing — the check touches the ledger only when told to", () => {
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
