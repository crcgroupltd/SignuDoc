import { notFound } from "next/navigation";

import { PrepareLiveShell } from "@/components/envelopes/prepare-live-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { PREFILL_ASSIGNEE_ID } from "@/lib/schemas/template";
import { getTemplateEditorData } from "@/lib/templates";

type EditTemplatePageProps = {
  params: Promise<{
    id: string;
  }>;
};

// The template's field editor: the envelope field editor, saving to the
// template, with one more assignee for the boxes the sender fills in.
export default async function EditTemplatePage({
  params,
}: EditTemplatePageProps) {
  const { id } = await params;
  let record: Awaited<ReturnType<typeof getTemplateEditorData>> = null;
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();

    record = session
      ? await getTemplateEditorData(session.user.id, id, {
          database: getDb(),
        })
      : null;
  } catch {
    initialState = "error";
  }

  if (!initialState && !record) {
    notFound();
  }

  return (
    <PrepareLiveShell
      envelopeId={id}
      initialState={initialState}
      key={id}
      record={record ?? undefined}
      target={{
        backHref: `/templates/${id}/roles`,
        cachedPdfId: null,
        doneHref: "/templates",
        doneLabel: "Save template",
        fieldsUrl: `/api/templates/${id}/fields`,
        prefillAssigneeId: PREFILL_ASSIGNEE_ID,
        stepLabel: "Step 3 of 3",
      }}
    />
  );
}
