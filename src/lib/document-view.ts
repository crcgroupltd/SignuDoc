// What the in-app PDF viewer (/view) may open: only this app's own document
// routes, so the page can't be pointed at another site, and only same-site
// pages to go back to.

const ID = "[A-Za-z0-9_-]{1,64}";

const VIEWABLE_SOURCES: readonly RegExp[] = [
  new RegExp(`^/api/envelopes/${ID}/(document|preview)$`),
  new RegExp(`^/api/envelopes/${ID}/download\\?type=(signed|evidence)$`),
  new RegExp(`^/api/templates/${ID}/document$`),
];

/** The document URL if the viewer may open it, otherwise null. */
export function resolveViewableSource(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return VIEWABLE_SOURCES.some((pattern) => pattern.test(value)) ? value : null;
}

/** A same-site path to go back to, or the dashboard. */
export function resolveBackPath(value: unknown): string {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    value.length <= 512
  ) {
    return value;
  }

  return "/dashboard";
}

/** The link to open a document in the viewer, with a title and a way back. */
export function buildViewerHref(input: {
  back: string;
  src: string;
  title: string;
}): string {
  const params = new URLSearchParams({
    back: input.back,
    src: input.src,
    title: input.title,
  });

  return `/view?${params.toString()}`;
}
