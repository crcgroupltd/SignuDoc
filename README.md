<p align="center">
  <img src="docs/images/banner.png" alt="SignuDoc: e-signatures you actually own. Open source and MIT licensed. Send, sign and seal documents from your own server, at $0 per seat. Shown: a signer drawing a signature on a consulting agreement, and both signers marked Signed.">
</p>

<p align="center">
  An e-signature app for your own organization, on your own server, in Docker.<br>
  Upload a PDF, place fields, send signing links, and keep the sealed, signed copy with its audit certificate.
</p>

<p align="center">
  <a href="#everything-it-takes-to-get-a-document-signed">Features</a> ·
  <a href="#signudoc-and-docusign-side-by-side">SignuDoc vs DocuSign</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="docs/self-hosting.md">Self-hosting guide</a>
</p>

## Why SignuDoc

**No seats to pay for.** SignuDoc is open source and runs on your own server with Docker. A 15-person team pays DocuSign $8,100 a year for Business Pro seats, or $5,400 for Standard. SignuDoc costs the same whether one person sends or fifty.

**No envelope allowance to watch.** DocuSign's Standard and Business Pro plans include 100 envelopes per user per year. SignuDoc has no limit of its own. What you can send depends on your server and your email plan.

**Your documents stay in your accounts.** PDFs live on a Docker volume and everything else in a Postgres database, both on your own server. Nobody else hosts your agreements, and the code is yours to read, change and run.

**Evidence anyone can check.** Every finished PDF and its audit certificate carry a PAdES seal that PDF readers check for changes, the audit trail is hash-chained so an edited or deleted row shows, and anyone holding a copy can check it on the install's public Verify page.

**Two containers, one file.** `docker compose up` starts the app and its database. Every setting lives in `docker-compose.yml`, and the database schema updates itself on each start.

## Everything it takes to get a document signed

<p align="center">
  <img src="docs/images/how-it-works.png" alt="How it works. 1: upload a PDF and place the fields. 2: signers open a link from their email and type or draw a signature, on any device. 3: everyone gets the sealed PDF and its audit certificate.">
</p>

### Prepare a document in minutes

Upload a PDF, add up to 25 signers in the order they sign, or have some of them sign at the same time, and add people who only receive the finished copy. Then place fields where they belong: signature, initials, date, name, text, number, checkbox, dropdown and radio buttons, each required or optional and each tied to one signer.

![Placing signature, date and dropdown fields for two signers on a master services agreement](docs/images/prepare.png)

<p align="center">
  <sub>The organization, people and documents in these screenshots are made up.</sub>
</p>

### Signing without an account

Each signer gets a link by email, agrees to use electronic records, and signs with a typed or drawn signature on any phone, tablet or computer. Fields from earlier signers stay visible and locked. Signers can download the document before they sign, or decline with a reason, and the sender is told.

![Jordan Lee signing a consulting agreement with a drawn signature, with the earlier signer's signature locked](docs/images/signing.png)

### Know who is signing

For documents that need more than an email link, ask a signer for an access code you give them yourself, or have SignuDoc email a one-time code when they open the link. The audit certificate records how each signer was checked, with their IP address and browser.

### Follow every envelope

The dashboard shows each document as a card with its first page, its status (draft, sent, completed, declined, voided or expired) and who it waits on, with search and a status filter. Each envelope has its own signing deadline, from 3 to 90 days, which you can change while it is out, and automatic reminders every 1, 2, 3 or 7 days, on top of the reminder you can send by hand. If a signer's email address was wrong, correct it after sending: the old link stops working and the new address gets a fresh invitation. A finished envelope can be copied into a new draft with the same document, signers and fields.

![The dashboard: the Mine and Everyone's switch, and six documents as cards, with drafts, a sent offer letter, an NDA one of two signed, and completed agreements](docs/images/dashboard.png)

![A sent NDA: Void, Send reminder, Copy to new draft and Export audit trail, its deadline, reminders and Save as template, the two signers with Change for the one still to sign, and the timeline](docs/images/envelope.png)

### Templates for the documents you send every week

Open any envelope and choose Save as template. The template keeps the document, the fields and the signing order, with roles instead of names. Using it asks who signs this time and opens a draft ready to send. Send to many takes a CSV of names and addresses and sends one envelope per row.

### Send from your other apps

Your own apps can send documents through SignuDoc's API. An administrator makes a key under Settings, and one call creates an envelope from a PDF with its signers and fields, and sends it. Signed webhooks tell your app when an envelope is sent, viewed, signed, completed, declined, voided or expires. Embedded signing shows the signing page inside your own site, for the sites an administrator allows. The [API guide](docs/api.md) has the details, and `/api/v1/openapi.json` on your install describes every endpoint.

### Sealed, certified, and checkable by anyone

When the last signer finishes, SignuDoc builds the signed PDF and an audit certificate, seals both, and emails them to every signer and copy recipient. Names and text in Latin, Greek, Cyrillic, Chinese, Japanese and Korean scripts are drawn correctly. Anyone can drop a copy on the Verify page to see whether it is exactly the file the site produced; the file never leaves their device, only its fingerprint does.

![The Verify page confirming that a signed contractor agreement is unchanged](docs/images/verify.png)

### Your name, logo and color

Signers see your organization, not SignuDoc. Give the install your name, logo and brand color, and they appear on the site, the signing pages and every email. Serve it at your own domain and link your own terms and privacy policy.

![The same signing page in the organization's own green, with its logo](docs/images/branding.png)

### Run by your administrators

The first account is the administrator, and you can make more. Choose who may create an account: people at your email domains, nobody, or anyone. People who only sign never need one. Set how long finished documents are kept, and answer a signer who asks for their data with a built-in export or erasure tool.

Administrators see every member's sent and finished envelopes in an "Everyone's" view of the dashboard, and can delete a finished one: it is deleted 14 days later, after the sender has been emailed, and any administrator can cancel in between. Drafts stay private to the person writing them.

### Sign-in security, backups and audits

- **Single sign-on** over OpenID Connect, with Okta, Microsoft Entra ID, Google Workspace and others, and password sign-in turned off if you want.
- **Two-step sign-in** with an authenticator app and backup codes, which administrators can require of everyone who signs in with a password. Single sign-on relies on your identity provider's own check instead.
- **Session limits and lockout**: sign people out after a time without use, and stop sign-in for an address after ten wrong passwords.
- **A site audit trail** of sign-ins, role changes, deletions and settings, also written to the container logs as JSON so your log shipper can deliver it to your SIEM.
- **Backups** of the database and the files volume with standard tools. See [Backups](docs/self-hosting.md#backups).
- **A SOC 2 pack** for organizations that put their install in an audit: a control map, vendor duties, questionnaire answers and sample policies, in [docs/soc2](docs/soc2/README.md).

### On your phone

SignuDoc works on small screens as well as large ones: check on your documents from your phone, and signers sign from theirs.

<p align="center">
  <img src="docs/images/phone.png" width="300" alt="The dashboard on a phone">
</p>

## SignuDoc and DocuSign, side by side

DocuSign does more, and charges for it per user. SignuDoc does the everyday signing loop well, and it's yours. DocuSign's plans are as [DocuSign listed them](https://ecom.docusign.com/plans-and-pricing/esignature) in November 2026, for the US.

<p align="center">
  <img src="docs/images/compare.png" alt="SignuDoc and DocuSign eSignature side by side, each with a green check for: signing without an account; signing order and copy recipients; signature, initials, date, name, text and checkbox fields; dropdown and radio button fields (on DocuSign: Business Pro, $45 a seat); reusable templates; deadlines and automatic reminders; your own logo and brand color (on DocuSign: from Standard, $30 a seat); accounts for your whole team (on DocuSign: from Standard); consent to electronic records; audit trail and certificate of completion; a tamper-evident seal on the finished PDF; working on a phone; two-step sign-in; and single sign-on (on DocuSign: Enhanced, priced by sales). To tick every box on DocuSign you need Enhanced; Business Pro, at $45 per user a month, ticks all but single sign-on.">
</p>

<p align="center">
  <img src="docs/images/only-signudoc.png" alt="Six things DocuSign doesn't offer: open source (DocuSign is closed source), runs in your own cloud (DocuSign runs only in its own), no per-seat fees (DocuSign charges $30 or $45 a seat a month), no envelope allowance (DocuSign includes 100 per user a year), every feature included (DocuSign splits them across four plans), and no cap on users (DocuSign's listed plans stop at 50).">
</p>

### Price and ownership

|                                  | SignuDoc                                         | DocuSign eSignature                                                                      |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Price**                        | Free and open source, on your own server         | $11 (Personal), $30 (Standard) or $45 (Business Pro) per user a month, on an annual plan |
| **Envelopes**                    | No limit of its own                              | 5 a month on Personal, 100 per user a year on Standard and Business Pro                  |
| **Where it runs**                | Your server, in Docker, with its own Postgres    | DocuSign's cloud                                                                         |
| **Where data is kept**           | Wherever your server is                          | DocuSign's data centers, the EU included                                                 |
| **Source code**                  | MIT license, on GitHub                           | Closed                                                                                   |
| **Your own domain and branding** | ✅ your domain, logo and color, in every install | Logo and colors from Standard                                                            |

### The signing loop

|                                              | SignuDoc                                                                                                                    | DocuSign eSignature                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Signing without an account**               | ✅                                                                                                                          | ✅                                                                           |
| **Signing order**                            | ✅ in order, at the same time, or mixed, up to 25 signers                                                                   | ✅ in order, at the same time, or mixed                                      |
| **People who only get a copy**               | ✅                                                                                                                          | ✅ and more roles: approvers, editors, in-person signers                     |
| **Field types**                              | ✅ signature, initials, date, name, text, number, checkbox, dropdown, radio, each required or optional                      | ✅ more types; dropdown, radio and signer attachments need Business Pro      |
| **Templates**                                | ✅                                                                                                                          | ✅ from Personal, shared from Standard                                       |
| **Send one template to many from a CSV**     | ✅ one envelope per row, up to 200 a batch                                                                                  | ✅ bulk send on Business Pro                                                 |
| **Deadlines and automatic reminders**        | ✅                                                                                                                          | ✅                                                                           |
| **Access code and emailed one-time code**    | ✅                                                                                                                          | ✅ plus SMS, phone, knowledge-based questions and ID checks, as paid add-ons |
| **Consent to electronic records**            | ✅ versioned, recorded in the audit trail                                                                                   | ✅                                                                           |
| **Sealed PDF and certificate of completion** | ✅ PAdES seal, self-signed by default or your own trusted certificate, long-term validation (B-LTA) with a timestamp server | ✅ seal trusted by PDF readers                                               |
| **Audit trail**                              | ✅ hash-chained, and sent to your SIEM through a log drain                                                                  | ✅                                                                           |
| **Checking a signed copy**                   | ✅ the seal in a PDF reader, and a public Verify page on your own site                                                      | ✅ the seal in a PDF reader                                                  |
| **Retention rules and signer data requests** | ✅ built in                                                                                                                 | ✅                                                                           |
| **Phones**                                   | ✅ in the browser                                                                                                           | ✅ native iPhone and Android apps                                            |
| **Two-step sign-in**                         | ✅ authenticator app, and administrators can require it                                                                     | ✅                                                                           |
| **Single sign-on**                           | ✅ OpenID Connect, in every install                                                                                         | ✅ SAML, on Enhanced, priced by sales                                        |
| **API and webhooks**                         | ✅ an API with keys, signed webhooks, and signing inside your own site, in every install                                    | ✅ API plans from $50 a month                                                |

### Where DocuSign does more

|                                                         | SignuDoc                                                            | DocuSign eSignature                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| **More than one document per envelope, and Word files** | — PDF only, one per envelope                                        | ✅                                                    |
| **Web forms, payments**                                 | —                                                                   | ✅ on Business Pro                                    |
| **Integrations**                                        | — none built in; connect your own apps through the API and webhooks | ✅ 1,000+, including Salesforce, Microsoft and Google |
| **Languages**                                           | — signing pages in English                                          | ✅ signing in 44 languages                            |
| **Advanced and qualified signatures (eIDAS)**           | With a provider you add: eID Easy or a CSC remote signing service   | ✅                                                    |
| **HIPAA, 21 CFR Part 11, certifications**               | Part 11 mode and a SOC 2 pack; you validate and get audited         | ✅ on Enhanced or as add-ons                          |
| **Support**                                             | GitHub issues                                                       | ✅ 24/7 on Enhanced                                   |

If your agreements run through Salesforce, need SMS checks or ID document checks, or go out by the thousand in bulk, DocuSign earns its price. If you want to send everyday agreements, keep the evidence, and own the whole thing, SignuDoc is built for you.

## Get started

### Run it with Docker

You need Docker with Compose, a domain name, a reverse proxy that serves HTTPS (nginx, Traefik, Caddy or similar), and a [Resend](https://resend.com) account for email.

1. **Get the code:** `git clone https://github.com/NYLLON-SOFTWARE/SignuDoc.git && cd SignuDoc`
2. **Fill in `docker-compose.yml`.** Replace every `CHANGE_ME` (database password, `BETTER_AUTH_SECRET`, `SETUP_TOKEN`, `RESEND_API_KEY`) and set `APP_URL` to your public address. There is no `.env` file: every setting is in the compose file.
3. **Start it:** `docker login ghcr.io` (once, if the image is private), then `docker compose pull && docker compose up -d`. Two containers start, `app` and `db`, and the app applies the database schema by itself. The image comes from GitHub Container Registry, where `.github/workflows/docker-image.yml` publishes it on every push to `main`; `docker compose up -d --build` builds it from your checkout instead.
4. **Point your reverse proxy at port 3000.** See [Reverse proxy](docs/self-hosting.md#reverse-proxy) for the headers and upload size it needs.
5. **Open your site at `/setup`.** Give the setup token, name your organization, give the email address people should write to for help, and create the first account, which is the administrator.
6. **Set up the address you send from.** Under Settings, Organization, enter an address at your own domain. The site lists the DNS records to add and checks them for you.

**Taking new versions:** `docker compose pull && docker compose up -d`. New database migrations apply when the app starts. The [self-hosting guide](docs/self-hosting.md) covers backups, sign-in security, the seal and every optional setting.

### Try it on your computer

With Node.js 24 and Docker, create a `.env.local` with `DATABASE_URL=postgres://signudoc:signudoc@127.0.0.1:5432/signudoc`, `APP_URL=http://localhost:3000` and `EMAIL_DRIVER=capture`, then:

```bash
npm install
npm run db:start   # Postgres in Docker (compose.dev.yml), with the schema applied
npm run dev        # SignuDoc at http://localhost:3000
```

Files stay on disk and emails are written to `.data/outbox` instead of being sent, so you need no outside account. [Development](docs/development.md) says more.

## Built for self-hosting

- **Two containers.** Next.js 16 in a standalone Node.js server, and Postgres. The daily cleanup, deadline expiry and webhook retries run on timers inside the app, so there is no cron to set up.
- **Secure by default.** Private file storage with no public URLs, a strict Content Security Policy, rate limits kept in Postgres, signing links that are hashed at rest, sign-in lockout, and a setup page that only the first visitor, or the holder of a `SETUP_TOKEN`, can use.
- **Tested.** Unit tests, database tests against a real Postgres, and a browser test that sets up a fresh install, sends a document and signs it (`npm test`, `npm run test:db`, `npm run test:e2e`), run before changes are merged.

## Using SignuDoc for real agreements

SignuDoc is not a law firm and does not give legal advice, and nothing here is a promise that a signature made with it will be accepted for a given purpose. It gives you the features that electronic signature laws such as the US ESIGN Act and UETA and the EU's eIDAS regulation look for in a simple electronic signature: each signer's consent to electronic records, a record of who signed, when and how, optional identity checks, and a sealed copy that shows any change. Whether that is enough for a particular document depends on the document, where you and the signers are, and how you use it. Ask a lawyer when it matters.

Every install has a page at `/electronic-signatures` that says what it is for, and senders confirm it before each send. It is meant for ordinary business agreements, such as contracts, NDAs, statements of work, offer letters, purchase orders and approvals. It is **not** built for:

- documents that need an advanced or qualified electronic signature (AdES or QES) under eIDAS, unless you add a signing provider (see below);
- protected health information under HIPAA;
- documents that many laws keep out of electronic signature, such as wills, family-law matters, court orders, notices of foreclosure, eviction, utility shut-off or insurance cancellation, and in most EU countries real estate transfers and documents that need a notary.

For **advanced or qualified electronic signatures** under eIDAS, connect a signing provider: [eID Easy](https://eideasy.com), or a trust service provider's remote signing service that speaks the CSC API v2. A sender can then choose that signature type for an envelope, and each signer proves who they are at the provider and signs with a certificate in their own name. Every signature goes into the PDF in a revision of its own, so all of them stay valid, and the finished PDF gets long-term validation. The provider is a paid outside service, so it is optional, and the flow has been tested against stand-ins for both interfaces but not yet against the live services. [Signatures in the signers' own names](docs/self-hosting.md#signatures-in-the-signers-own-names-eidas-ades-and-qes) has the setup.

For FDA 21 CFR Part 11 records, an administrator can turn on **Part 11 mode** under Settings. Signers then sign with their own accounts, whose identity an administrator has confirmed, give their password again at each signature, and see the meaning of their signature (approval, review, responsibility or authorship) printed beside it with their name and the time. Audit trails export as CSV, and finished records are never deleted on a timer. That covers the software's part only: validating your install, writing and following your own procedures, training your people and certifying your electronic signatures to the FDA stay with your organization. The [Part 11 validation pack](docs/part11/README.md) gives you starting documents for that: requirements, a traceability matrix, a risk assessment, qualification scripts, SOP templates and the FDA letter.

Your install carries your organization's name, and your organization is responsible for how it is used: linking your own terms and privacy policy, keeping the support address pointed at a mailbox someone reads, choosing how long documents are kept, and answering signers' data requests. [Your responsibilities](docs/self-hosting.md#your-responsibilities) has the details.

## Learn more

- [Self-hosting guide](docs/self-hosting.md): Docker setup, your reverse proxy, first-run setup, updates, backups, sign-in security and single sign-on, the seal, cleanup, rate limits and every optional setting.
- [API guide](docs/api.md): API keys, the `/api/v1` endpoints, webhooks and embedded signing.
- [SOC 2 pack](docs/soc2/README.md) and [Part 11 validation pack](docs/part11/README.md): starting documents for an audit or a validation.
- [Development](docs/development.md): running SignuDoc locally, storage, the database, email, tests and the code's layout.
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

## License and credits

SignuDoc is [MIT licensed](LICENSE). Copyright © 2026 Nyllon Software. It redistributes third-party assets, including bundled fonts and PDF.js, under their own licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The project has no email address of its own. Report a security problem privately through GitHub, as [SECURITY.md](SECURITY.md) describes. For help with one particular site that runs SignuDoc, write to the organization that runs it.

## Legal disclaimer

**SignuDoc is an independent open source project. It is not affiliated with, associated with, authorized by, endorsed by, sponsored by, or in any way officially connected with DocuSign, Inc., or any of its subsidiaries or affiliates.** SignuDoc is not a DocuSign product, is not built on DocuSign's software or services, and does not use DocuSign's code.

"DocuSign" and related names, marks and logos are trademarks or registered trademarks of DocuSign, Inc. in the United States and other countries. They are used in this repository only to identify DocuSign's products for the purpose of comparison. No claim is made to any of them, and their use does not imply any relationship with, or approval by, DocuSign, Inc. All other product and company names, including Vercel, Neon and Resend, are trademarks of their respective owners, and SignuDoc is not affiliated with or endorsed by them either.

The comparisons on this page were made in good faith from DocuSign's publicly available website and plan documentation as of November 2026, for its US eSignature plans, and from SignuDoc's own code. DocuSign's features, plans and prices change, vary by country and contract, and may differ from what is described here. Nothing on this page is a statement by DocuSign. Check [DocuSign's own website](https://www.docusign.com) for current and authoritative information before you rely on any of it, and tell us through a GitHub issue if something here is out of date or wrong so that it can be corrected.

The cost figures are estimates for illustration, not quotes. What you pay depends on your own use and on the prices of the services your install runs on.

SignuDoc is provided "as is", without warranty of any kind, as the [MIT License](LICENSE) sets out. Nothing in this repository is legal advice. Whether an electronic signature is valid or enforceable for a particular document depends on the law that applies to it; ask a qualified lawyer.
