"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { BrandingPanel } from "@/components/settings/branding-panel";
import { EmbeddingPanel } from "@/components/settings/embedding-panel";
import { Part11Panel } from "@/components/settings/part11-panel";
import { PeoplePanel } from "@/components/settings/people-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { SignerDataPanel } from "@/components/settings/signer-data-panel";
import { TeamsPanel } from "@/components/settings/teams-panel";
import { WebhooksPanel } from "@/components/settings/webhooks-panel";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_DISCLOSURE_LEGAL_NOTE,
  CUSTOM_DISCLOSURE_NOTICE,
  tidyDisclosureText,
} from "@/lib/consent-disclosure-notice";
import type { EmailStatus } from "@/lib/email-status";
import type {
  OrganizationSettingsField,
  OrganizationSettingsView,
} from "@/lib/organization-settings";
import type { SignupMode } from "@/lib/signup-policy";

// The administrator's part of Settings: what the install is called, who can
// sign up, where email comes from, and whether email works yet.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type OrganizationSettingsProps = {
  initialSettings: OrganizationSettingsView;
};

type FormErrors = Partial<Record<OrganizationSettingsField, string>>;

type Feedback = {
  message: string;
  tone: "error" | "success";
} | null;

type SettingsResponse = {
  error?: string;
  fieldErrors?: FormErrors;
  settings?: OrganizationSettingsView;
} | null;

type EmailResponse = {
  error?: string;
  status?: EmailStatus;
  test?: { sent: true; to: string } | { sent: false; message: string };
} | null;

type EmailAction = "recheck" | "send_test";

const signupModeOptions: Array<{
  description: string;
  label: string;
  value: SignupMode;
}> = [
  {
    description:
      "Only people whose email address is at one of your domains can create an account.",
    label: "People at my organization",
    value: "domains",
  },
  {
    description: "Nobody new can create an account.",
    label: "Nobody",
    value: "closed",
  },
  {
    description: "Anyone who finds this site can create an account.",
    label: "Anyone",
    value: "open",
  },
];

export function OrganizationSettings({
  initialSettings,
}: OrganizationSettingsProps) {
  const router = useRouter();
  const [values, setValues] = useState(initialSettings);
  const [errors, setErrors] = useState<FormErrors>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Bumped after a save, so the email panel looks again: a new sender
  // address means a different domain to check.
  const [emailRevision, setEmailRevision] = useState(0);
  // The disclosure as last saved, to tell whether a save changes it.
  const [savedConsentDisclosure, setSavedConsentDisclosure] = useState(
    initialSettings.consentDisclosure,
  );
  const [isDisclosureNoticeOpen, setIsDisclosureNoticeOpen] = useState(false);

  function handleChange(field: OrganizationSettingsField) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({ ...currentValues, [field]: nextValue }));
      setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
      setFeedback(null);
    };
  }

  function setConsentDisclosure(consentDisclosure: string) {
    setValues((currentValues) => ({ ...currentValues, consentDisclosure }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      consentDisclosure: undefined,
    }));
    setFeedback(null);
  }

  function handleBrandColorChange(brandColor: string) {
    setValues((currentValues) => ({ ...currentValues, brandColor }));
    setErrors((currentErrors) => ({ ...currentErrors, brandColor: undefined }));
    setFeedback(null);
  }

  function handleSignupModeChange(signupMode: SignupMode) {
    setValues((currentValues) => ({ ...currentValues, signupMode }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      allowedEmailDomains: undefined,
      signupMode: undefined,
    }));
    setFeedback(null);
  }

  /**
   * Whether saving puts the administrator's own words in place of what
   * signers read now, which needs them to agree to the notice first. Going
   * back to the standard text, or saving the same words again, does not.
   */
  function savingChangesToOwnDisclosure(): boolean {
    const next = tidyDisclosureText(values.consentDisclosure);

    return (
      !values.hosted &&
      next.length > 0 &&
      next !== tidyDisclosureText(values.defaultConsentDisclosure) &&
      next !== tidyDisclosureText(savedConsentDisclosure)
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    if (savingChangesToOwnDisclosure()) {
      setIsDisclosureNoticeOpen(true);
      return;
    }

    void saveSettings(false);
  }

  async function saveSettings(disclosureNoticeAgreed: boolean) {
    setIsDisclosureNoticeOpen(false);
    setErrors({});
    setFeedback(null);
    setIsSaving(true);

    try {
      const response = await fetch("/api/admin/settings", {
        body: JSON.stringify({
          allowedEmailDomains: values.allowedEmailDomains,
          brandColor: values.brandColor,
          consentDisclosure: values.consentDisclosure,
          consentDisclosureAcknowledged: disclosureNoticeAgreed,
          organizationName: values.organizationName,
          privacyUrl: values.privacyUrl,
          retentionDays: values.retentionDays,
          senderAddress: values.senderAddress,
          signupMode: values.signupMode,
          supportAddress: values.supportAddress,
          termsUrl: values.termsUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SettingsResponse;

      if (!response.ok || !payload?.settings) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setValues(payload.settings);
      setSavedConsentDisclosure(payload.settings.consentDisclosure);
      setEmailRevision((revision) => revision + 1);
      setFeedback({ message: "Organization settings saved.", tone: "success" });
      // The header and the accent color come from the layout around this
      // page, which only looks them up again when asked to.
      router.refresh();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="organization"
    >
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Organization
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            These settings apply to everyone who uses this site. Only you, the
            administrator, can see and change them.
          </p>
        </div>

        {feedback ? (
          <p
            className={`notice ${
              feedback.tone === "success" ? "notice-success" : "notice-danger"
            }`}
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        ) : null}

        <form className="space-y-8" noValidate onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={isSaving}
              error={errors.organizationName}
              helper="Shown in the header and in every email this site sends."
              label="Organization name"
              name="organization-name"
              onChange={handleChange("organizationName")}
              readOnly={false}
              value={values.organizationName}
            />
          </div>

          {/* The hosted service runs under its own name, mark and color. */}
          {!values.hosted ? (
            <BrandingPanel
              brandColor={values.brandColor}
              brandColorError={errors.brandColor}
              disabled={isSaving}
              logoUrl={values.logoUrl}
              onBrandColorChange={handleBrandColorChange}
              onLogoChange={(logoUrl) =>
                setValues((currentValues) => ({ ...currentValues, logoUrl }))
              }
            />
          ) : null}

          <fieldset className="space-y-4 border-t border-(--border) pt-8">
            <legend className="float-left mb-4 w-full text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Who can create an account
            </legend>
            <p className="clear-both max-w-2xl text-sm leading-6 text-(--secondary)">
              {values.part11Mode
                ? "Part 11 mode is on, so this covers signers too. A Part 11 envelope goes only to someone with an account here whose identity an administrator has confirmed under People, so choose a rule that lets the people you send to create one."
                : "This is about people who send documents. People who are sent a document to sign don't need an account."}
            </p>
            <div className="space-y-3">
              {signupModeOptions.map((option) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
                  key={option.value}
                >
                  <input
                    checked={values.signupMode === option.value}
                    className="mt-1 size-4 accent-(--accent)"
                    disabled={isSaving}
                    name="signup-mode"
                    onChange={() => handleSignupModeChange(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-bold text-(--fg)">
                      {option.label}
                    </span>
                    <span className="block text-sm leading-6 text-(--secondary)">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {values.signupMode === "domains" || errors.allowedEmailDomains ? (
              <div className="max-w-xl">
                <FieldShell
                  disabled={isSaving}
                  error={errors.allowedEmailDomains}
                  helper="Separate several domains with commas."
                  label="Email domains"
                  name="allowed-email-domains"
                  onChange={handleChange("allowedEmailDomains")}
                  placeholder="yourcompany.com"
                  readOnly={false}
                  value={values.allowedEmailDomains}
                />
              </div>
            ) : null}
          </fieldset>

          <div className="space-y-5 border-t border-(--border) pt-8">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Email addresses
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell
                disabled={isSaving || values.senderAddressFromEnv}
                error={errors.senderAddress}
                helper={
                  values.senderAddressFromEnv
                    ? "Set by the SMTP_FROM environment variable."
                    : "The address emails come from. Your mail server must be allowed to send from it."
                }
                label="Send email from"
                name="sender-address"
                onChange={handleChange("senderAddress")}
                placeholder="sign@yourcompany.com"
                readOnly={values.senderAddressFromEnv}
                type="email"
                value={values.senderAddress}
              />
              <FieldShell
                disabled={isSaving || values.supportAddressFromEnv}
                error={errors.supportAddress}
                helper={
                  values.supportAddressFromEnv
                    ? "Set by the SUPPORT_EMAIL environment variable."
                    : "Where replies and questions from signers go."
                }
                label="Support address"
                name="support-address"
                onChange={handleChange("supportAddress")}
                placeholder="help@yourcompany.com"
                readOnly={values.supportAddressFromEnv}
                type="email"
                value={values.supportAddress}
              />
            </div>
          </div>

          {!values.hosted ? (
            <div className="space-y-5 border-t border-(--border) pt-8">
              <div className="space-y-2">
                <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                  Your terms and privacy policy
                </h3>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  Optional. Links to pages on your own website, shown in the
                  footer of this site and of its emails.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell
                  disabled={isSaving}
                  error={errors.termsUrl}
                  label="Terms link"
                  name="terms-url"
                  onChange={handleChange("termsUrl")}
                  placeholder="https://yourcompany.com/terms"
                  readOnly={false}
                  value={values.termsUrl}
                />
                <FieldShell
                  disabled={isSaving}
                  error={errors.privacyUrl}
                  label="Privacy policy link"
                  name="privacy-url"
                  onChange={handleChange("privacyUrl")}
                  placeholder="https://yourcompany.com/privacy"
                  readOnly={false}
                  value={values.privacyUrl}
                />
              </div>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Without a privacy policy link, signers see{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
                  href="/signer-privacy"
                  target="_blank"
                >
                  a notice built from these settings
                </a>
                . Check that it is right for your organization.
              </p>
            </div>
          ) : null}

          {!values.hosted ? (
            <div className="space-y-5 border-t border-(--border) pt-8">
              <div className="space-y-2">
                <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                  What signers agree to before signing
                </h3>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  Optional. Signers read this and tick a box to agree to use
                  electronic records and signatures before they sign. Leave it
                  empty to use the standard text, or press &ldquo;Start from the
                  standard text&rdquo; to edit it. The words each signer saw are
                  kept with their record.
                </p>
              </div>
              <Field className="gap-2 text-sm">
                <FieldLabel
                  className="text-[0.8125rem] font-semibold text-(--secondary)"
                  htmlFor="consent-disclosure"
                >
                  Disclosure text
                </FieldLabel>
                <Textarea
                  aria-describedby="consent-disclosure-description"
                  aria-invalid={errors.consentDisclosure ? true : undefined}
                  className={
                    errors.consentDisclosure
                      ? "min-h-48 border-(--danger)"
                      : "min-h-48"
                  }
                  disabled={isSaving}
                  id="consent-disclosure"
                  maxLength={6000}
                  name="consent-disclosure"
                  onChange={(event) => setConsentDisclosure(event.target.value)}
                  placeholder="Standard text"
                  value={values.consentDisclosure}
                />
                {errors.consentDisclosure ? (
                  <FieldError
                    className="text-xs font-semibold text-(--danger)"
                    id="consent-disclosure-description"
                  >
                    {errors.consentDisclosure}
                  </FieldError>
                ) : (
                  <FieldDescription
                    className="text-xs leading-5 text-(--tertiary)"
                    id="consent-disclosure-description"
                  >
                    Separate paragraphs with a blank line. Start a line with ##
                    and a space to make a heading. Write {"{sender}"} where the
                    sender&apos;s name goes and {"{contact}"} where the address
                    to write to goes.
                  </FieldDescription>
                )}
                <p className="text-xs leading-5 text-(--secondary)">
                  {CUSTOM_DISCLOSURE_LEGAL_NOTE}
                </p>
              </Field>
              <div className="flex flex-wrap gap-3">
                <ShellButton
                  disabled={isSaving}
                  onClick={() =>
                    setConsentDisclosure(values.defaultConsentDisclosure)
                  }
                  variant="secondary"
                >
                  Start from the standard text
                </ShellButton>
                {values.consentDisclosure.length > 0 ? (
                  <ShellButton
                    disabled={isSaving}
                    onClick={() => setConsentDisclosure("")}
                    variant="ghost"
                  >
                    Use the standard text
                  </ShellButton>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="space-y-5 border-t border-(--border) pt-8">
            <div className="space-y-2">
              <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                How long to keep finished documents
              </h3>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Optional. After this many days a completed, declined or voided
                envelope is deleted with its audit trail. Its sender is emailed
                30 days before. Leave empty to keep them until someone deletes
                them. Many records must be kept for years, so check what applies
                to you before setting this.
              </p>
            </div>
            <div className="max-w-xs">
              <FieldShell
                disabled={isSaving || values.part11Mode}
                error={errors.retentionDays}
                helper={
                  values.part11Mode
                    ? "Off while Part 11 mode is on: those records are deleted by hand only."
                    : undefined
                }
                label="Days to keep"
                name="retention-days"
                onChange={handleChange("retentionDays")}
                placeholder="Keep until deleted"
                readOnly={false}
                value={values.retentionDays}
              />
            </div>
          </div>

          <ShellButton className="w-fit" loading={isSaving} type="submit">
            {isSaving ? "Saving..." : "Save organization settings"}
          </ShellButton>
        </form>

        {isDisclosureNoticeOpen ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                setIsDisclosureNoticeOpen(false);
              }
            }}
          >
            <DialogContent
              className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto sm:p-8"
              showCloseButton={false}
            >
              <DialogHeader className="space-y-3">
                <DialogTitle>{CUSTOM_DISCLOSURE_NOTICE.title}</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-3 text-sm leading-6 text-(--secondary)">
                    {CUSTOM_DISCLOSURE_NOTICE.paragraphs.map((paragraph) => (
                      <p key={paragraph.text}>
                        {paragraph.lead ? (
                          <strong className="font-bold text-(--fg)">
                            {paragraph.lead}{" "}
                          </strong>
                        ) : null}
                        {paragraph.text}
                      </p>
                    ))}
                  </div>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-3 sm:justify-end">
                <ShellButton
                  onClick={() => setIsDisclosureNoticeOpen(false)}
                  variant="secondary"
                >
                  Cancel
                </ShellButton>
                <ShellButton onClick={() => void saveSettings(true)}>
                  {CUSTOM_DISCLOSURE_NOTICE.agree}
                </ShellButton>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        <EmailSetupPanel key={emailRevision} />

        {/* The hosted service's accounts are strangers to each other, not
            one organization, so it has no list of them here. */}
        {!values.hosted ? <PeoplePanel part11Mode={values.part11Mode} /> : null}

        {!values.hosted ? <TeamsPanel /> : null}

        {!values.hosted ? (
          <SecurityPanel
            initialRequireTwoFactor={values.requireTwoFactor}
            initialSessionIdleMinutes={values.sessionIdleMinutes}
            initialSessionMaxHours={values.sessionMaxHours}
          />
        ) : null}

        {!values.hosted ? (
          <Part11Panel initialEnabled={values.part11Mode} />
        ) : null}

        {!values.hosted ? <ApiKeysPanel /> : null}

        {!values.hosted ? <WebhooksPanel /> : null}

        {!values.hosted ? <EmbeddingPanel /> : null}

        <SignerDataPanel />
      </div>
    </section>
  );
}

async function fetchEmailStatus(
  signal: AbortSignal,
): Promise<{ error: string; status: null } | { status: EmailStatus }> {
  const response = await fetch("/api/admin/email", { signal });
  const payload = (await response.json().catch(() => null)) as EmailResponse;

  if (!response.ok || !payload?.status) {
    return { error: payload?.error ?? GENERIC_ERROR_MESSAGE, status: null };
  }

  return { status: payload.status };
}

function EmailSetupPanel() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<EmailAction | null>(null);
  const [testResult, setTestResult] = useState<Feedback>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchEmailStatus(controller.signal)
      .then((result) => {
        if (result.status) {
          setLoadError(null);
          setStatus(result.status);
        } else {
          setLoadError(result.error);
        }
      })
      .catch((error: unknown) => {
        // Leaving the page cancels the request; that is not a failure.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, []);

  async function runAction(action: EmailAction) {
    if (pendingAction) {
      return;
    }

    setPendingAction(action);
    setTestResult(null);

    try {
      const response = await fetch("/api/admin/email", {
        body: JSON.stringify({ action }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as EmailResponse;

      if (payload?.status) {
        setLoadError(null);
        setStatus(payload.status);
      }

      if (payload?.test) {
        setTestResult(
          payload.test.sent
            ? {
                message: `Test email sent to ${payload.test.to}. Check that inbox.`,
                tone: "success",
              }
            : { message: payload.test.message, tone: "error" },
        );
      } else if (!response.ok) {
        setLoadError(payload?.error ?? GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setLoadError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  const summary = status ? describeEmailStatus(status) : null;
  const canSendTest =
    status?.state === "untested" ||
    status?.state === "ready" ||
    status?.state === "error";

  return (
    <div className="space-y-5 border-t border-(--border) pt-8" id="email-setup">
      <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        Email setup
      </h3>

      {loadError ? (
        <p className="notice notice-danger" role="alert">
          {loadError}
        </p>
      ) : null}

      {!summary ? (
        loadError ? null : (
          <p className="text-sm text-(--secondary)">Checking email…</p>
        )
      ) : (
        <div
          className={`space-y-2 rounded-2xl px-5 py-4 ${
            summary.ready ? "bg-(--success-soft)" : "bg-(--surface)"
          }`}
          data-email-state={status?.state}
        >
          <p className="text-sm font-bold text-(--fg)">{summary.title}</p>
          {summary.lines.map((line) => (
            <p className="text-sm leading-6 text-(--secondary)" key={line}>
              {line}
            </p>
          ))}
          {summary.steps ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary) marker:font-semibold marker:text-(--fg)">
              {summary.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {canSendTest ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "send_test"}
            onClick={() => void runAction("send_test")}
          >
            {pendingAction === "send_test"
              ? "Sending..."
              : "Send me a test email"}
          </ShellButton>
        ) : null}
        {status && status.state !== "capture" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "recheck"}
            onClick={() => void runAction("recheck")}
            variant="secondary"
          >
            {pendingAction === "recheck" ? "Checking..." : "Check again"}
          </ShellButton>
        ) : null}
      </div>

      {testResult ? (
        <p
          className={`notice ${
            testResult.tone === "success" ? "notice-success" : "notice-danger"
          }`}
          role={testResult.tone === "error" ? "alert" : "status"}
        >
          {testResult.message}
        </p>
      ) : null}
    </div>
  );
}

const SMTP_SETUP_STEPS = [
  "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM for the app in docker-compose.yml, using your mail server's settings.",
  "Recreate the app container (docker compose up -d), then reload this page.",
];

function describeEmailStatus(status: EmailStatus): {
  lines: string[];
  ready: boolean;
  steps?: string[];
  title: string;
} {
  switch (status.state) {
    case "capture":
      return {
        lines: [
          "This is a development setup. Emails are saved to a folder on this machine instead of being sent.",
        ],
        ready: true,
        title: "Emails are being captured, not sent",
      };
    case "capture_refused":
      return {
        lines: [
          "EMAIL_DRIVER=capture drops every email and cannot be used in production, so this site refuses to send anything: no sign-up confirmations and no signing invitations.",
        ],
        ready: false,
        steps: [
          "Remove EMAIL_DRIVER=capture from the app's environment (or set EMAIL_DRIVER=smtp).",
          ...SMTP_SETUP_STEPS,
        ],
        title: "Email cannot be sent with EMAIL_DRIVER=capture",
      };
    case "missing_config":
      return {
        lines: [
          "This site has no mail server set, so it cannot send anything: no sign-up confirmations and no signing invitations.",
        ],
        ready: false,
        steps: SMTP_SETUP_STEPS,
        title: "Email is not connected",
      };
    case "untested":
      return {
        lines: [
          `The mail server at ${status.server} answers and accepts this site's sign-in. Emails will come from ${status.senderAddress}.`,
          "Send yourself a test email. If it arrives, email is working.",
        ],
        ready: false,
        title: "Send a test email to finish",
      };
    case "ready":
      return {
        lines: [
          `Emails are sent from ${status.senderAddress} through ${status.server}.`,
        ],
        ready: true,
        title: "Email is working",
      };
    case "error":
      return {
        lines: [
          `The mail server at ${status.server} could not be used: ${status.message}`,
          "Check SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER and SMTP_PASSWORD, and that this server can reach the mail server on that port.",
        ],
        ready: false,
        title: "Email could not be checked",
      };
  }
}
