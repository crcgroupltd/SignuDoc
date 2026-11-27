import { SIGNUDOC_NAME } from "../branding.ts";
import { truncateToWholeCharacters } from "../text-truncate.ts";

// Which addresses email is sent from and replied to.

export type EmailAddresses = {
  /** The From header, with a display name. */
  senderAddress: string;
  /** Where replies go when a message does not say otherwise. */
  supportAddress: string | null;
};

type EmailAddressSettings = {
  hosted: boolean;
  organizationName: string | null;
  senderAddress: string | null;
  supportAddress: string | null;
};

/** "Acme <sign@acme.com>" becomes "sign@acme.com". */
export function extractEmailAddress(value: string): string {
  const match = /<([^<>]+)>\s*$/.exec(value);

  return (match?.[1] ?? value).trim().toLowerCase();
}

export function getAddressDomain(value: string): string | null {
  const address = extractEmailAddress(value);
  const separatorIndex = address.lastIndexOf("@");

  if (separatorIndex <= 0 || separatorIndex === address.length - 1) {
    return null;
  }

  return address.slice(separatorIndex + 1);
}

// A display name goes into an email header, so anything with a meaning there
// (quotes, angle brackets, separators, line breaks) is dropped.
function cleanDisplayName(value: string | null): string {
  const cleaned = truncateToWholeCharacters(
    (value ?? "")
      .replace(/[\u0000-\u001f\u007f"<>()[\]\\,;:@]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    80,
  ).trimEnd();

  return cleaned || SIGNUDOC_NAME;
}

function hasDisplayName(value: string): boolean {
  return /<[^<>]+>\s*$/.test(value);
}

/**
 * The From and Reply-To addresses. fallbackSenderAddress is used when
 * neither SMTP_FROM nor Settings names a sender.
 */
export function buildEmailAddresses(
  settings: EmailAddressSettings,
  fallbackSenderAddress: string,
): EmailAddresses {
  const configuredSender = settings.senderAddress?.trim() || null;
  const displayName = cleanDisplayName(
    settings.hosted ? SIGNUDOC_NAME : settings.organizationName,
  );
  let senderAddress: string;

  if (configuredSender && hasDisplayName(configuredSender)) {
    senderAddress = configuredSender;
  } else {
    senderAddress = `${displayName} <${configuredSender ?? fallbackSenderAddress}>`;
  }

  return {
    senderAddress,
    supportAddress: settings.supportAddress?.trim() || null,
  };
}
