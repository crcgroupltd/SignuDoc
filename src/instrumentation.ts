// Runs once when the server starts. On a long-running server (Docker, or
// `npm run start`) it starts the background jobs that a hosting platform's
// cron would otherwise call. See src/lib/scheduler.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // `next build` loads this file too; only a running server schedules jobs.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  const { startScheduler } = await import("./lib/scheduler.ts");
  startScheduler();
}
