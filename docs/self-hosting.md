# Self-hosting SignuDoc

Everything about running your own SignuDoc with Docker: starting it, putting it behind your reverse proxy, setting it up, keeping it up to date, backing it up, and the settings you can change. For working on the code, see [Development](development.md).

- [Run it with Docker](#run-it-with-docker)
- [Set the site up](#set-the-site-up)
- [Your responsibilities](#your-responsibilities)
- [Signed PDFs and the seal](#signed-pdfs-and-the-seal)
- [Running in the EU](#running-in-the-eu)
- [Backups](#backups)
- [Daily cleanup](#daily-cleanup)
- [Rate limits](#rate-limits)
- [Hosted mode](#hosted-mode)

## Run it with Docker

SignuDoc runs as two containers from `docker-compose.yml`: `app` (the Next.js server, built from the `Dockerfile`) and `db` (Postgres 17). There is no `.env` file: every setting is an environment variable in the compose file.

1. **Fill in `docker-compose.yml`.** Replace each `CHANGE_ME`:
   - `POSTGRES_PASSWORD` in `db`, and the same password inside the app's `DATABASE_URL`.
   - `BETTER_AUTH_SECRET`, at least 32 characters (`openssl rand -hex 32`). Keep it the same for the life of the install: it signs sessions and encrypts the two-step sign-in keys and the PDF sealing key.
   - `SETUP_TOKEN`, a secret the setup page asks for. See [Lock down a new install](#lock-down-a-new-install).
   - `RESEND_API_KEY`, from your [Resend](https://resend.com) account.
   - `APP_URL`, the public `https://` address your reverse proxy serves, with no trailing slash.
2. **Start it:** `docker compose up -d --build`. The app waits for the database, applies any new migrations, then starts on port 3000. `docker compose logs -f app` shows `[migrate]` and `[scheduler]` lines as it comes up.
3. **Put your reverse proxy in front.** See [Reverse proxy](#reverse-proxy).
4. **Open `https://<your site>/setup`** and set the site up. See [Set the site up](#set-the-site-up).

Data lives in two named volumes: `signudoc-db` (the database) and `signudoc-files` (every uploaded, signed and sealed PDF, under `/data/storage`). Losing either loses documents, so back up both. See [Backups](#backups).

### Reverse proxy

The stack has no proxy of its own. Point yours at `http://<docker host>:3000`, and:

- **Serve HTTPS** at the address in `APP_URL`. Sign-in cookies are secure-only in production.
- **Pass the visitor's address** in `X-Forwarded-For` (and `X-Forwarded-Proto: https`). Rate limits and the audit trail use it. Make sure the proxy sets `X-Forwarded-For` itself rather than passing on one the visitor sent.
- **Allow request bodies of at least 25 MB.** A PDF can be up to 20 MB and is sent in the upload request with the form around it. nginx needs `client_max_body_size 25m;`.
- **Allow long enough timeouts** for sealing a large PDF: 120 seconds is plenty.

If the proxy runs on the same machine, change the app's port mapping to `"127.0.0.1:3000:3000"` so the app cannot be reached around it.

### Lock down a new install

A new install is claimed by whoever opens it first. With `SETUP_TOKEN` set (the compose file asks for one), the setup page asks for it, so finding the URL first is not enough.

### Keep your install up to date

Settings, SignuDoc, **Check for updates** tells you when a new [release](https://github.com/NYLLON-SOFTWARE/SignuDoc/releases) is out and what is in it. To take it:

```bash
git pull
docker compose up -d --build
```

The new image applies any new database migrations when it starts; they only ever apply what is new. Back up first (see [Backups](#backups)). If you keep your own changes to `docker-compose.yml`, `git stash` them before pulling and `git stash pop` after.

### Settings

Every setting is an environment variable under the app's `environment:` in `docker-compose.yml`. After changing one, run `docker compose up -d` to recreate the app container.

| Variable                                            | What it does                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                      | Required. The Postgres connection, `postgres://signudoc:<password>@db:5432/signudoc`.                                                                                                                  |
| `APP_URL`                                           | Required. The site's public HTTPS address, used for links in emails and for sign-in.                                                                                                                   |
| `BETTER_AUTH_SECRET`                                | Required. At least 32 characters. Signs sessions and encrypts keys; keep it stable.                                                                                                                    |
| `RESEND_API_KEY`                                    | Required for email. Your Resend API key.                                                                                                                                                               |
| `SETUP_TOKEN`                                       | A secret the setup page asks for. See [Lock down a new install](#lock-down-a-new-install).                                                                                                             |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`               | Keep at `local` and `/data/storage`, the files volume.                                                                                                                                                 |
| `JOB_SCHEDULER`, `WEBHOOK_RETRY_MINUTES`            | `off` stops the background jobs inside the app; the minutes between webhook retries (5). See [Daily cleanup](#daily-cleanup).                                                                          |
| `RETENTION_JOB_SECRET`                              | Closes `/api/internal/retention` and `/api/internal/webhooks` to callers without it. See [Daily cleanup](#daily-cleanup).                                                                              |
| `RESEND_FROM_EMAIL`, `SUPPORT_EMAIL`                | Fix the sender and support addresses from the environment instead of in Settings.                                                                                                                      |
| `HOSTED_MODE`                                       | `1` runs SignuDoc as a public service under its own name. See [Hosted mode](#hosted-mode).                                                                                                             |
| `RESEND_REGION`                                     | Where Resend sends from when the app adds your domain, for example `eu-west-1`. See [Running in the EU](#running-in-the-eu).                                                                           |
| `SEAL_P12_BASE64`, `SEAL_P12_PASSWORD`              | Seal finished PDFs with a certificate from a certificate authority instead of the install's own. See [Signed PDFs and the seal](#signed-pdfs-and-the-seal).                                            |
| `SEAL_TIMESTAMP_URL`                                | An RFC 3161 timestamp server that adds a trusted time to each seal, and long-term validation. See [Long-term validation](#long-term-validation).                                                       |
| `MAX_SIGNERS_PER_ENVELOPE`                          | The most signers one envelope can have, from 1 to 100. 25 when unset. See [Signing order](signing-order.md).                                                                                           |
| `EIDEASY_CLIENT_ID`, `EIDEASY_SECRET`               | Let senders ask for advanced or qualified signatures in the signers' own names, through eID Easy. See [Signatures in the signers' own names](#signatures-in-the-signers-own-names-eidas-ades-and-qes). |
| `CSC_API_URL`, `CSC_CLIENT_ID`, `CSC_CLIENT_SECRET` | The same through a trust service provider's remote signing service (CSC API v2). See [Signatures in the signers' own names](#signatures-in-the-signers-own-names-eidas-ades-and-qes).                  |
| `AUDIT_LOG`                                         | `off` keeps audit rows out of the container logs. See [Send the audit trail to your SIEM](#send-the-audit-trail-to-your-siem).                                                                         |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`  | Sign in through your organization's identity provider (Okta, Entra ID, Google Workspace). `PASSWORD_SIGN_IN=off` then turns passwords off. See [Single sign-on](#single-sign-on).                      |

## Set the site up

The first time you open a new install it takes you to `/setup`. There you name your organization, give its support address, and create the first account, which becomes the administrator. After that the setup page is gone for good.

- **Support address.** Setup does not finish without one. It is the address signers and people with an account are told to write to, and where replies to the site's emails go. It is saved in your install's own settings and nowhere else; there is no SignuDoc address that it falls back to. The administrator can change it under Settings, Organization, but not remove it.

- **Who can sign up.** The install starts by letting people with an email address at the administrator's own domain create accounts (or nobody else, if the administrator used a public mailbox such as Gmail). The administrator can change this under Settings, Organization: people at listed domains, nobody, or anyone. People who are only sent a document to sign never need an account.
- **More administrators.** Settings, Organization lists everyone with an account under People, where an administrator can make someone else an administrator or take that away. There is always at least one. When an account is closed, its finished documents and their audit trails move to the longest-standing administrator, because they are the organization's records. If that person later stops being an administrator, those documents move on to one who stays, and the documents they sent themselves stay with them.
- **What signers agree to before signing.** Before a signer can sign, they read a disclosure about using electronic records and signatures and tick a box to agree. The built-in disclosure says they may sign on paper instead, ask for a paper copy, and withdraw. Under Settings, Organization, "What signers agree to before signing", an administrator can write their own words in its place, or start from the standard text and change it. Separate paragraphs with a blank line, start a line with `## ` to make a heading, and write `{sender}` and `{contact}` where the sender's name and the address to write to go. Leave it empty to use the built-in text. A custom text is limited to 6,000 characters, and a heading needs words under it. Each signer's agreement records a version of the words they saw: the built-in text keeps its dated version, and a custom text is named by a fingerprint of the text, so the version changes whenever the text does. The words themselves, filled in as the signer read them, are kept in that signer's audit trail, so the record stays complete if the setting is changed later. Saving words of your own first shows a notice: the standard text covers what the U.S. E-SIGN Act requires before a consumer agrees to sign electronically (choosing paper, getting a paper copy, withdrawing and what that means, and the device and software needed), and removing or changing it may make signatures and records invalid. Saving needs an administrator to press "I agree", and each change to the setting is in the site audit trail with the version of the notice they agreed to. Saving the standard text unchanged, or going back to it, needs no notice. The consent step itself cannot be turned off. The hosted service always shows the built-in text. SignuDoc is not legal advice, and that includes the standard text: check any wording with your own legal counsel before you rely on it.
- **Email.** Settings, Organization also shows whether email is working. While no sender address is set, mail goes out from Resend's test address, which only reaches the owner of the Resend account. Enter a sender address at your domain and the page shows the DNS records to add and checks them for you. Mail from that address is not delivered until its domain is verified.
- **`SETUP_TOKEN`.** A new install can be claimed by whoever opens it first. If its URL will be public before you get to it, set `SETUP_TOKEN` to a secret of your own and the setup page will ask for it.
- **An install from before this page existed** has accounts but no administrator. Set `SETUP_TOKEN`, sign in with the account that should be in charge, and open `/setup`. It asks for a support address if the install has none. Sign-up stays open, as it was, until that administrator changes it.

## Sign-in security

These cover the people with an account (senders and administrators). Signers who are only sent a document open it from their emailed link and are not affected.

- **Two-step sign-in.** Anyone can turn it on under Settings, Two-step sign-in: after the password, the site asks for a 6-digit code from an authenticator app such as 1Password, Google Authenticator or Microsoft Authenticator. Setting it up gives ten single-use backup codes for when the phone is not at hand. The key and the backup codes are stored encrypted with `BETTER_AUTH_SECRET`, so keep that secret the same: a new one makes every authenticator stop working. If it has to change (it leaked, or it was derived from a database password that changed), clear everyone's two-step setup in the same step, or nobody who used it can sign in, administrators included. With `docker compose exec db psql -U signudoc signudoc`, run:

  ```sql
  update "user" set "twoFactorEnabled" = false;
  delete from "twoFactor";
  ```

  Then change the secret and run `docker compose up -d`. Everyone signs in with their password alone once, and sets up two-step sign-in again (an install that requires it asks at once). The site audit trail does not show this reset, so record it with the incident.

- **Requiring it.** An administrator can require two-step sign-in of everyone under Settings, Organization, Sign-in security. They have to use it themselves first. From then on anyone who has not set it up sees only the setup page until they have, the API refuses their requests too, and nobody can turn theirs off.
- **Lost phone.** If someone loses their phone and their backup codes, an administrator can reset their two-step sign-in under People. That turns it off and signs them out everywhere at once; they sign in with their password and set it up again (at once, if it is required).
- **Sessions.** A session lasts 7 days by default. Under Settings, Organization, Sign-in security an administrator can sign people out after 15 minutes to 8 hours without use, and at the latest 8 hours to 3 days after they signed in. A change applies to sessions that are already open, from their next click. Anyone can sign out on every device at once under Settings, Signed-in devices.
- **Wrong passwords.** Ten wrong passwords for one email address within 15 minutes stop sign-in for that address until the 15 minutes are up. This happens whether or not the address has an account, so it says nothing about which ones do. Ten wrong codes at the second step lock that step for 15 minutes in the same way.
- **The site audit trail** (Settings, Organization, Sign-in security) records each sign-in and failed sign-in with the address it came from, lockouts, sign-outs, password changes and resets, two-step sign-in being turned on, off or reset, new backup codes, and changes to settings, roles, the logo, the email domain, identity confirmations and signing locks. The rows form one hash chain, so a changed or removed row shows, and the trail downloads as CSV.

### API keys

Another app can create and send envelopes through the [SignuDoc API](api.md). An administrator makes a key for it under Settings, Organization, API keys. The key is shown once and only its hash is stored. It acts as the administrator who made it, skips two-step sign-in (it is for servers, not people), and stops working when it is revoked, expires, or its administrator stops being one. Making and revoking keys is in the site audit trail.

### Webhooks

An administrator can add webhook endpoints under Settings, Organization, Webhooks, so another app hears when an envelope is sent, viewed, signed, completed, declined, voided or expires. Deliveries are signed, retried for about two and a half days, and listed in a delivery log. Adding, changing and removing endpoints is in the site audit trail. Retries that are due are sent by the next request that changes an envelope, the next API call, or the app's own timer every few minutes (`WEBHOOK_RETRY_MINUTES`). `/api/internal/webhooks` does the same for an outside caller and takes the same `RETENTION_JOB_SECRET` as the daily cleanup. See [Webhooks](api.md#webhooks).

### Embedded signing

An app can show the signing page inside its own site, for envelopes it sends through the API with embedded delivery: no invitations are emailed, and the app says who the signer is. An administrator lists the sites allowed to do this under Settings, Organization, Embedded signing; with none listed it is off, and no page can be framed. Removing a site stops the links already made for it. See [Embedded signing](api.md#embedded-signing).

### Send the audit trail to your SIEM

Every row added to the site audit trail or to a document's audit trail is also written to the app container's standard output, once it is saved, as one line of JSON. So are refused requests and failures worth a look. A Docker logging driver or log shipper (Fluent Bit, Vector, Promtail, the Datadog agent and others) then delivers them to your SIEM as fields it can search and alert on.

Each line has `"source": "signudoc"` and a `type`:

- `"audit"`: a copy of an audit row. `trail` is `site` or `envelope`, and the line carries `event`, `actorEmail`, `actorUserId`, `ipAddress`, `userAgent`, `metadata`, `envelopeId` (for a document), `occurredAt`, and the row's `sequence` and `rowHash`. The database stays the record: the hash matches a line to its row, and a gap in `sequence` shows a line that did not arrive. A change that fails and is rolled back writes no line.
- `"security"`: a `category` and `message`, with the request's path (signing and download links are redacted), IP address and user, where known.

`AUDIT_LOG=off` stops the audit lines, if you would rather not have email and IP addresses in your container logs. The trails in the database are the same either way.

### Single sign-on

People can sign in through your organization's identity provider instead of with a password, over OpenID Connect. That puts your provider's own rules in charge: its MFA, its conditional access, and removing someone there removes them here at their next sign-in. It works with any provider that publishes `/.well-known/openid-configuration`, which includes Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud, Keycloak and Auth0. It is optional and set up by hand.

1. In your provider, make a web application (OIDC, authorization code flow). Give it the redirect URI `https://<your site>/api/auth/callback/sso` and the scopes `openid email profile`.
2. In `docker-compose.yml`, under the app's `environment:`, set:
   - `SSO_ISSUER`: the provider's issuer URL. For Okta, `https://<your org>.okta.com` (or your custom authorization server's URL). For Entra ID, `https://login.microsoftonline.com/<tenant id>/v2.0`. For Google, `https://accounts.google.com`.
   - `SSO_CLIENT_ID` and `SSO_CLIENT_SECRET`: from the application you made.
   - `SSO_NAME` (optional): what the button says after "Continue with", such as `Okta`.
3. Run `docker compose up -d`. The sign-in and sign-up pages show "Continue with …".

How it behaves:

- **New people** get an account the first time they sign in, under the same sign-up rule as a password sign-up (Settings, Organization, Who can sign up). So the email domain limit holds for single sign-on too. With Google this matters: any Google account can use the button, and the rule decides who gets an account. To let only your directory in, set the rule to your domains, or to nobody and add people some other way first.
- **People who already have an account** with the same email address are signed in to it, if their address here is confirmed and the provider says theirs is verified (`email_verified` is `true`). An address the provider does not vouch for is never tied to an existing account, and a new account made with it has to confirm the address by email first. Microsoft Entra ID does not send `email_verified`: add the optional `xms_edov` claim to the app's ID token (App registrations, Token configuration, Add optional claim, ID, `xms_edov`), which says your tenant owns the address's domain.
- **Two-step sign-in** is not asked for after single sign-on: the provider's sign-in, with its own MFA, is the check. When an administrator requires two-step sign-in, it applies to people who have a password; someone who only uses single sign-on is not held up.
- **Turning passwords off.** With single sign-on set up, `PASSWORD_SIGN_IN=off` stops password sign-in, password sign-up and password reset links. Put one or two administrator addresses in `PASSWORD_SIGN_IN_ALLOWED_EMAILS` (comma-separated) so there is a way in if the provider is down; their sign-in page shows "Sign in with a password instead". Without single sign-on set up, `PASSWORD_SIGN_IN=off` does nothing, so nobody is locked out by a half-finished setup.
- **The site audit trail** records single sign-on sign-ins, and refused ones with the reason (for example, an address the sign-up rule turned away).
- **API keys** keep working after their administrator is removed at the provider, because that does not change their role here. When an administrator leaves, take the role away under People, which revokes their keys, or revoke the keys under API keys. See [Keys](api.md#keys).
- A missing or broken setting (one of the three left out, an issuer that is not `https://`) turns single sign-on off and leaves a warning in the container logs, so password sign-in keeps working.

SAML is not supported. Okta, Entra ID and Google all offer OIDC for the same application.

## Your responsibilities

Your install carries your organization's name, not SignuDoc's. In Settings, link your own terms and privacy policy (without a privacy link, signers see a notice built from your settings at `/signer-privacy`; check it), keep the support address you gave at setup pointed at a mailbox someone reads, and choose how long finished documents are kept. Administrators see every envelope in the install that has been sent (Documents, "Everyone's"), whoever sent it; a draft stays its sender's own. They can open and download any of them, and ask for a finished one to be deleted from its page. The deletion waits 14 days: its sender is emailed a link to download it, any administrator can cancel until then, and the daily cleanup deletes it after that. A Part 11 record needs a reason. Sending, voiding, reminders and edits stay with the envelope's sender. Administrators can also put people on [teams](teams.md), whose members see each other's sent envelopes the same read-only way. A download of another member's file by an administrator or a teammate, each deletion request, each cancellation and each deletion are recorded in the install's audit log (Settings, Organization, "Site audit trail"), deletions with the document's fingerprints, its sender and the reason given. Under GDPR your organization is the controller; Settings, Organization has the tools to answer a signer who asks for their data or for its erasure.

## FDA 21 CFR Part 11

An administrator can turn on Part 11 mode under Settings for regulated records. While it is on:

- signers sign with their own confirmed accounts and give their password again at each signature;
- the meaning of each signature is printed beside it;
- finished records are never deleted on a timer.

Validating the install is up to your organization. The [Part 11 validation pack](part11/README.md) has the documents to start from.

## Signed PDFs and the seal

Every finished PDF and audit certificate is sealed with a PAdES signature, so any change after signing shows in Adobe Acrobat and other PDF readers, and its SHA-256 is recorded. Anyone can check a copy at `/verify`. The audit trail in the database is a hash chain, so an edited or deleted row shows too.

By default each install makes its own seal key and self-signed certificate the first time it seals, and keeps the key encrypted in the database with a key derived from `BETTER_AUTH_SECRET` (or the database password, when that is unset). Keep that secret stable: a new one makes a new seal key, and old PDFs still verify but under the old certificate. Readers show a self-signed seal as "validity unknown" until the certificate is trusted. For a seal readers trust on sight, buy a document-signing certificate and set `SEAL_P12_BASE64` and `SEAL_P12_PASSWORD`. `SEAL_TIMESTAMP_URL` adds a trusted time from a timestamp server.

### Long-term validation

A seal is easy to check while its certificates are valid and their certificate authority still answers. Years later, neither may be true. So when `SEAL_TIMESTAMP_URL` is set, every seal is made to PAdES B-LTA, the level meant for records kept for years:

1. The seal gets a timestamp from the timestamp server (B-T).
2. The certificates of the seal and of the timestamp server, and an answer from each certificate authority that none of them is revoked (an OCSP response, or the revocation list when there is no OCSP), are added to the PDF's document security store (B-LT).
3. An archive timestamp is added over all of that (B-LTA), so a reader can show the evidence was there at that time, after the certificates have expired.

Each step only adds to the file, so the seal from step 1 stays intact. With a certificate from a certificate authority but no timestamp server, step 2 still runs, which lets readers check the certificate later, but the seal stays at B-B: a PAdES level above that needs a trusted time. A self-signed seal without a timestamp server is left as it is, since there is no one to ask about it.

The lookups go to the timestamp server and the certificate authorities, outside your server. All of a document's lookups, the archive timestamp included, share 15 seconds (the seal's own timestamp has up to 10 seconds before that), and only answers that are current and signed by the certificate authority, or by a responder it authorized, are kept. If one fails the document keeps the seal it has and the function log says what was missing, so signing never waits on them for long. An archive timestamp keeps the evidence checkable until the timestamp server's own certificate expires, usually years later. Adding a new archive timestamp before then is not automatic yet.

### An advanced electronic seal (eIDAS)

Under eIDAS, a seal is the organization's counterpart of a signature. A seal that meets the four tests of Article 36 (linked only to your organization, identifying it, made with a key under its control, and showing any later change) is an **advanced electronic seal**. To get one:

- Buy a seal certificate that names your organization from a certificate authority, such as an eIDAS seal certificate or an organization-validated document-signing certificate. Choose one on the [EU trusted lists](https://esignature.ec.europa.eu/efda/tl-browser) or Adobe's Approved Trust List, so readers show your organization's name as verified.
- Get it as a PKCS#12 file with an RSA key (SignuDoc does not read EC keys from a file yet), and set it as `SEAL_P12_BASE64` (the file in base64) and `SEAL_P12_PASSWORD`. Keep the file somewhere safe outside the server too: the key in it is what makes the seal yours.
- Set `SEAL_TIMESTAMP_URL`, so the seal gets long-term validation as above. A timestamp server run by a qualified trust service provider gives a qualified electronic time stamp, which a court presumes accurate (Article 41).

What this gives you: each finished PDF and certificate carries your organization's advanced seal, showing it came from you unchanged. What it does not: the signers' own signatures stay simple electronic signatures (for signatures in their own names, see the next section), and the seal is not a qualified seal, which needs a qualified certificate held on a qualified device, usually a trust service provider's remote signing service rather than a file. This is not legal advice: whether a seal is enough for a document is for your own counsel.

### Signatures in the signers' own names (eIDAS AdES and QES)

Out of the box, signers make simple electronic signatures and the install seals the result. With a signing provider set up, a sender can instead choose **Advanced electronic signatures** or **Qualified electronic signatures** for an envelope, on the review page before sending. Each signer then fills in their fields as usual, and when they press Finish they go to the provider, prove who they are there (for example with a national eID card, Smart-ID or Mobile-ID, or the provider's own check), and sign with a certificate in their own name. They come back to the install, which checks the signature before keeping it.

What ends up in the PDF:

- Each signer's signature is a PAdES signature in a revision of its own, holding their filled-in fields. The revisions only add to the file, so every earlier signer's signature stays valid, and a PDF reader lists one signature per signer with the name from their certificate.
- When the last signer has signed, the install adds the certificates and revocation answers (B-LT), and with `SEAL_TIMESTAMP_URL` an archive timestamp too (B-LTA), as for the seal above. If the provider did not timestamp a signature, the install's timestamp server does.
- The signed PDF does not get the install's seal, because the signers' signatures already cover all of it. The certificate of completion is still sealed, and lists each signer's certificate, its issuer, and the provider.
- The certificate has to be in the name the document was sent to, so a signing link passed to someone else does not let them sign. Case, accents, punctuation (an apostrophe, as in O'Connor, can be left out), word order and ID numbers in the certificate's name do not count, and a middle name or title on one side only is allowed, but otherwise a certificate in another name is refused and the signer is asked to have the sender correct the name. Enter each signer's name as it is on their ID.
- For a qualified signature, the install refuses a certificate that does not say it is qualified and held on a qualified signature device (the EU QC statements). It does not look the issuer up on the EU trusted lists; PDF readers and the EU's own validator do that when the document is checked.

Not available in Part 11 mode, where signers sign with their accounts instead.

**Setting up a provider.** Both are paid outside services, so they are optional, and nothing changes until you set one up. Run `docker compose up -d` after setting the variables.

- **eID Easy** reaches most EU national eIDs, Smart-ID, Mobile-ID and several qualified providers through one account. Create an account and a client at [eideasy.com](https://eideasy.com), and set `EIDEASY_CLIENT_ID` and `EIDEASY_SECRET`. For eID Easy's test environment, also set `EIDEASY_API_URL=https://test.eideasy.com`. If eID Easy asks for the addresses it may send signers back to, give it `https://<your domain>/api/signing/provider/return`.
- **A trust service provider with a CSC API v2 remote signing service**, for signers who already have a signing certificate there. Set `CSC_API_URL` (the service's base address, ending in `/csc/v2`), `CSC_CLIENT_ID`, `CSC_CLIENT_SECRET`, and `CSC_PROVIDER_NAME` (the name signers see). Set `CSC_OAUTH_URL` when the provider's OAuth server is not at `<CSC_API_URL>/oauth2`. Register `https://<your domain>/api/signing/provider/return` as the OAuth redirect address.
- With both set, eID Easy is used for new envelopes unless `SIGNING_PROVIDER=csc`. Envelopes already sent finish with the provider they were sent with, as long as it is still set up.

**What has and has not been checked.** The signing flow is tested end to end against stand-ins that follow eID Easy's and the CSC API v2's published interfaces, and PDF readers check the signatures it produces. It has not yet been run against the live services, so try it on the provider's test environment before you rely on it, and tell us on GitHub what you find.

Whether a document needs an advanced or a qualified signature, and whether a given signature meets the law where you and the signers are, is a legal question. This is not legal advice.

## Running in the EU

The app and its data stay on your server, so run it in the EU to keep documents and the database there. Email is the one outside service:

1. **Email.** Set `RESEND_REGION=eu-west-1` before you add your domain in Settings, or create the domain in Resend's dashboard with the Ireland region. Resend still keeps account data and email logs in the US.
2. **Agreements.** Accept Resend's data processing agreement, which includes the EU standard contractual clauses, and list it in your privacy policy, with your server host if you rent one.

## Backups

Back up both volumes together: the database and the files refer to each other.

```bash
# Database
docker compose exec -T db pg_dump -U signudoc -Fc signudoc > signudoc-$(date +%F).dump

# Files
docker run --rm -v signudoc_signudoc-files:/data -v "$PWD":/backup alpine \
  tar czf /backup/signudoc-files-$(date +%F).tar.gz -C /data .
```

The volume name starts with the compose project name, which is the folder name by default; `docker volume ls` shows it. Run these from your own scheduler (cron on the host, for example) and copy the results off the machine.

To restore into a fresh install: start only the database (`docker compose up -d db`), load the dump with `docker compose exec -T db pg_restore -U signudoc -d signudoc --clean --if-exists < signudoc-<date>.dump`, unpack the files archive into the files volume the same way it was made, then `docker compose up -d`. Use the same `BETTER_AUTH_SECRET` as before, or sealed PDFs and two-step sign-in keys cannot be read.

## Daily cleanup

Once a day the app deletes drafts nobody has touched for 30 days, finishes account deletions that were requested, and clears expired download links, finished rate limit counters, and trips to a signing provider that nobody came back from, with the signer revisions nothing needs any more (a file that could not be deleted is tried again the next day). The same run sends the automatic reminders that are due and tells a sender when an envelope has passed its signing deadline.

The app runs this itself on a timer: two minutes after it starts, then every 24 hours. Webhook retries run every 5 minutes the same way. A Postgres lock keeps two runs from overlapping. There is nothing to schedule. Set `JOB_SCHEDULER=off` to stop the timers, for example if you would rather call the routes from your own scheduler:

```text
/api/internal/retention
/api/internal/webhooks
```

Without a secret those routes look after themselves: the cleanup runs at most once an hour, never twice at the same time, and answers with an empty response either way. Set `RETENTION_JOB_SECRET` to close them; a caller then has to send `Authorization: Bearer <secret>`, and gets a summary in return.

## Rate limits

Sign-in, sign-up, password reset, the signing pages, uploads and sending are rate limited per visitor. The counts are kept in the `rate_limits` table in Postgres, so they hold across every instance of the app. The visitor's address is read from `X-Forwarded-For`, so your reverse proxy must set it (see [Reverse proxy](#reverse-proxy)). If the database cannot be reached, each instance falls back to counting in its own memory.

## Hosted mode

`HOSTED_MODE=1` runs SignuDoc as a public service under its own name: the landing page at `/`, the built-in terms, privacy, contact and accessibility pages, and sign-up open to anyone. Leave it unset for an install that belongs to one organization.
