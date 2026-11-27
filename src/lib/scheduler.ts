import type { EnvSource } from "./utils/env.ts";

// Runs the background jobs inside the app's own server process, so a
// Docker install needs no cron container or outside scheduler:
//
// - the daily cleanup and deadline expiry (src/lib/retention-job.ts), a
//   couple of minutes after the server starts and then once a day. It holds
//   a Postgres advisory lock, so two app containers cannot run it at once.
// - webhook deliveries that are due for another try
//   (src/lib/webhooks/deliver.ts), every few minutes.
//
// The HTTP routes under /api/internal still work for anyone who prefers an
// outside scheduler; set JOB_SCHEDULER=off to stop these timers.

export type ScheduledJob = {
  name: string;
  /** Delay before the first run. */
  firstRunMs: number;
  intervalMs: number;
  run: () => Promise<unknown>;
};

type Timer = { unref?: () => unknown };

export type SchedulerTimers = {
  setTimeout: (callback: () => void, ms: number) => Timer;
  setInterval: (callback: () => void, ms: number) => Timer;
};

export type SchedulerLogger = Pick<Console, "error" | "log">;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_WEBHOOK_RETRY_MINUTES = 5;

export function isSchedulerEnabled(env: EnvSource = process.env): boolean {
  const value = env.JOB_SCHEDULER?.trim().toLowerCase();

  return !(value === "off" || value === "0" || value === "false");
}

export function webhookRetryIntervalMs(env: EnvSource = process.env): number {
  const minutes = Number.parseInt(env.WEBHOOK_RETRY_MINUTES?.trim() ?? "", 10);

  return (
    (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
      ? minutes
      : DEFAULT_WEBHOOK_RETRY_MINUTES) * MINUTE_MS
  );
}

/** The jobs this app runs, loaded lazily so tests need no database. */
export function defaultJobs(env: EnvSource = process.env): ScheduledJob[] {
  return [
    {
      name: "retention",
      firstRunMs: 2 * MINUTE_MS,
      intervalMs: DAY_MS,
      run: async () => {
        const { runRetentionJob } = await import("./retention-job.ts");
        return runRetentionJob({ caller: "authorized" });
      },
    },
    {
      name: "webhooks",
      firstRunMs: MINUTE_MS,
      intervalMs: webhookRetryIntervalMs(env),
      run: async () => {
        const { drainWebhookDeliveries } =
          await import("./webhooks/deliver.ts");
        return drainWebhookDeliveries({ maxBatches: 8 });
      },
    },
  ];
}

/**
 * Starts each job on its timer. A run that is still going when the next one
 * is due is skipped, and a failure is logged and never thrown, so one bad
 * run cannot stop the server or the later runs.
 */
export function startJobs(
  jobs: ScheduledJob[],
  {
    logger = console,
    timers = globalThis,
  }: { logger?: SchedulerLogger; timers?: SchedulerTimers } = {},
): void {
  for (const job of jobs) {
    let running = false;

    const tick = () => {
      if (running) {
        return;
      }

      running = true;
      void job
        .run()
        .catch((error: unknown) => {
          logger.error(`[scheduler] The ${job.name} job failed:`, error);
        })
        .finally(() => {
          running = false;
        });
    };

    timers
      .setTimeout(() => {
        tick();
        timers.setInterval(tick, job.intervalMs).unref?.();
      }, job.firstRunMs)
      .unref?.();

    logger.log(
      `[scheduler] ${job.name}: first run in ${String(Math.round(job.firstRunMs / 1000))}s, then every ${String(Math.round(job.intervalMs / MINUTE_MS))} min.`,
    );
  }
}

declare global {
  var __signudocSchedulerStarted: boolean | undefined;
}

/** Called once from src/instrumentation.ts when the server starts. */
export function startScheduler(env: EnvSource = process.env): void {
  if (globalThis.__signudocSchedulerStarted) {
    return;
  }

  globalThis.__signudocSchedulerStarted = true;

  if (!isSchedulerEnabled(env)) {
    console.log("[scheduler] Off (JOB_SCHEDULER=off).");
    return;
  }

  startJobs(defaultJobs(env));
}
