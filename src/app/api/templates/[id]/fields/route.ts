import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { templateErrorResponse } from "@/lib/template-route";
import { replaceTemplateFields } from "@/lib/templates";

type TemplateFieldsRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/**
 * Saves the fields placed in the template editor. It answers the way the
 * envelope field route does, so the same editor can save to either.
 */
export async function PUT(
  request: Request,
  context: TemplateFieldsRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as unknown;

  try {
    return NextResponse.json(
      await replaceTemplateFields(session.user.id, id, body, {
        database: getDb(),
      }),
    );
  } catch (error) {
    return templateErrorResponse(error, request, {
      category: "template_fields_failure",
      fallbackMessage: "Unable to save this template's fields.",
      userId: session.user.id,
    });
  }
}
