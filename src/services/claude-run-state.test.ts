import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { appSettings } from "@/db/schema/settings";
import { readSettings } from "./settings";
import {
  claudeRunState,
  classifyPendingMerchants,
  requestClaudeStop,
} from "./claude-categorize";

// NO network — no ANTHROPIC_API_KEY means the service no-ops before any call
delete process.env.ANTHROPIC_API_KEY;
process.env.MONEYAPP_FAKE_PRICES = "1";

describe("Claude run state — visibility and the Stop control", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-claude-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("fresh database: not running, no last run", () => {
    const state = claudeRunState(bundle.db);
    expect(state.isRunning).toBe(false);
    expect(state.lastRun).toBeNull();
  });

  test("requestClaudeStop round-trips without corrupting typed settings", () => {
    requestClaudeStop(bundle.db);
    // the strict settings schema must still parse (extra keys are ignored)
    expect(() => readSettings(bundle.db)).not.toThrow();
    expect(claudeRunState(bundle.db).isRunning).toBe(false);
  });

  test("keyless run no-ops without ever flipping the running flag", async () => {
    const result = await classifyPendingMerchants(bundle.db);
    expect(result.ran).toBe(false);
    expect(claudeRunState(bundle.db).isRunning).toBe(false);
    expect(claudeRunState(bundle.db).lastRun).toBeNull();
  });

  test("a stale running flag reads as not running", () => {
    // simulate a crash 20 minutes ago (flag never cleared)
    bundle.db
      .insert(appSettings)
      .values({
        key: "claudeRunStartedAt",
        value: JSON.stringify(new Date(Date.now() - 20 * 60_000).toISOString()),
      })
      .run();
    expect(claudeRunState(bundle.db).isRunning).toBe(false);
    expect(
      claudeRunState(bundle.db, new Date(Date.now() - 18 * 60_000)).isRunning,
    ).toBe(true); // …but it WAS running from the perspective of 18 minutes ago
  });
});
