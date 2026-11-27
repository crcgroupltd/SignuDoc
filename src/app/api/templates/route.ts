import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { templateErrorResponse } from "@/lib/template-route";
import { createTemplateFromUpload } from "@/lib/templates";
import { MAX_REQUEST_BODY_BYTES } from "@/lib/types/domain";

// Makes a template from an uploaded PDF, without an envelope. The form
// carries the template's name and the file.

export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "template_create",
    key: buildRateLimitKey(["template-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BODY_BYTES) {
    return NextResponse.json(
      { error: "This file exceeds the 20 MB limit." },
      { status: 413 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!formData || !(file instanceof File)) {
    return NextResponse.json(
      { error: "A PDF file is required." },
      { status: 400 },
    );
  }

  try {
    const template = await createTemplateFromUpload(
      session.user.id,
      {
        name: formData.get("name"),
        sourcePdf: {
          body: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type,
          filename: file.name,
        },
      },
      { database: getDb() },
    );

    return NextResponse.json(
      { ...template, redirectPath: `/templates/${template.id}/roles` },
      { status: 201 },
    );
  } catch (error) {
    return templateErrorResponse(error, request, {
      category: "template_create_failure",
      fallbackMessage: "Unable to create the template.",
      userId: session.user.id,
    });
  }
}
