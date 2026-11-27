import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSchedulerEnabled,
  startJobs,
  webhookRetryIntervalMs,
  type ScheduledJob,
  type SchedulerTimers,
} from "./scheduler.ts";

function fakeTimers() {
  const timeouts: Array<{ callback: () => void; ms: number }> = [];
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const timers: SchedulerTimers = {
    setTimeout: (callback, ms) => {
      timeouts.push({ callback, ms });
      return {};
    },
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return {};
    },
  };

  return { intervals, timeouts, timers };
}

const quietLogger = { error: () => {}, log: () => {} };

test("the scheduler is on unless JOB_SCHEDULER turns it off", () => {
  assert.equal(isSchedulerEnabled({}), true);
  assert.equal(isSchedulerEnabled({ JOB_SCHEDULER: "on" }), true);
  assert.equal(isSchedulerEnabled({ JOB_SCHEDULER: "off" }), false);
  assert.equal(isSchedulerEnabled({ JOB_SCHEDULER: " OFF " }), false);
  assert.equal(isSchedulerEnabled({ JOB_SCHEDULER: "0" }), false);
  assert.equal(isSchedulerEnabled({ JOB_SCHEDULER: "false" }), false);
});

test("webhook retries default to every 5 minutes and ignore bad values", () => {
  assert.equal(webhookRetryIntervalMs({}), 5 * 60 * 1000);
  assert.equal(
    webhookRetryIntervalMs({ WEBHOOK_RETRY_MINUTES: "15" }),
    15 * 60 * 1000,
  );
  assert.equal(
    webhookRetryIntervalMs({ WEBHOOK_RETRY_MINUTES: "0" }),
    5 * 60 * 1000,
  );
  assert.equal(
    webhookRetryIntervalMs({ WEBHOOK_RETRY_MINUTES: "soon" }),
    5 * 60 * 1000,
  );
});

test("a job runs after its first delay, then on its interval", async () => {
  const { intervals, timeouts, timers } = fakeTimers();
  let runs = 0;
  const job: ScheduledJob = {
    name: "test",
    firstRunMs: 1000,
    intervalMs: 5000,
    run: async () => {
      runs += 1;
    },
  };

  startJobs([job], { logger: quietLogger, timers });

  assert.equal(runs, 0);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0]?.ms, 1000);

  timeouts[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(intervals[0]?.ms, 5000);

  intervals[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
});

test("a failing run is logged and later runs still happen", async () => {
  const { intervals, timeouts, timers } = fakeTimers();
  const errors: unknown[] = [];
  let runs = 0;

  startJobs(
    [
      {
        name: "flaky",
        firstRunMs: 0,
        intervalMs: 1,
        run: async () => {
          runs += 1;
          throw new Error("boom");
        },
      },
    ],
    {
      logger: { error: (...args) => errors.push(args), log: () => {} },
      timers,
    },
  );

  timeouts[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  intervals[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runs, 2);
  assert.equal(errors.length, 2);
});

test("a run still going when the next is due is skipped", async () => {
  const { intervals, timeouts, timers } = fakeTimers();
  let started = 0;
  let finish: () => void = () => {};

  startJobs(
    [
      {
        name: "slow",
        firstRunMs: 0,
        intervalMs: 1,
        run: () => {
          started += 1;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      },
    ],
    { logger: quietLogger, timers },
  );

  timeouts[0]?.callback();
  intervals[0]?.callback();
  assert.equal(started, 1);

  finish();
  await new Promise((resolve) => setImmediate(resolve));
  intervals[0]?.callback();
  assert.equal(started, 2);
});
