import fs from "node:fs";
import path from "node:path";

/** E2E runs against a dedicated, freshly-created database — never dev data. */
export default function globalSetup(): void {
  const dbPath = path.join(process.cwd(), "data", "e2e.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
