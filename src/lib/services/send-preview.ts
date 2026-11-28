import { PDFDocument, type PDFImage, rgb, type RGB } from "pdf-lib";

import type { FieldRecord } from "../schemas/field.ts";
import { normalizedRectToPdfRect } from "../utils/pdf-coords.ts";
import { stampFieldValue } from "./pdf-finalize.ts";
import { embedTextFaces, type TextFace } from "./pdf-fonts.ts";
import {
  drawOnDisplayedPage,
  fieldOnDisplayedPage,
  getDisplayedPageGeometry,
  type StoredPageSize,
} from "./pdf-page-geometry.ts";
import type { StorageService } from "./storage.ts";

// The document as it will go out, for the sender to check before sending.
// Prefilled values are already part of a draft's document. On top of it
// this stamps each signer's name into their name fields, as sending does,
// and outlines the fields the signers still fill, labeled with the kind of
// field and who fills it. Nothing is stored.

export type PreviewSigner = {
  id: string;
  name: string;
  /** Position in the signing order, from 1; picks the outline colour. */
  order: number;
};

// The signer colours of the app's own palette (globals.css --signer-1..4).
const SIGNER_COLORS: readonly RGB[] = [
  rgb(0x25 / 255, 0x63 / 255, 0xeb / 255),
  rgb(0x93 / 255, 0x33 / 255, 0xea / 255),
  rgb(0xb4 / 255, 0x53 / 255, 0x09 / 255),
  rgb(0x04 / 255, 0x78 / 255, 0x57 / 255),
];

const FIELD_TYPE_LABELS: Record<FieldRecord["type"], string> = {
  checkbox: "Checkbox",
  date: "Date signed",
  dropdown: "Dropdown",
  initials: "Initials",
  name: "Name",
  number: "Number",
  radio: "Choice",
  signature: "Signature",
  text: "Text",
};

const MAX_LABEL_SIZE = 8;
const MIN_LABEL_SIZE = 4;

function colorFor(signer: PreviewSigner | undefined): RGB {
  const index = Math.max(0, (signer?.order ?? 1) - 1);

  return SIGNER_COLORS[Math.min(index, SIGNER_COLORS.length - 1)]!;
}

/** "Signature – Client", or the radio button's own label. */
export function previewFieldLabel(
  field: Pick<FieldRecord, "label" | "type">,
  signerName: string,
): string {
  const kind =
    field.type === "radio" && field.label?.trim()
      ? field.label.trim()
      : FIELD_TYPE_LABELS[field.type];

  return `${kind} – ${signerName}`;
}

/** The label cut down, with an ellipsis, until it fits the width. */
function fitLabel(
  face: TextFace,
  text: string,
  maxWidth: number,
  size: number,
): string {
  if (face.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }

  const characters = Array.from(text);

  while (characters.length > 1) {
    characters.pop();

    const candidate = `${characters.join("").trimEnd()}…`;

    if (face.widthOfTextAtSize(candidate, size) <= maxWidth) {
      return candidate;
    }
  }

  return "";
}

export async function renderSendPreview({
  fields,
  pages,
  signers,
  sourcePdf,
  storageService,
}: {
  fields: readonly FieldRecord[];
  pages: readonly StoredPageSize[];
  signers: readonly PreviewSigner[];
  sourcePdf: Uint8Array;
  storageService: StorageService;
}): Promise<Uint8Array> {
  const pdfDocument = await PDFDocument.load(sourcePdf);
  const signersById = new Map(signers.map((signer) => [signer.id, signer]));
  const now = Math.floor(Date.now() / 1000);
  const storedPages = new Map(pages.map((page) => [page.pageNumber, page]));
  const labels = fields.map((field) =>
    previewFieldLabel(field, signersById.get(field.signerId)?.name ?? "Signer"),
  );
  const faces = await embedTextFaces(pdfDocument, [
    labels,
    signers.map((signer) => signer.name),
    // A label cut short to fit its box ends with an ellipsis.
    "…",
  ]);
  const imageCache = new Map<string, PDFImage>();

  for (const [index, field] of fields.entries()) {
    if (field.page < 1 || field.page > pdfDocument.getPageCount()) {
      continue;
    }

    const page = pdfDocument.getPage(field.page - 1);
    const geometry = getDisplayedPageGeometry(page);
    const placed = fieldOnDisplayedPage(
      field,
      storedPages.get(field.page),
      geometry,
    );
    const signer = signersById.get(field.signerId);

    if (field.type === "name" && signer) {
      // As sending fills it.
      await stampFieldValue(
        {
          ...placed,
          inputMethod: "auto",
          submittedAt: now,
          value: signer.name,
        },
        page,
        { auditRegular: faces.regular, signature: faces.signature },
        imageCache,
        pdfDocument,
        storageService,
        geometry,
      );
      continue;
    }

    const color = colorFor(signer);
    const label = labels[index] ?? "";

    await drawOnDisplayedPage(page, geometry, () => {
      const rect = normalizedRectToPdfRect(placed, geometry);

      page.drawRectangle({
        borderColor: color,
        borderOpacity: 0.9,
        borderWidth: 0.75,
        color,
        height: rect.heightPt,
        opacity: 0.08,
        width: rect.widthPt,
        x: rect.xPt,
        y: rect.yPt,
      });

      const padding = Math.min(2, rect.widthPt / 10, rect.heightPt / 10);
      const size = Math.max(
        MIN_LABEL_SIZE,
        Math.min(MAX_LABEL_SIZE, rect.heightPt * 0.45),
      );
      const text = fitLabel(
        faces.regular,
        label,
        rect.widthPt - padding * 2,
        size,
      );

      if (text && rect.heightPt >= MIN_LABEL_SIZE) {
        faces.regular.drawText(page, text, {
          color,
          size,
          x: rect.xPt + padding,
          y: rect.yPt + Math.max(padding, (rect.heightPt - size) / 2),
        });
      }
    });
  }

  return pdfDocument.save();
}
