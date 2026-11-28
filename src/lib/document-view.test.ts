import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildViewerHref,
  resolveBackPath,
  resolveViewableSource,
} from "./document-view.ts";

test("the viewer opens only this app's own document routes", () => {
  for (const allowed of [
    "/api/envelopes/abc-123/document",
    "/api/envelopes/abc-123/preview",
    "/api/envelopes/abc-123/download?type=signed",
    "/api/envelopes/abc-123/download?type=evidence",
    "/api/templates/t_1/document",
  ]) {
    assert.equal(resolveViewableSource(allowed), allowed);
  }

  for (const refused of [
    "https://evil.example/doc.pdf",
    "//evil.example/doc.pdf",
    "/api/envelopes/abc/document?x=1",
    "/api/envelopes/abc/download?type=original",
    "/api/envelopes/../admin/document",
    "/api/admin/audit",
    "javascript:alert(1)",
    undefined,
  ]) {
    assert.equal(resolveViewableSource(refused), null, String(refused));
  }
});

test("going back stays on this site", () => {
  assert.equal(resolveBackPath("/envelopes/abc"), "/envelopes/abc");
  assert.equal(resolveBackPath("//evil.example"), "/dashboard");
  assert.equal(resolveBackPath("https://evil.example"), "/dashboard");
  assert.equal(resolveBackPath("/\\evil.example"), "/dashboard");
  assert.equal(resolveBackPath(undefined), "/dashboard");
});

test("a viewer link carries the document, its title and the way back", () => {
  const href = buildViewerHref({
    back: "/templates",
    src: "/api/templates/t_1/document",
    title: "Lease & terms",
  });
  const params = new URL(href, "https://sign.example.com").searchParams;

  assert.ok(href.startsWith("/view?"));
  assert.equal(params.get("src"), "/api/templates/t_1/document");
  assert.equal(params.get("title"), "Lease & terms");
  assert.equal(params.get("back"), "/templates");
});
