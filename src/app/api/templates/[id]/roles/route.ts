import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { templateErrorResponse } from "@/lib/template-route";
import { replaceTemplateRoles } from "@/lib/templates";

type TemplateRolesRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/** Saves a template's roles, in signing order. */
export async function PUT(
  request: Request,
  context: TemplateRolesRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as unknown;

  try {
    const saved = await replaceTemplateRoles(session.user.id, id, body, {
      database: getDb(),
    });

    return NextResponse.json({
      ...saved,
      redirectPath: `/templates/${saved.id}/edit`,
    });
  } catch (error) {
    return templateErrorResponse(error, request, {
      category: "template_roles_failure",
      fallbackMessage: "Unable to save this template's signers.",
      userId: session.user.id,
    });
  }
}
