import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    /**
     * Pin the clock's ZONE, not its time.
     *
     * Pass 30 shipped a date bug that was undetectable on the developer's
     * Eastern box, because a "today" computed from local time agreed with the
     * expected value there and nowhere else. UTC is the wrong pin for that:
     * Eastern is UTC-5, so running under UTC on an Eastern machine makes the
     * local date equal the UTC date and HIDES exactly the disagreement worth
     * catching.
     *
     * Kiritimati is UTC+14 with no DST — the furthest a zone gets from Eastern
     * (19 hours), so any date derived from local time disagrees with a
     * UTC-derived one for most of the day, and the absence of DST keeps it
     * deterministic year-round.
     *
     * Measured before pinning: the suite is already timezone-independent —
     * 2,534 tests green at UTC+14, UTC-11, UTC+9 and UTC. This costs nothing
     * today and fails loudly the moment someone reintroduces the bug class.
     */
    env: { TZ: "Pacific/Kiritimati" },
    /**
     * ⛔ REFUSE TO RUN ON A SATURATED BOX. See `scripts/quiet-box.ts` for the
     * measurement: three runs, three different sets of failures, all of them
     * passing alone. Set VITEST_ALLOW_LOAD=1 to run anyway.
     */
    globalSetup: ["./scripts/vitest-global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/db/backup.ts", "src/db/derive/**"],
      thresholds: {
        "**/src/lib/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
