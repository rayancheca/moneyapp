import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listed } from "@/lib/ledger-check-listing";

/**
 * The pre-commit hook (.githooks/pre-commit) runs `pnpm ledger-check` and is quiet when it passes — but for what the
 * check NAMES and fails nothing on (`listed`): a read at two banks, a line left out that a session acknowledged, …
 *
 * 🔴 It threw the whole output away on a pass, so a listing showed only on a manual run (the handoff of 2026-10-07,
 * §6C): a read at two banks arriving between sessions was named to nobody.
 *
 * The hook is run as git runs it — `sh`, from the checkout — with a `pnpm` on PATH that prints what a run of the check
 * printed and exits as it did, so this tests the hook alone; what the check prints is tested where it is made
 * (ledger-check-listing.test.ts, and the source gates beside this file).
 */
const HOOK = path.join(process.cwd(), ".githooks", "pre-commit");

let dir: string;
let ledger: string;
let bin: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pre-commit-"));
  // the hook asks only that the ledger is there and not empty: the stand-in `pnpm` never opens it
  ledger = path.join(dir, "ledger.db");
  fs.writeFileSync(ledger, "not a ledger: the stand-in pnpm never opens it");
  bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    '#!/bin/sh\n[ "$*" = "--silent ledger-check" ] || { echo "unexpected: pnpm $*"; exit 9; }\ncat "$LEDGER_CHECK_PRINTS"\nexit "$LEDGER_CHECK_EXITS"\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The hook, after a run of the check that printed `lines` and exited `exits`. */
function commitAfter(lines: readonly string[], exits: number) {
  const prints = path.join(dir, "ledger-check.txt");
  fs.writeFileSync(prints, `${lines.join("\n")}\n`);
  const r = spawnSync("sh", [HOOK], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      MONEYAPP_DB_PATH: ledger,
      LEDGER_CHECK_PRINTS: prints,
      LEDGER_CHECK_EXITS: String(exits),
    },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** What a passing run prints of a healthy ledger — the shape his printed on a copy, 2026-10-08 — and nothing named. */
const HEALTHY = [
  "Cash on Hand: -$5,000.00 in the balance chain has no source document",
  "accounts standing only on the opening of a statement you un-imported: 0",
  "stale verdicts: 0",
  "value anchors: 43 checked · 1 disagree · 0 the app cannot value",
  "  Robinhood Brokerage 2025-08-31  off by $8.16",
  "import records: 0 parsed file(s) with no record of what they print — 0 the backfills can read, 0 read at a version their profile has moved past",
  "lines left out by a re-read: 0",
  "reads of accounts at two banks: 0",
  "witness marks: value anchors 43 · chain endpoints 222 · chain windows 212 · statement periods 256 · accounts 13",
  "",
  "ledger matches the recorded baseline, and no stored verdict has gone stale",
];

const TWO_BANKS = listed(
  "read at two banks",
  "x.pdf reads accounts at Robinhood and SoFi — one column names one bank, so the Chase it records is the importer's guess",
  { warns: true },
);
const ACKNOWLEDGED = listed("line-left-out, acknowledged", "+$25.00 on 2026-07-01, DEPOSIT, on Wells Fargo — Acknowledged on 2026-10-02: printed twice");
const KEPT = listed("kept opening", "Wells Fargo Everyday Checking stands only on the opening of a statement you un-imported (2026-07-01) — unchecked, and no witness");
const OLDER = listed(
  "beyond the backfills",
  "2 of them were read at a version their profile has moved past (a.pdf, b.pdf) — run:\n" +
    "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger>             # rehearse on a copy, write nothing\n" +
    "    pnpm tsx scripts/reread-unrecorded-files.ts --db=<ledger> --confirm   # restore point, write, re-check",
  { warns: true },
);

/** The same run, naming one of each kind under its count line. */
const NAMING = [
  "Cash on Hand: -$5,000.00 in the balance chain has no source document",
  "accounts standing only on the opening of a statement you un-imported: 1",
  KEPT,
  "stale verdicts: 0",
  "value anchors: 43 checked · 1 disagree · 0 the app cannot value",
  "  Robinhood Brokerage 2025-08-31  off by $8.16",
  "import records: 2 parsed file(s) with no record of what they print — 0 the backfills can read, 2 read at a version their profile has moved past",
  OLDER,
  "lines left out by a re-read: 1 — 1 acknowledged",
  ACKNOWLEDGED,
  "reads of accounts at two banks: 1",
  TWO_BANKS,
  "witness marks: value anchors 43 · chain endpoints 222 · chain windows 212 · statement periods 256 · accounts 13",
  "",
  "ledger matches the recorded baseline, and no stored verdict has gone stale",
];

describe("the pre-commit hook, when the ledger check passes", () => {
  test("says nothing of a healthy ledger that names nothing", () => {
    expect(commitAfter(HEALTHY, 0)).toEqual({ status: 0, out: "", err: "" });
  });

  test("prints each line the check names, under its count line, and none of the healthy ledger", () => {
    const { status, out, err } = commitAfter(NAMING, 0);
    expect(status).toBe(0);
    expect(out).toBe("");
    expect(err).toBe(
      [
        "pnpm ledger-check passed, and names what it does not fail on:",
        "accounts standing only on the opening of a statement you un-imported: 1",
        KEPT,
        "import records: 2 parsed file(s) with no record of what they print — 0 the backfills can read, 2 read at a version their profile has moved past",
        OLDER,
        "lines left out by a re-read: 1 — 1 acknowledged",
        ACKNOWLEDGED,
        "reads of accounts at two banks: 1",
        TWO_BANKS,
        "",
      ].join("\n"),
    );
  });

  test("a value the check disagrees with and has baselined is no listing: it is not printed", () => {
    const { err } = commitAfter(NAMING, 0);
    expect(err).not.toContain("off by");
    expect(err).not.toContain("no source document");
    expect(err).not.toContain("witness marks");
  });

  test("a listing's count line is printed once, however many it names", () => {
    const another = listed("read at two banks", "y.pdf reads accounts at Chase and SoFi — one column names one bank, so the Chase it records is the importer's guess", {
      warns: true,
    });
    const { err } = commitAfter([...HEALTHY.slice(0, 7), "reads of accounts at two banks: 2", TWO_BANKS, another, ...HEALTHY.slice(8)], 0);
    expect(err).toBe(
      ["pnpm ledger-check passed, and names what it does not fail on:", "reads of accounts at two banks: 2", TWO_BANKS, another, ""].join("\n"),
    );
  });
});

describe("the pre-commit hook, when the ledger check fails", () => {
  test("prints everything it printed, and stops the commit", () => {
    const failing = [...NAMING.slice(0, -2), "", "LEDGER CHECK FAILED — 1 finding(s):", "  [line-left-out 3f9a0c12de] -$4.00 on 2026-09-01"];
    const { status, out, err } = commitAfter(failing, 1);
    expect(status).toBe(1);
    expect(out).toBe("");
    expect(err.startsWith(`${failing.join("\n")}\n`)).toBe(true);
    expect(err).toContain("The ledger does not match its recorded baseline");
  });
});

describe("the pre-commit hook, without a ledger", () => {
  test("is silent, and asks nothing of the check", () => {
    fs.rmSync(ledger);
    expect(commitAfter(NAMING, 1)).toEqual({ status: 0, out: "", err: "" });
  });
});
