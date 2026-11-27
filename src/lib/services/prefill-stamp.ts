import { PDFDocument, type PDFImage } from "pdf-lib";

import type { PrefilledBox } from "../prefill.ts";
import type { FieldRecord } from "../schemas/field.ts";
import { stampFieldValue } from "./pdf-finalize.ts";
import { embedTextFaces } from "./pdf-fonts.ts";
import {
  fieldOnDisplayedPage,
  getDisplayedPageGeometry,
  type StoredPageSize,
} from "./pdf-page-geometry.ts";
import type { StorageService } from "./storage.ts";

// Writes a template's prefill values into its document before a draft
// envelope is made from it. The boxes are drawn exactly as a signer's
// answers are drawn on the finished document, so a prefilled value and a
// signed one look the same. The result is an ordinary PDF: the envelope,
// its signing and its seal never know which parts were prefilled.

function toFieldRecord(box: PrefilledBox, now: number): FieldRecord {
  return {
    checked: box.checked,
    createdAt: now,
    groupId: box.field.groupId,
    height: box.field.height,
    id: box.field.id,
    imageKey: null,
    inputMethod: "typed",
    label: box.field.label,
    options: box.field.options,
    page: box.field.page,
    required: box.field.required,
    signerId: box.field.signerId,
    submittedAt: now,
    type: box.field.type,
    updatedAt: now,
    value: box.value,
    width: box.field.width,
    x: box.field.x,
    y: box.field.y,
  };
}

/** The document with the boxes drawn on it, or the same bytes when there are none. */
export async function stampPrefilledBoxes(
  sourcePdf: Uint8Array,
  boxes: readonly PrefilledBox[],
  pages: readonly StoredPageSize[] | null,
  storageService: StorageService,
): Promise<Uint8Array> {
  if (boxes.length === 0) {
    return sourcePdf;
  }

  const pdfDocument = await PDFDocument.load(sourcePdf);
  const now = Math.floor(Date.now() / 1000);
  const records = boxes.map((box) => toFieldRecord(box, now));
  const faces = await embedTextFaces(
    pdfDocument,
    records.map((record) => record.value ?? ""),
  );
  const imageCache = new Map<string, PDFImage>();
  const storedPages = new Map(
    (pages ?? []).map((page) => [page.pageNumber, page] as const),
  );

  for (const record of records) {
    const page = pdfDocument.getPage(record.page - 1);
    const geometry = getDisplayedPageGeometry(page);
    const field = fieldOnDisplayedPage(
      record,
      storedPages.get(record.page),
      geometry,
    );

    await stampFieldValue(
      field,
      page,
      { auditRegular: faces.regular, signature: faces.signature },
      imageCache,
      pdfDocument,
      storageService,
      geometry,
    );
  }

  return pdfDocument.save();
}
