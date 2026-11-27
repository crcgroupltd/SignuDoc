import assert from "node:assert/strict";
import { test } from "node:test";

import { emailNeedsAttention, getEmailStatus } from "./email-status.ts";
import type { MailTransport } from "./services/email.ts";
import { resolveSettings, type AppSettings } from "./settings.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["acme.com"],
  brandColor: null,
  consentDisclosure: null,
  emailReadyAt: null,
  logoVersion: null,
  organizationName: "Acme Corp",
  part11Mode: false,
  requireTwoFactor: false,
  sessionIdleMinutes: null,
  sessionMaxHours: null,
  privacyUrl: null,
  retentionDays: null,
  senderAddress: "sign@acme.com",
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: null,
  termsUrl: null,
};

const env = {
  NODE_ENV: "production",
  SMTP_HOST: "smtp.acme.com",
  SMTP_PORT: "587",
};
const settings = resolveSettings(stored, env);

function transport(verify: () => Promise<unknown>): MailTransport {
  return {
    async sendMail() {
      return { accepted: [], rejected: [] };
    },
    verify,
  };
}

test("with no SMTP_HOST, email is not connected", async () => {
  assert.deepEqual(
    await getEmailStatus({ env: { NODE_ENV: "production" }, settings }),
    { state: "missing_config" },
  );
});

test("a server that answers, before any test email, waits for one", async () => {
  assert.deepEqual(
    await getEmailStatus({
      env,
      settings,
      transport: transport(async () => true),
    }),
    {
      senderAddress: "sign@acme.com",
      server: "smtp.acme.com:587",
      state: "untested",
    },
  );
});

test("after a test email has gone out, email is ready", async () => {
  const readySettings = resolveSettings(
    { ...stored, emailReadyAt: 1_800_000_100 },
    env,
  );

  assert.equal(
    (
      await getEmailStatus({
        env,
        settings: readySettings,
        transport: transport(async () => true),
      })
    ).state,
    "ready",
  );
});

test("a server that cannot be reached or refuses the sign-in is reported in its own words", async () => {
  assert.deepEqual(
    await getEmailStatus({
      env,
      settings,
      transport: transport(async () => {
        throw new Error("Invalid login: 535 Authentication failed");
      }),
    }),
    {
      message: "Invalid login: 535 Authentication failed",
      senderAddress: "sign@acme.com",
      server: "smtp.acme.com:587",
      state: "error",
    },
  );
});

test("SMTP_FROM wins over the saved sender", async () => {
  const fromEnv = { ...env, SMTP_FROM: "Acme <notify@acme.com>" };

  assert.equal(
    (
      await getEmailStatus({
        env: fromEnv,
        settings: resolveSettings(stored, fromEnv),
        transport: transport(async () => true),
      })
    ).state === "untested",
    true,
  );
});

test("the capture driver is reported, or refused on a deployed site", async () => {
  assert.deepEqual(
    await getEmailStatus({ env: { EMAIL_DRIVER: "capture" }, settings }),
    { state: "capture" },
  );
  assert.deepEqual(
    await getEmailStatus({
      env: {
        APP_URL: "https://sign.acme.com",
        EMAIL_DRIVER: "capture",
        NODE_ENV: "production",
      },
      settings,
    }),
    { state: "capture_refused" },
  );
});

test("the administrator is told about email until it has been seen working", () => {
  const readySettings = resolveSettings(
    { ...stored, emailReadyAt: 1_800_000_100 },
    env,
  );

  assert.equal(emailNeedsAttention(settings, env), true);
  assert.equal(emailNeedsAttention(readySettings, env), false);

  // Nothing to set up when messages are legitimately being captured locally.
  assert.equal(
    emailNeedsAttention(settings, { EMAIL_DRIVER: "capture" }),
    false,
  );
  assert.equal(
    emailNeedsAttention(settings, {
      EMAIL_DRIVER: "capture",
      NODE_ENV: "development",
    }),
    false,
  );
  assert.equal(
    emailNeedsAttention(settings, {
      APP_URL: "http://localhost:3207",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(
    emailNeedsAttention(settings, {
      APP_URL: "http://127.0.0.1:3207",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );

  // When capture is refused in production or on Vercel, the administrator must
  // be warned even if email had previously been marked ready.
  const deployedProductionCaptureEnv = {
    APP_URL: "https://sign.example.com",
    EMAIL_DRIVER: "capture",
    NODE_ENV: "production",
  };

  assert.equal(
    emailNeedsAttention(settings, deployedProductionCaptureEnv),
    true,
  );
  assert.equal(
    emailNeedsAttention(readySettings, deployedProductionCaptureEnv),
    true,
  );
  assert.equal(
    emailNeedsAttention(settings, {
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    true,
  );
  assert.equal(
    emailNeedsAttention(settings, { EMAIL_DRIVER: "capture", VERCEL: "1" }),
    true,
  );
  assert.equal(
    emailNeedsAttention(readySettings, {
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
      VERCEL: "1",
    }),
    true,
  );
});
