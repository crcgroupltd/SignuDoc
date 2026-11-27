# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in SignuDoc, please report it privately. **Do not put the details in a public GitHub issue, discussion or pull request.**

Send your report through GitHub's private vulnerability reporting: open the [Report a vulnerability](https://github.com/NYLLON-SOFTWARE/SignuDoc/security/advisories/new) form, which is also on this repository's security advisories page. The report stays between you and the repository's maintainers. Include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- The potential impact as you understand it.

If that form is not available to you, open an issue that asks the maintainers for a private way to reach them, and leave every detail of the vulnerability out of it.

The project has no email address for reports. Each organization that runs SignuDoc gives its own install a support address, and that address reaches the organization, not the people who maintain this code. A problem with one particular site, such as its settings or the documents it holds, belongs with the organization that runs it.

We will acknowledge your report within 7 days and aim to provide a fix or mitigation plan within 30 days, depending on severity and complexity.

## Scope

This policy covers the SignuDoc application code in this repository, including:

- Authentication and session handling
- Signing token and download token generation and verification
- Document storage and access controls
- API route authorization and rate limiting
- Email delivery logic

## Out of scope

- Vulnerabilities in third-party dependencies (report those to the upstream project, though we appreciate a heads-up)
- Issues in your own self-hosted deployment configuration (infrastructure, DNS, TLS, etc.)
- Social engineering attacks

## Supported versions

Security fixes are applied to the latest release only.

## How the code is checked

- **Tests.** Typecheck, lint, unit tests, tests against a real Postgres and an end-to-end browser test (`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:db`, `npm run test:e2e`) are run before changes are merged. They are not run in GitHub Actions in this repository.
- **Image.** `.github/workflows/docker-image.yml` builds the Docker image and publishes it to GitHub Container Registry on pushes to `main` and version tags, or when run by hand. Pull requests do not start a build. It is the only workflow.
- **Upstream checks.** The upstream project, [NYLLON-SOFTWARE/SignuDoc](https://github.com/NYLLON-SOFTWARE/SignuDoc), runs CodeQL, dependency review and OpenSSF Scorecard on its own repository.

## Verifying a release

Each upstream release from v0.3.0 on, at [NYLLON-SOFTWARE/SignuDoc](https://github.com/NYLLON-SOFTWARE/SignuDoc/releases), has these files attached, made by its release workflow:

- `signudoc-<version>.tar.gz`: the source of the tagged commit.
- `signudoc-<version>.cdx.json`: a software bill of materials in CycloneDX format, listing every npm package the app ships with its version and license.
- `SHA256SUMS`: their checksums.

Each file has a GitHub artifact attestation, signed through Sigstore, saying which workflow run in this repository made it from which commit. To check one with the GitHub CLI:

```sh
gh attestation verify signudoc-<version>.tar.gz -R NYLLON-SOFTWARE/SignuDoc
```

## Recognition

We appreciate responsible disclosure. If you report a valid vulnerability, we are happy to credit you in the fix commit or release notes unless you prefer to remain anonymous.
