import {
  buildEmailAddresses,
  extractEmailAddress,
} from "./services/email-addresses.ts";
import {
  createSmtpTransport,
  defaultSenderAddress,
  isCaptureEmailDriverAllowed,
  resolveEmailDriver,
  type MailTransport,
} from "./services/email.ts";
import { getSettings, type ResolvedSettings } from "./settings.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

// Whether this install can send email to anyone, and what is left to do if
// it cannot. Shown to the administrator in Settings.
//
// Email goes out through the SMTP server in SMTP_HOST. The app can tell
// whether that server answers and accepts its sign-in; only a test email
// that arrives proves that mail from the sender address is delivered, so
// "ready" waits for one.

export type EmailStatus =
  /** Development (or a local production build on localhost): messages are written to disk, not sent. */
  | { state: "capture" }
  /**
   * EMAIL_DRIVER=capture is configured on a deployed site, where the
   * capture driver is refused because it drops every email.
   */
  | { state: "capture_refused" }
  /** No SMTP_HOST, so nothing can be sent. */
  | { state: "missing_config" }
  /** The server answers and accepts the sign-in, but no test email has gone out yet. */
  | { state: "untested"; server: string; senderAddress: string }
  /** A test email from this sender has been accepted. */
  | { state: "ready"; server: string; senderAddress: string }
  /** The server could not be reached, or refused the sign-in. */
  | { state: "error"; message: string; server: string; senderAddress: string };

type EmailStatusOptions = {
  env?: EnvSource;
  settings?: ResolvedSettings;
  /** Replaced in tests, where there is no mail server. */
  transport?: MailTransport;
};

/** How long the connection check waits for the server. */
const VERIFY_TIMEOUT_MS = 10_000;

function describeServer(env: EnvSource): string {
  const { host, port } = getEnv(env).email.smtp;

  return `${host ?? "?"}:${String(port)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The mail server could not be reached.";
}

async function verifyWithTimeout(transport: MailTransport): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      transport.verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The mail server did not answer in time."));
        }, VERIFY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Works out whether email can be sent: connects to the SMTP server and
 * signs in, then reports whether a test email has proved delivery.
 */
export async function getEmailStatus({
  env = process.env,
  settings,
  transport,
}: EmailStatusOptions = {}): Promise<EmailStatus> {
  if (!transport && resolveEmailDriver(env) === "capture") {
    return isCaptureEmailDriverAllowed(env)
      ? { state: "capture" }
      : { state: "capture_refused" };
  }

  if (!transport && !getEnv(env).email.smtp.host) {
    return { state: "missing_config" };
  }

  const resolvedSettings = settings ?? (await getSettings(env));
  const senderAddress = extractEmailAddress(
    buildEmailAddresses(resolvedSettings, defaultSenderAddress(env))
      .senderAddress,
  );
  const server = describeServer(env);

  try {
    await verifyWithTimeout(transport ?? createSmtpTransport(env));
  } catch (error) {
    return {
      message: errorMessage(error),
      senderAddress,
      server,
      state: "error",
    };
  }

  return resolvedSettings.emailReadyAt === null
    ? { senderAddress, server, state: "untested" }
    : { senderAddress, server, state: "ready" };
}

/** True when an administrator should be told that email still needs work. */
export function emailNeedsAttention(
  settings: ResolvedSettings,
  env: EnvSource = process.env,
): boolean {
  try {
    if (resolveEmailDriver(env) === "capture") {
      return !isCaptureEmailDriverAllowed(env);
    }
  } catch {
    return true;
  }

  return settings.emailReadyAt === null;
}
