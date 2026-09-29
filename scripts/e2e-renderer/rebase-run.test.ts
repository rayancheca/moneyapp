import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { GateFails } from "./gate-comparator";
import { gateComparator, judgeAll } from "./rebase-run";
import { SNAPSHOT_ROOT_ENV } from "./snapshot-root";

describe("gateComparator", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("reads the gate's own options from playwright.config.ts", async () => {
    vi.stubEnv("E2E_GATE", "");
    vi.stubEnv(SNAPSHOT_ROOT_ENV, "");
    expect(await gateComparator()).toHaveProperty("fails");
  });

  /**
   * The command reads playwright.config.ts in its own process, under whatever its shell holds. A
   * gate's E2E_GATE with a snapshot root left beside it makes the config refuse to load: that is
   * the comparator unavailable, said once and re-based as though the gate failed each file, never
   * a crash after an eight-minute control.
   */
  test("a config that refuses to load is the comparator unavailable, not a crash", async () => {
    vi.stubEnv("E2E_GATE", "1");
    vi.stubEnv(SNAPSHOT_ROOT_ENV, "/tmp/e2e-rebase-renderer-x/snapshots");
    expect(await gateComparator()).toEqual({
      unavailable: expect.stringMatching(/^playwright\.config\.ts did not load: .*would point a gate/),
    });
  });
});

/**
 * An 8x8 grey square with one pixel `delta` levels brighter. diffVerdict calls 5 levels renderer
 * drift and 100 content, which is all these tests need: which pairs judgeAll puts to the gate.
 */
async function square(delta = 0): Promise<Buffer> {
  const data = Buffer.alloc(8 * 8 * 4, 255);
  for (let i = 0; i < 64; i++) data.fill(40, i * 4, i * 4 + 3);
  data.fill(40 + delta, 27 * 4, 27 * 4 + 3);
  return sharp(data, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
}

const KINDS = [
  ["identical", 0],
  ["drift", 5],
  ["content", 100],
] as const;

describe("judgeAll", () => {
  let dir = "";
  const root = () => path.join(dir, "snapshots");
  /** each baseline by its full path, each twin relative to the root, as the command pairs them */
  const pairs = () =>
    KINDS.map(([name]) => ({
      baseline: path.join(dir, "e2e", `${name}.png`),
      twin: `${name}.png`,
    }));
  const quiet = () => undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-all-"));
    fs.mkdirSync(path.join(dir, "e2e"));
    fs.mkdirSync(root());
    const committed = await square();
    for (const [name, delta] of KINDS) {
      fs.writeFileSync(path.join(dir, "e2e", `${name}.png`), committed);
      fs.writeFileSync(path.join(root(), `${name}.png`), await square(delta));
    }
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("only the renderer-only pair is put to the gate, and its answer is kept", async () => {
    for (const [said, answer] of [
      [true, "fails"],
      [false, "passes"],
    ] as const) {
      let asked = 0;
      const gate: GateFails = () => {
        asked++;
        return said;
      };
      const judged = await judgeAll(pairs(), root(), gate, quiet, quiet);
      expect(judged.map((j) => [path.basename(j.baseline), j.verdict.verdict, j.gate])).toEqual([
        ["identical.png", "identical", undefined],
        ["drift.png", "renderer-only", answer],
        ["content.png", "content", undefined],
      ]);
      expect(asked).toBe(1);
    }
  });

  /** The caller says once that the comparator is unavailable; each file is not said again. */
  test("no comparator: the renderer-only pair is unknown, which the plan re-bases", async () => {
    const heard: string[] = [];
    const judged = await judgeAll(pairs(), root(), null, quiet, (baseline) => heard.push(baseline));
    expect(judged[1]?.gate).toBe("unknown");
    expect(heard).toEqual([]);
  });

  test("a comparator that throws: unknown, and the caller hears which pair and why", async () => {
    const heard: [string, string][] = [];
    const broken: GateFails = () => {
      throw new Error("Could not decode expected image as PNG.");
    };
    const judged = await judgeAll(pairs(), root(), broken, quiet, (baseline, why) =>
      heard.push([baseline, why]),
    );
    expect(judged[1]?.gate).toBe("unknown");
    expect(heard).toEqual([[pairs()[1]!.baseline, "Could not decode expected image as PNG."]]);
  });
});
