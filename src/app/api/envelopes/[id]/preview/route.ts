import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  EnvelopeDocumentAccessError,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
} from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { renderSendPreview } from "@/lib/services/send-preview";
import {
  buildContentDisposition,
  createStorageService,
} from "@/lib/services/storage";

// The draft as it will go out: prefilled values (already in its document),
// every signer's name in their name fields, and outlines for what the
// signers still fill. For the draft's own sender, before sending.

type EnvelopePreviewRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(
  request: Request,
  context: EnvelopePreviewRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const draft = await getPrepareEnvelopeDataForUser(session.user.id, id, {
      database: getDb(),
    });

    if (!draft) {
      return NextResponse.json(
        { error: "Envelope not found." },
        { headers: NO_STORE, status: 404 },
      );
    }

    if (draft.status !== "draft") {
      return NextResponse.json(
        { error: "Only an envelope that has not been sent has a preview." },
        { headers: NO_STORE, status: 409 },
      );
    }

    const storageService = createStorageService();
    const document = await getDraftEnvelopeDocumentForUser(
      session.user.id,
      id,
      { database: getDb(), storageService },
    );
    // Signers in the order the field editor colours them: approvers have
    // no fields and no colour.
    const signers = [...draft.signers]
      .filter((signer) => signer.role !== "approver")
      .sort((left, right) => left.order - right.order)
      .map((signer, index) => ({
        id: signer.id,
        name: signer.name,
        order: index + 1,
      }));
    const preview = await renderSendPreview({
      fields: draft.fields,
      pages: draft.pages,
      signers,
      sourcePdf: new Uint8Array(document.body),
      storageService,
    });

    return new Response(preview.slice().buffer as ArrayBuffer, {
      headers: {
        ...NO_STORE,
        "content-disposition": buildContentDisposition(
          `Preview - ${document.fileName}`,
          new URL(request.url).searchParams.get("download") === "1"
            ? "attachment"
            : "inline",
        ),
        "content-length": String(preview.byteLength),
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof EnvelopeDocumentAccessError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_preview_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while rendering a send preview.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to show a preview of this envelope." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
