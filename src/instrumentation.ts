/**
 * Runs once when the server boots (dev or start). All Node-specific work
 * lives in src/db/boot.ts behind a dynamic import — instrumentation is also
 * compiled for the edge runtime, which has no process.cwd/stderr.
 * The first-request-of-day snapshot check joins the request path in Phase 1
 * when pages start touching the database.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { bootDatabase } = await import("./db/boot");
  await bootDatabase();
}
