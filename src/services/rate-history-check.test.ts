import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { rateHistoryRefusals, storedRateHistoryCount } from "./rate-history-check";

/**
 * ⛔ `user_amount_history` is JSON with no constraint (§6A 55), and the app's one reader refuses what it cannot read —
 * so a bad history would refuse every page that projects the series. `pnpm ledger-check` names each one first, with
 * the series and what the reader refused, so a guarded write that got it wrong fails the next run, not his dashboard.
 */
let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rate-history-"));
  bundle = createDatabase(path.join(dir, "t.db"));
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Amounts {
  user: number | null;
  detected: number | null;
}

function addSeries(id: string, name: string, history: string | null, amounts: Amounts = { user: 114_192, detected: 104_600 }) {
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: "income",
      cadence: "weekly",
      status: "confirmed",
      userAmountCents: amounts.user,
      nextExpectedAmountCents: amounts.detected,
    })
    .run();
  // raw text, the way a script's SQL would store it — the app's own writer could not store most of these
  bundle.sqlite.prepare("UPDATE recurring_series SET user_amount_history = ? WHERE id = ?").run(history, id);
}

describe("rateHistoryRefusals", () => {
  test("no history anywhere, and his own history, are refused by nothing", () => {
    addSeries("s-flat", "Rent", null);
    addSeries("s-pay", "It America LLC (weekly pay)", '[{"throughOn":"2026-08-26","amountCents":104700}]');
    expect(rateHistoryRefusals(bundle.db)).toEqual([]);
    expect(storedRateHistoryCount(bundle.db)).toBe(1);
  });

  test("names each series whose history the reader refuses, and why — and only those", () => {
    addSeries("s-pay", "It America LLC (weekly pay)", '[{"throughOn":"2026-08-26","amountCents":104700}]');
    addSeries("s-empty", "Empty", "[]");
    addSeries("s-text", "Not JSON", "[{throughOn:2026-08-26}]");
    addSeries("s-sign", "Wrong way", '[{"throughOn":"2026-08-26","amountCents":-104700}]');
    const refusals = rateHistoryRefusals(bundle.db);
    expect(refusals.map((r) => r.seriesId).sort()).toEqual(["s-empty", "s-sign", "s-text"]);
    expect(refusals.find((r) => r.seriesId === "s-empty")).toMatchObject({ name: "Empty" });
    expect(refusals.find((r) => r.seriesId === "s-empty")!.reason).toMatch(/empty list/);
    expect(refusals.find((r) => r.seriesId === "s-text")!.reason).toMatch(/not JSON/);
    expect(refusals.find((r) => r.seriesId === "s-sign")!.reason).toMatch(/the other way/);
    expect(storedRateHistoryCount(bundle.db)).toBe(4);
  });

  test("the direction is held to the series' amount now — the owner's, else detection's", () => {
    addSeries("s-detected", "Detected only", '[{"throughOn":"2026-08-26","amountCents":104700}]', {
      user: null,
      detected: -104_600,
    });
    expect(rateHistoryRefusals(bundle.db).map((r) => r.seriesId)).toEqual(["s-detected"]);
  });

  test("the sentence names the series, its id and the reader's refusal", () => {
    addSeries("s-empty", "Empty", "[]");
    expect(rateHistoryRefusals(bundle.db)[0]!.sentence).toBe(
      'The rate history of "Empty" (s-empty) cannot be read — user_amount_history: an empty list — a series with no ' +
        "history stores NULL. Every page that projects it refuses it until the history is fixed or set back to NULL.",
    );
  });
});
