import { z } from "zod";

import {
  MAX_SIGNERS_CEILING,
  recipientRoles,
  signatureMeanings,
} from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  nameSchema,
  nonEmptyStringSchema,
} from "./common.ts";
import { fieldPlacementListSchema, fieldPlacementSchema } from "./field.ts";
import { duplicateSignerEmailMessage } from "./signer.ts";

export const MAX_TEMPLATE_ROLE_NAME_LENGTH = 60;

export const templateNameSchema = envelopeTitleSchema;
export const templateRoleNameSchema = nonEmptyStringSchema.max(
  MAX_TEMPLATE_ROLE_NAME_LENGTH,
);
export const duplicateRoleNameMessage =
  "Give each signer in the template a different name.";

/** One place in a template's signing order, such as "Client". */
export const templateRoleSchema = z.object({
  id: idSchema,
  name: templateRoleNameSchema,
  // The step of the signing order the role is in; roles that share one
  // sign at the same time. Templates saved before steps existed have none,
  // and their roles sign one after the other.
  step: z.number().int().positive().max(MAX_SIGNERS_CEILING).optional(),
  // Whether the person in this role signs or only approves. Templates
  // saved before approvers existed have none, and every role signs.
  kind: z.enum(recipientRoles).optional(),
});

/** A template's roles, in the order their people will sign. */
export const templateRolesSchema = z
  .array(templateRoleSchema)
  .min(1)
  .max(MAX_SIGNERS_CEILING)
  .superRefine((roles, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();

    for (const [index, role] of roles.entries()) {
      const name = role.name.toLowerCase();

      if (names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: duplicateRoleNameMessage,
          path: [index, "name"],
        });
      }

      if (ids.has(role.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer in the template must be unique.",
          path: [index, "id"],
        });
      }

      ids.add(role.id);
      names.add(name);
    }
  });

/** Saving an envelope as a template. */
export const saveTemplateSchema = z.object({
  name: templateNameSchema,
  // What to call each signer, in signing order. Left out, they are called
  // "Signer 1", "Signer 2" and so on.
  roleNames: z
    .array(templateRoleNameSchema)
    .min(1)
    .max(MAX_SIGNERS_CEILING)
    .optional(),
});

/**
 * The assignee the field editor gives a box the sender fills in before
 * sending. It is never a role's id: those are UUIDs.
 */
export const PREFILL_ASSIGNEE_ID = "prefill";

/** Field types a sender cannot fill in for someone else. */
export const NON_PREFILL_FIELD_TYPES = ["signature", "initials"] as const;

export const MAX_PREFILL_TEXT_LENGTH = 2000;

/**
 * A box the sender fills in when using the template. Placed like a field,
 * with PREFILL_ASSIGNEE_ID in place of a role, and an id the "use" form
 * answers it by. Its label is what the sender is asked.
 */
/**
 * What a prefill box starts with, set when the template is made: text
 * (YYYY-MM-DD for a date), or ticked for a checkbox or radio button. The
 * sender can change it when using the template.
 */
export const prefillDefaultValueSchema = z.union([
  z.string().max(MAX_PREFILL_TEXT_LENGTH),
  z.boolean(),
]);

export const prefillFieldSchema = fieldPlacementSchema
  .safeExtend({
    defaultValue: prefillDefaultValueSchema.optional(),
    id: idSchema,
  })
  .superRefine((field, ctx) => {
    if ((NON_PREFILL_FIELD_TYPES as readonly string[]).includes(field.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Signatures and initials can't be filled in before sending.",
        path: ["type"],
      });
    }

    if (field.signerId !== PREFILL_ASSIGNEE_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A prefill box belongs to no signer.",
        path: ["signerId"],
      });
    }
  });

export const prefillFieldListSchema = z
  .array(prefillFieldSchema)
  .superRefine((fields, ctx) => {
    // The radio group rules (same assignee, required together, group size)
    // are the ones signer fields follow.
    const groups = fieldPlacementListSchema.safeParse(fields);

    if (!groups.success) {
      for (const issue of groups.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

/** A value given for one prefill box: text, or ticked for a checkbox or radio button. */
export const prefillValuesSchema = z
  .record(
    idSchema,
    z.union([z.string().max(MAX_PREFILL_TEXT_LENGTH), z.boolean()]),
  )
  .default({});

/** Making a template from an uploaded document. */
export const createTemplateSchema = z.object({
  name: templateNameSchema,
});

export const renameTemplateSchema = z.object({
  name: templateNameSchema,
});

/** The roles of a template as its editor saves them, in signing order. */
export const replaceTemplateRolesSchema = z.object({
  roles: templateRolesSchema,
});

/** A template's fields as the field editor saves them. */
export const replaceTemplateFieldsSchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
  // A prefill box may carry its default value; signer fields never do.
  fields: z.array(
    fieldPlacementSchema.safeExtend({
      defaultValue: prefillDefaultValueSchema.optional(),
    }),
  ),
});

/** Starting an envelope from a template: who fills each role, in order. */
export const useTemplateSchema = z.object({
  // Values for the template's prefill boxes, by box id. Left out, every
  // box is left empty, which a required box refuses.
  prefill: prefillValuesSchema,
  signers: z
    .array(
      z.object({
        email: emailSchema,
        name: nameSchema,
        // What the signature means, for Part 11 envelopes. The web app
        // asks for it later; the API can give it here, so the draft can be
        // sent at once.
        signatureMeaning: z.enum(signatureMeanings).optional(),
      }),
    )
    .min(1)
    .max(MAX_SIGNERS_CEILING)
    .superRefine((signers, ctx) => {
      const emails = new Set<string>();

      for (const [index, signer] of signers.entries()) {
        const email = signer.email.toLowerCase();

        if (emails.has(email)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: duplicateSignerEmailMessage,
            path: [index, "email"],
          });
        }

        emails.add(email);
      }
    }),
  title: envelopeTitleSchema,
});

export type TemplateRole = z.infer<typeof templateRoleSchema>;
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;
export type UseTemplateInput = z.infer<typeof useTemplateSchema>;
export type PrefillField = z.infer<typeof prefillFieldSchema>;
export type PrefillValues = z.infer<typeof prefillValuesSchema>;
