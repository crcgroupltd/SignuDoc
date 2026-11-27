import { apiJson } from "@/lib/api/http";
import { handleApi } from "@/lib/api/route";
import { listTemplatesForUser } from "@/lib/templates";

// The key's saved templates, with their roles in signing order.
export async function GET(request: Request) {
  return handleApi(
    request,
    "read",
    "api_template_list_failure",
    async ({ actor }) => {
      const templates = await listTemplatesForUser(actor.userId);

      return apiJson({
        data: templates.map((template) => ({
          id: template.id,
          name: template.name,
          object: "template",
          // Boxes to give values for, by id, in "prefill" when using it.
          prefill: template.prefillFields.map((field) => ({
            id: field.id,
            label: field.label ?? null,
            ...(field.options ? { options: field.options } : {}),
            required: field.required,
            type: field.type,
          })),
          roles: template.roleNames,
        })),
        object: "list",
      });
    },
  );
}
