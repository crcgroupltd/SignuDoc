import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTransport, type SendMailOptions } from "nodemailer";

import { getSettings } from "../settings.ts";
import { type EmailTemplateKind } from "../types/domain.ts";
import {
  getEnv,
  isLocalDeployment,
  readEnv,
  type EnvSource,
} from "../utils/env.ts";
import { buildEmailAddresses, type EmailAddresses } from "./email-addresses.ts";
import { CAPTURED_MESSAGE_ID_PREFIX } from "./captured-email.ts";
import {
  assertServiceConfig,
  ServiceConfigurationError,
} from "./service-config.ts";

// The addresses mail is sent from and replied to are not needed here: they
// come from SMTP_FROM and SUPPORT_EMAIL when those are set, and from the
// install's settings otherwise, and are looked up when a message is sent.
const EMAIL_ENV_KEYS = ["SMTP_HOST"] as const;

const DEFAULT_CAPTURE_DIR = ".data/outbox";
const DEFAULT_CAPTURE_SENDER_ADDRESS = "dev@signudoc.localhost";

export type EmailDriver = "capture" | "smtp";

export type EmailAttachment = {
  content: Uint8Array;
  contentType: string;
  filename: string;
};

/**
 * Attachments are base64 encoded in the message, which makes them a third
 * larger, and many mail servers refuse messages over 25 to 50 MB. Above
 * this the message goes out with links only.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function fitsAsAttachments(
  attachments: readonly EmailAttachment[],
): boolean {
  return (
    attachments.reduce((total, item) => total + item.content.byteLength, 0) <=
    MAX_ATTACHMENT_BYTES
  );
}

export type TransactionalEmailMessage = {
  attachments?: EmailAttachment[];
  htmlBody?: string;
  replyTo?: string;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export type EmailDeliveryResult = {
  accepted: string[];
  messageId?: string;
  rejected: string[];
};

export type EmailSendOptions = {
  idempotencyKey?: string;
};

/** The part of a nodemailer transport used here. Replaced by a fake in tests. */
export type MailTransport = {
  sendMail(message: SendMailOptions): Promise<{
    accepted?: unknown[];
    messageId?: string;
    rejected?: unknown[];
  }>;
  verify(): Promise<unknown>;
};

type CreateEmailServiceOptions = {
  env?: EnvSource;
  /** Replaced in tests, where there is no database to read settings from. */
  resolveAddresses?: () => Promise<EmailAddresses>;
  /** Replaced in tests, where there is no mail server. */
  transport?: MailTransport;
};

/**
 * The SMTP server from SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER and
 * SMTP_PASSWORD. Port 465 uses TLS from the start; any other port (587 by
 * default) upgrades with STARTTLS when the server offers it, or always with
 * SMTP_REQUIRE_TLS=1.
 */
export function createSmtpTransport(
  env: EnvSource = process.env,
): MailTransport {
  const { smtp } = getEnv(env).email;

  if (!smtp.host) {
    throw new ServiceConfigurationError("email", ["SMTP_HOST"]);
  }

  return createTransport({
    auth: smtp.user
      ? { pass: smtp.password ?? "", user: smtp.user }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    host: smtp.host,
    port: smtp.port,
    requireTLS: smtp.requireTls,
    secure: smtp.secure,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: smtp.verifyTls },
  });
}

function toAddressList(values: unknown[] | undefined): string[] {
  return (values ?? []).map((value) =>
    typeof value === "string"
      ? value
      : typeof value === "object" && value && "address" in value
        ? String((value as { address: unknown }).address)
        : String(value),
  );
}

/**
 * The message as sent, and as written to the outbox by the capture driver.
 * Its field names are the ones the end-to-end test reads back.
 */
function buildMessagePayload(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
) {
  return {
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
            filename: attachment.filename,
          })),
        }
      : {}),
    from: config.senderAddress,
    html: message.htmlBody,
    replyTo: message.replyTo ?? config.supportAddress ?? undefined,
    subject: message.subject,
    tags: [
      {
        name: "category",
        value: message.template,
      },
    ],
    text: message.textBody,
    to: [message.to],
  };
}

export interface EmailService {
  send(
    message: TransactionalEmailMessage,
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult>;
  sendBatch(
    messages: readonly TransactionalEmailMessage[],
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult[]>;
}

export function resolveEmailDriver(env: EnvSource = process.env): EmailDriver {
  const configuredDriver = env.EMAIL_DRIVER?.trim().toLowerCase();

  if (!configuredDriver) {
    return "smtp";
  }

  if (configuredDriver === "capture" || configuredDriver === "smtp") {
    return configuredDriver;
  }

  throw new Error(
    `Unknown EMAIL_DRIVER "${configuredDriver}". Use "smtp" or "capture".`,
  );
}

export const CAPTURE_IN_PRODUCTION_ERROR_MESSAGE =
  "EMAIL_DRIVER=capture drops every email and cannot be used in production.";

/**
 * Whether EMAIL_DRIVER=capture may be used in this deployment.
 * Allowed in development, and for a production build that is being run on
 * localhost (which is what the end-to-end test does). Never on Vercel or on
 * a deployed production site, because it drops every email.
 */
export function isCaptureEmailDriverAllowed(
  env: EnvSource = process.env,
): boolean {
  if (readEnv(env, "VERCEL") === "1") {
    return false;
  }

  if (env.NODE_ENV !== "production") {
    return true;
  }

  try {
    return isLocalDeployment(env);
  } catch {
    return false;
  }
}

/**
 * Development and test driver: nothing is sent. Each message is written as a
 * JSON file so a person (or the end-to-end test) can read the links in it.
 */
function createCaptureEmailService(
  env: EnvSource,
  resolveAddresses: () => Promise<EmailAddresses>,
): EmailService {
  if (!isCaptureEmailDriverAllowed(env)) {
    throw new Error(CAPTURE_IN_PRODUCTION_ERROR_MESSAGE);
  }

  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const captureDir = path.resolve(
    /*turbopackIgnore: true*/ env.EMAIL_CAPTURE_DIR?.trim() ||
      DEFAULT_CAPTURE_DIR,
  );

  async function capture(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const config = await resolveAddresses();
    const messageId = `${CAPTURED_MESSAGE_ID_PREFIX}${randomUUID()}`;
    const filePath = path.join(
      /*turbopackIgnore: true*/ captureDir,
      `${String(Date.now())}-${messageId}.json`,
    );

    const temporaryPath = `${filePath}.tmp`;

    // Written under a temporary name and renamed, so anything watching the
    // outbox never reads a half-written file.
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          ...buildMessagePayload(
            { ...message, attachments: undefined },
            config,
          ),
          // The files themselves are not written out; their names, sizes
          // and fingerprints are enough to check what would have been sent.
          attachments: message.attachments?.map((attachment) => ({
            bytes: attachment.content.byteLength,
            contentType: attachment.contentType,
            filename: attachment.filename,
            sha256: createHash("sha256")
              .update(attachment.content)
              .digest("hex"),
          })),
          capturedAt: new Date().toISOString(),
          messageId,
          template: message.template,
        },
        null,
        2,
      ),
    );
    await rename(temporaryPath, filePath);
    console.info(
      `[email:capture] ${message.template} to ${message.to} -> ${filePath}`,
    );

    return {
      accepted: [message.to],
      messageId,
      rejected: [],
    };
  }

  return {
    send: (message) => capture(message),
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await capture(message));
      }

      return results;
    },
  };
}

/** The addresses this install sends from, as configured right now. */
export async function resolveEmailAddresses(
  env: EnvSource = process.env,
): Promise<EmailAddresses> {
  const settings = await getSettings(env);

  return resolveEmailDriver(env) === "capture" &&
    isCaptureEmailDriverAllowed(env)
    ? buildEmailAddresses(settings, DEFAULT_CAPTURE_SENDER_ADDRESS)
    : buildEmailAddresses(settings, defaultSenderAddress(env));
}

/**
 * The address mail comes from when neither SMTP_FROM nor Settings names
 * one: the SMTP account's own address when it is an email address, which
 * most servers allow, or no-reply at the site's own domain.
 */
export function defaultSenderAddress(env: EnvSource = process.env): string {
  const user = getEnv(env).email.smtp.user?.trim();

  if (user && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    return user;
  }

  let host = "localhost";

  try {
    host = new URL(getEnv(env).appUrl ?? "http://localhost").hostname;
  } catch {
    // Keep localhost.
  }

  return `no-reply@${host}`;
}

/** What a sender is told when an action needs email and none is connected. */
export const EMAIL_NOT_CONNECTED_MESSAGE =
  "Email is not set up yet, so signers can't be emailed. An administrator can finish email setup in Settings, Organization.";

/**
 * Whether an error is createEmailService's refusal for a missing provider
 * key: a known setup state, not a server failure (issue #53).
 */
export function isEmailNotConnectedError(error: unknown): boolean {
  return (
    error instanceof ServiceConfigurationError &&
    error.message.startsWith("email service ")
  );
}

/**
 * Whether this install has an email provider to send with. Without one,
 * a flow that would tell someone to check their inbox says that email is
 * not set up instead (issue #95).
 */
export function canSendEmail(env: EnvSource = process.env): boolean {
  try {
    createEmailService({ env });
    return true;
  } catch {
    // No provider key, or a driver this deployment cannot use: either way
    // nothing would be sent.
    return false;
  }
}

/**
 * An email service that is only built when a message is first sent. A flow
 * that sends email as a side effect after saving its own work (a signer
 * finishing or declining) uses it, so a missing provider key fails the
 * send, which that flow already logs and survives, instead of the whole
 * request (issue #96).
 */
export function createLazyEmailService(
  create: () => EmailService = () => createEmailService(),
): EmailService {
  let service: EmailService | undefined;
  const resolve = () => (service ??= create());

  return {
    send: async (message, options) => resolve().send(message, options),
    sendBatch: async (messages, options) =>
      resolve().sendBatch(messages, options),
  };
}

export function createEmailService({
  env = process.env,
  resolveAddresses = () => resolveEmailAddresses(env),
  transport,
}: CreateEmailServiceOptions = {}): EmailService {
  if (!transport && resolveEmailDriver(env) === "capture") {
    return createCaptureEmailService(env, resolveAddresses);
  }

  if (!transport) {
    assertServiceConfig("email", EMAIL_ENV_KEYS, env);
  }

  const mailer = transport ?? createSmtpTransport(env);

  // SMTP has no idempotency keys: a message the server accepted is not
  // sent twice by this app, and one it refused is reported as an error.
  async function deliver(
    message: TransactionalEmailMessage,
    config: EmailAddresses,
  ): Promise<EmailDeliveryResult> {
    const payload = buildMessagePayload(message, config);
    const info = await mailer.sendMail({
      attachments: payload.attachments,
      from: payload.from,
      headers: { "X-SignuDoc-Template": message.template },
      html: payload.html,
      replyTo: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
      to: message.to,
    });
    const rejected = toAddressList(info.rejected);

    if (rejected.length > 0 && toAddressList(info.accepted).length === 0) {
      throw new Error(`The mail server refused ${rejected.join(", ")}.`);
    }

    return {
      accepted: [message.to],
      messageId: info.messageId,
      rejected,
    };
  }

  return {
    async send(message) {
      return deliver(message, await resolveAddresses());
    },

    async sendBatch(messages) {
      if (messages.length === 0) {
        return [];
      }

      if (messages.some((message) => message.attachments?.length)) {
        throw new Error("Messages with attachments must be sent one by one.");
      }

      const config = await resolveAddresses();
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await deliver(message, config));
      }

      return results;
    },
  };
}
