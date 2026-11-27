// The SignuDoc section of Settings, for the administrator: the version this
// install runs and the commit its image was built from. Nothing here goes
// online: a new version arrives when this fork's main branch changes, which
// builds a new image (see docs/self-hosting.md, "Keep your install up to
// date").

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function VersionPanel() {
  const version = process.env.NEXT_PUBLIC_SIGNUDOC_VERSION ?? "unknown";
  const rawCommit = process.env.SIGNUDOC_COMMIT?.trim() ?? "";
  const commit = COMMIT_PATTERN.test(rawCommit) ? rawCommit.slice(0, 7) : null;

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="signudoc"
    >
      <div className="space-y-2">
        <p className="section-eyebrow">Administrator</p>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          SignuDoc
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          This site runs SignuDoc version{" "}
          <span className="font-bold text-(--fg)" data-testid="running-version">
            {version}
          </span>
          {commit ? (
            <>
              {" "}
              (commit <code className="text-(--fg)">{commit}</code>)
            </>
          ) : null}
          . To update, merge the change into the main branch, wait for the new
          image to be published, then run{" "}
          <code className="text-(--fg)">docker compose pull</code> and{" "}
          <code className="text-(--fg)">docker compose up -d</code>.
        </p>
      </div>
    </section>
  );
}
