import { notFound } from "next/navigation";

import { TemplateRolesShell } from "@/components/templates/template-roles-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { getMaxSignersPerEnvelope } from "@/lib/signer-limit";
import { getTemplateRolesData } from "@/lib/templates";

type TemplateRolesPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function TemplateRolesPage({
  params,
}: TemplateRolesPageProps) {
  const { id } = await params;
  let template: Awaited<ReturnType<typeof getTemplateRolesData>> = null;
  let failed = false;

  try {
    const session = await getAuthSession();

    template = session
      ? await getTemplateRolesData(session.user.id, id, getDb())
      : null;
  } catch {
    failed = true;
  }

  if (!failed && !template) {
    notFound();
  }

  return (
    <TemplateRolesShell
      key={id}
      maxRoles={getMaxSignersPerEnvelope()}
      template={template ?? undefined}
    />
  );
}
