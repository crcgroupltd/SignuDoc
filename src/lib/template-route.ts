import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { EnvelopeMutationError } from "./envelopes.ts";
import { logRouteError } from "./security/logging.ts";
import { getClientIpAddress, getRequestPathname } from "./security/request.ts";
import { DocumentImportError } from "./services/document-import.ts";
import { TemplateError } from "./templates.ts";

// How the template routes answer a failure: a request the sender can fix
// gets its message (and, for a prefill box, which box), anything else is
// logged and answered with a general message.

export function templateErrorResponse(
  error: unknown,
  request: Request,
  {
    category,
    fallbackMessage,
    userId,
  }: { category: string; fallbackMessage: string; userId: string },
): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: error.issues[0]?.message ?? "Invalid template request." },
      { status: 400 },
    );
  }

  if (error instanceof TemplateError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.fieldId ? { fieldId: error.fieldId } : {}),
      },
      { status: error.statusCode },
    );
  }

  if (error instanceof EnvelopeMutationError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof DocumentImportError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  logRouteError(error, {
    category,
    ipAddress: getClientIpAddress(request.headers),
    message: fallbackMessage,
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}
