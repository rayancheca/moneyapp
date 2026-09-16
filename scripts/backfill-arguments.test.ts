import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main as recordAccountNumbers } from "./record-account-numbers";
import { main as recordPrintedLines } from "./record-printed-lines";
import { main as recordStatementCopies } from "./record-statement-copies";

/**
 * 🔴 The three record backfills each read their own command line, and removing the refusal of an unknown argument
 * from all three failed no test (the review of uc/final-integrate, 2026-09-16). `--confirm=yes` ran a dry run and
 * exited 0, which reads like a write that happened. Each script's `main` is asked here, before it opens anything.
 */

let dir: string;
let copy: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-backfill-args-"));
  copy = path.join(dir, "copy.db");
  // a file that is no database: a script that got past its arguments would fail on it with another message
  fs.writeFileSync(copy, "not a database");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["record-account-numbers", recordAccountNumbers],
  ["record-printed-lines", recordPrintedLines],
  ["record-statement-copies", recordStatementCopies],
])("%s refuses what it does not take, before it opens the database", (_, main) => {
  test.each([["-confirm"], ["confirm"], ["--confirm=yes"], ["--confrim"]])("%s", async (arg) => {
    await expect(main([`--db=${copy}`, `--scratch=${dir}`, arg])).rejects.toThrow(`unknown argument(s): ${arg}`);
  });

  test("--db <path>", async () => {
    await expect(main(["--db", copy, `--scratch=${dir}`])).rejects.toThrow("--db needs a value");
  });
});
