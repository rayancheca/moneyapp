import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/db/backup.ts", "src/db/derive/**"],
      thresholds: {
        "**/src/lib/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
