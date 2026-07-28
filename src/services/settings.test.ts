import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { appSettings } from "@/db/schema/settings";
import { DEFAULT_SETTINGS, seedDatabase } from "@/db/seed";
import { readSettings, writeSetting } from "./settings";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-settings-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a raw row straight past writeSetting's validation, as a drifted DB would hold it. */
function putRaw(key: string, storedValue: string): void {
  bundle.db
    .insert(appSettings)
    .values({ key, value: storedValue })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: storedValue } })
    .run();
}

describe("readSettings — degrades to defaults instead of throwing", () => {
  test("a seeded database reads back every default unchanged", () => {
    const s = readSettings(bundle.db);
    expect(s.aiMonthlyCapUsd).toBe(DEFAULT_SETTINGS.aiMonthlyCapUsd);
    expect(s.priceStalenessHours).toBe(DEFAULT_SETTINGS.priceStalenessHours);
    expect(s.backupRetention).toEqual(DEFAULT_SETTINGS.backupRetention);
    // schema-level .default()s fill the keys the seed deliberately omits
    expect(s.benchmarkSymbol).toBe("SPY");
    expect(s.viewPreferences).toEqual({});
  });

  test("a value that is not valid JSON falls back to the default", () => {
    putRaw("aiMonthlyCapUsd", "not json at all");

    expect(() => readSettings(bundle.db)).not.toThrow();
    expect(readSettings(bundle.db).aiMonthlyCapUsd).toBe(DEFAULT_SETTINGS.aiMonthlyCapUsd);
  });

  test("a wrong-typed value falls back to the default without discarding the good ones", () => {
    writeSetting(bundle.db, "priceStalenessHours", 9);
    putRaw("aiMonthlyCapUsd", JSON.stringify("five dollars")); // string where a number belongs

    const s = readSettings(bundle.db);
    expect(s.aiMonthlyCapUsd).toBe(DEFAULT_SETTINGS.aiMonthlyCapUsd);
    expect(s.priceStalenessHours).toBe(9); // the other persisted value survives the repair
  });

  test("an out-of-range value falls back rather than reaching the UI", () => {
    putRaw("categorizationConfidenceMin", JSON.stringify(42)); // schema caps this at 1

    expect(readSettings(bundle.db).categorizationConfidenceMin).toBe(
      DEFAULT_SETTINGS.categorizationConfidenceMin,
    );
  });

  test("a malformed nested object falls back whole", () => {
    putRaw("backupRetention", JSON.stringify({ keepDaily: 0 })); // min(1), and keepMonthly missing

    expect(readSettings(bundle.db).backupRetention).toEqual(DEFAULT_SETTINGS.backupRetention);
  });

  test("several bad values at once still yield a fully usable settings object", () => {
    putRaw("aiMonthlyCapUsd", "{");
    putRaw("weekStartsOn", JSON.stringify("sunday"));
    putRaw("reviewCreditThresholdCents", JSON.stringify(-1));

    const s = readSettings(bundle.db);
    expect(s.aiMonthlyCapUsd).toBe(DEFAULT_SETTINGS.aiMonthlyCapUsd);
    expect(s.weekStartsOn).toBe("monday");
    expect(s.reviewCreditThresholdCents).toBe(DEFAULT_SETTINGS.reviewCreditThresholdCents);
  });

  test("writeSetting still lands a good value while another row is malformed", () => {
    putRaw("aiMonthlyCapUsd", "not json at all");

    // writeSetting reads the current shape first — that read must not throw
    expect(() => writeSetting(bundle.db, "benchmarkSymbol", "QQQ")).not.toThrow();
    expect(readSettings(bundle.db).benchmarkSymbol).toBe("QQQ");
  });

  test("writeSetting still refuses an invalid value", () => {
    expect(() => writeSetting(bundle.db, "priceStalenessHours", 0)).toThrow();
  });
});
