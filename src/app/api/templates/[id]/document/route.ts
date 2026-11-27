import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { buildContentDisposition } from "@/lib/services/storage";
import { templateErrorResponse } from "@/lib/template-route";
import { getTemplateDocumentForUser } from "@/lib/templates";

type TemplateDocumentRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/** The template's document, for its owner's field editor. */
export async function GET(
  request: Request,
  context: TemplateDocumentRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const document = await getTemplateDocumentForUser(session.user.id, id, {
      database: getDb(),
    });

    return new Response(document.body.slice().buffer as ArrayBuffer, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(
          document.fileName,
          "inline",
        ),
        "content-length": String(document.body.byteLength),
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    return templateErrorResponse(error, request, {
      category: "template_document_failure",
      fallbackMessage: "Unable to load this template's document.",
      userId: session.user.id,
    });
  }
}
