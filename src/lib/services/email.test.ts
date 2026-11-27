import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CAPTURE_IN_PRODUCTION_ERROR_MESSAGE,
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  defaultSenderAddress,
  isCaptureEmailDriverAllowed,
  resolveEmailDriver,
  type EmailService,
  type MailTransport,
} from "./email.ts";

// What the SMTP transport is asked to send. Nothing here talks to a mail
// server.

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

type SentMail = Parameters<MailTransport["sendMail"]>[0];

function serviceWithTransport(
  answer: (mail: SentMail) => Awaited<ReturnType<MailTransport["sendMail"]>>,
) {
  const sent: SentMail[] = [];
  const service = createEmailService({
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: "help@example.test",
    }),
    transport: {
      async sendMail(mail) {
        sent.push(mail);
        return answer(mail);
      },
      async verify() {
        return true;
      },
    },
  });

  return { sent, service };
}

test("a message goes to the SMTP server with its sender, reply-to and attachments", async () => {
  const { sent, service } = serviceWithTransport(() => ({
    accepted: ["signer@example.test"],
    messageId: "<m-1@example.test>",
    rejected: [],
  }));

  const delivery = await service.send({
    ...MESSAGE,
    attachments: [
      {
        content: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        filename: "signed.pdf",
      },
    ],
    htmlBody: "<p>Attached.</p>",
  });

  assert.equal(delivery.messageId, "<m-1@example.test>");
  assert.deepEqual(delivery.accepted, ["signer@example.test"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.from, "Example <hello@example.test>");
  assert.equal(sent[0]?.replyTo, "help@example.test");
  assert.equal(sent[0]?.to, "signer@example.test");
  assert.equal(sent[0]?.subject, "Your signed copy");
  assert.equal(sent[0]?.html, "<p>Attached.</p>");
  assert.equal(sent[0]?.text, "Attached.");
  assert.deepEqual(sent[0]?.headers, {
    "X-SignuDoc-Template": "completion_notification",
  });
  assert.equal(
    Array.isArray(sent[0]?.attachments) && sent[0].attachments[0]?.filename,
    "signed.pdf",
  );
});

test("a recipient the SMTP server refuses is reported as a failure", async () => {
  const { service } = serviceWithTransport(() => ({
    accepted: [],
    rejected: ["signer@example.test"],
  }));

  await assert.rejects(service.send(MESSAGE), /refused signer@example\.test/);
});

test("an SMTP error is passed on", async () => {
  const { service } = serviceWithTransport(() => {
    throw new Error("535 Authentication failed");
  });

  await assert.rejects(service.send(MESSAGE), /535 Authentication failed/);
});

test("a batch is sent one message at a time", async () => {
  const { sent, service } = serviceWithTransport((mail) => ({
    accepted: [String(mail.to)],
    messageId: `<${String(mail.to)}>`,
    rejected: [],
  }));

  const results = await service.sendBatch([
    MESSAGE,
    { ...MESSAGE, to: "second@example.test" },
  ]);

  assert.equal(sent.length, 2);
  assert.deepEqual(
    results.map((result) => result.messageId),
    ["<signer@example.test>", "<second@example.test>"],
  );
});

test("SMTP is the default driver, and only smtp or capture are accepted", () => {
  assert.equal(resolveEmailDriver({}), "smtp");
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "SMTP" }), "smtp");
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "capture" }), "capture");
  assert.throws(
    () => resolveEmailDriver({ EMAIL_DRIVER: "resend" }),
    /Use "smtp" or "capture"/,
  );
});

test("with no sender set, mail comes from the SMTP account or no-reply at the site's domain", () => {
  assert.equal(
    defaultSenderAddress({ SMTP_USER: "sign@acme.com" }),
    "sign@acme.com",
  );
  assert.equal(
    defaultSenderAddress({
      APP_URL: "https://sign.acme.com",
      SMTP_USER: "apikey",
    }),
    "no-reply@sign.acme.com",
  );
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /SMTP_HOST/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", SMTP_HOST: "smtp.example.test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // A local production build on localhost may still use the capture driver.
  assert.equal(
    canSendEmail({
      APP_URL: "http://localhost:3207",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it, even
  // when a mail server is also configured in the environment.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
      SMTP_HOST: "smtp.example.test",
    }),
    false,
  );
  assert.equal(canSendEmail({ EMAIL_DRIVER: "capture", VERCEL: "1" }), false);
  assert.equal(
    canSendEmail({
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
      VERCEL: "1",
    }),
    false,
  );
});

test("the capture driver is allowed in development and local production builds, but refused in deployed production and on Vercel (issue #212)", async () => {
  assert.equal(isCaptureEmailDriverAllowed({}), true);
  assert.equal(isCaptureEmailDriverAllowed({ NODE_ENV: "development" }), true);
  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "http://localhost:3207",
      NODE_ENV: "production",
    }),
    true,
  );
  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "http://127.0.0.1:3207",
      NODE_ENV: "production",
    }),
    true,
  );
  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "http://[::1]:3207",
      NODE_ENV: "production",
    }),
    true,
  );

  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "https://sign.example.com",
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(isCaptureEmailDriverAllowed({ NODE_ENV: "production" }), false);
  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "http://sign.example.com",
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(isCaptureEmailDriverAllowed({ VERCEL: "1" }), false);
  assert.equal(
    isCaptureEmailDriverAllowed({ NODE_ENV: "production", VERCEL: "1" }),
    false,
  );
  assert.equal(
    isCaptureEmailDriverAllowed({
      APP_URL: "http://localhost:3207",
      NODE_ENV: "production",
      VERCEL: "1",
    }),
    false,
  );

  const outboxDir = await mkdtemp(path.join(os.tmpdir(), "signudoc-capture-"));
  const resolveAddresses = async () => ({
    senderAddress: "Example <dev@signudoc.localhost>",
    supportAddress: null,
  });

  try {
    // Allowed in development and in a loopback production build: writes captured files.
    const devService = createEmailService({
      env: {
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "development",
      },
      resolveAddresses,
    });

    await devService.send(MESSAGE);
    assert.equal((await readdir(outboxDir)).length, 1);

    const localProdService = createEmailService({
      env: {
        APP_URL: "http://localhost:3207",
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "production",
      },
      resolveAddresses,
    });

    await localProdService.send(MESSAGE);
    assert.equal((await readdir(outboxDir)).length, 2);

    // Refused in deployed production and on Vercel: throws and writes nothing.
    for (const refusedEnv of [
      {
        APP_URL: "https://sign.example.com",
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "production",
      },
      {
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        VERCEL: "1",
      },
      {
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "production",
        VERCEL: "1",
      },
    ]) {
      assert.throws(
        () => createEmailService({ env: refusedEnv, resolveAddresses }),
        { message: CAPTURE_IN_PRODUCTION_ERROR_MESSAGE },
      );
    }

    assert.equal((await readdir(outboxDir)).length, 2);
  } finally {
    await rm(outboxDir, { force: true, recursive: true });
  }
});
