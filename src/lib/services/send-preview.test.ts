import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import type { FieldRecord } from "../schemas/field.ts";
import { previewFieldLabel, renderSendPreview } from "./send-preview.ts";
import type { StorageService } from "./storage.ts";

function field(overrides: Partial<FieldRecord>): FieldRecord {
  return {
    createdAt: 0,
    height: 0.05,
    id: "f",
    page: 1,
    required: true,
    signerId: "a",
    type: "signature",
    updatedAt: 0,
    width: 0.4,
    x: 0.1,
    y: 0.1,
    ...overrides,
  };
}

test("an outline is labeled with what the field is and who fills it", () => {
  assert.equal(
    previewFieldLabel({ type: "signature" }, "Client"),
    "Signature – Client",
  );
  assert.equal(
    previewFieldLabel({ type: "date" }, "Client"),
    "Date signed – Client",
  );
  // A radio button shows what it means.
  assert.equal(
    previewFieldLabel({ label: "Yes", type: "radio" }, "Client"),
    "Yes – Client",
  );
});

test("the preview is a new PDF with the same pages, leaving the source as it was", async () => {
  const source = await PDFDocument.create();

  source.addPage([612, 792]);
  source.addPage([792, 612]);

  const sourceBytes = await source.save();
  const preview = await renderSendPreview({
    fields: [
      field({ id: "n1", signerId: "a", type: "name" }),
      field({ id: "n2", signerId: "b", type: "name", y: 0.2 }),
      field({ id: "s1", signerId: "a", y: 0.7 }),
      field({ id: "s2", page: 2, signerId: "b", y: 0.6 }),
      // A field on a page the document does not have is skipped.
      field({ id: "x", page: 9 }),
    ],
    pages: [
      { heightPt: 792, pageNumber: 1, widthPt: 612 },
      { heightPt: 612, pageNumber: 2, widthPt: 792 },
    ],
    signers: [
      { id: "a", name: "Cara Client", order: 1 },
      { id: "b", name: "Finn Firm", order: 2 },
    ],
    sourcePdf: sourceBytes,
    storageService: {} as StorageService,
  });

  assert.notDeepEqual(preview, sourceBytes);

  const reloaded = await PDFDocument.load(preview);

  assert.equal(reloaded.getPageCount(), 2);
  assert.deepEqual(reloaded.getPage(1).getSize(), { height: 612, width: 792 });
});
