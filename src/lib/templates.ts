import { randomUUID } from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeDocumentAccessError,
  findUnreadableDropdown,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  type PrepareEnvelopeData,
} from "./envelopes.ts";
import {
  countAnswerableFields,
  describeChoiceFieldProblem,
  findChoiceFieldProblem,
} from "./field-choices.ts";
import {
  assertPrefillDefaults,
  hasRequiredPrefill,
  PrefillError,
  resolvePrefillValues,
  withPrefillDefaults,
} from "./prefill.ts";
import {
  fieldPlacementListSchema,
  type FieldPlacement,
  type FieldRecord,
} from "./schemas/field.ts";
import {
  createTemplateSchema,
  PREFILL_ASSIGNEE_ID,
  prefillFieldListSchema,
  renameTemplateSchema,
  replaceTemplateFieldsSchema,
  replaceTemplateRolesSchema,
  saveTemplateSchema,
  templateRolesSchema,
  useTemplateSchema,
  type PrefillField,
  type TemplateRole,
} from "./schemas/template.ts";
import {
  DocumentImportError,
  importPdfDocument,
} from "./services/document-import.ts";
import { findTypedValueTooLongForField } from "./services/pdf-finalize.ts";
import type { StoredPageSize } from "./services/pdf-page-geometry.ts";
import { stampPrefilledBoxes } from "./services/prefill-stamp.ts";
import { buildTemplatePdfKey } from "./services/storage-keys.ts";
import { normalizeSigningSteps } from "./signing-steps.ts";
import {
  createStorageService,
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";

// A template is a document, the fields placed on it and its signing order,
// kept so the same thing can be sent again. It names no one: each place in
// the signing order is a role ("Client"), filled in when the template is
// used. It is made from an envelope and turned back into a draft envelope,
// so everything a draft can hold, a template can hold.

/** A guard on storage, not a product limit anyone should run into. */
export const MAX_TEMPLATES_PER_USER = 100;

const UNUSABLE_TEMPLATE_MESSAGE =
  "This template can no longer be used. Delete it, then save the document as a template again.";

export class TemplateError extends Error {
  /** The prefill box the message is about, when it is about one. */
  readonly fieldId: string | null;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    fieldId: string | null = null,
  ) {
    super(message);
    this.name = "TemplateError";
    this.fieldId = fieldId;
    this.statusCode = statusCode;
  }
}

type TemplateOptions = {
  database?: DbPool;
  storageService?: StorageService;
};

/** Refuses another template for a user who already has the most allowed. */
async function assertRoomForTemplate(
  userId: string,
  database: DbExecutor,
): Promise<void> {
  const existing = await queryOne<{ total: number }>(
    database,
    `SELECT count(*)::int AS total FROM templates WHERE user_id = $1`,
    [userId],
  );

  if ((existing?.total ?? 0) >= MAX_TEMPLATES_PER_USER) {
    throw new TemplateError(
      `You have ${String(MAX_TEMPLATES_PER_USER)} templates, which is the most an account can keep. Delete one to save another.`,
      409,
    );
  }
}

type TemplateRow = {
  createdAt: number;
  fields: unknown;
  fieldsRevision: number;
  id: string;
  name: string;
  pageCount: number;
  pages: unknown;
  prefillFields: unknown;
  roles: unknown;
  sourcePdfFilename: string;
  sourcePdfKey: string;
};

export type TemplateListItem = {
  createdAtLabel: string;
  fieldCountLabel: string;
  id: string;
  name: string;
  pageCountLabel: string;
  /** Boxes the sender fills in when using it. Empty when unreadable. */
  prefillFields: PrefillField[];
  /** In signing order. */
  roleNames: string[];
};

/** What the "use this template" form needs. */
export type UseTemplateData = {
  fieldCountLabel: string;
  id: string;
  name: string;
  pageCountLabel: string;
  /** Boxes the sender fills in before sending, in the order they were placed. */
  prefillFields: PrefillField[];
  roles: TemplateRole[];
};

export type SavedTemplate = {
  id: string;
  name: string;
};

export type DraftFromTemplate = {
  envelopeId: string;
  redirectPath: string;
};

const TEMPLATE_COLUMNS = `
  id,
  name,
  page_count AS "pageCount",
  roles,
  fields,
  prefill_fields AS "prefillFields",
  pages,
  fields_revision AS "fieldsRevision",
  source_pdf_key AS "sourcePdfKey",
  source_pdf_filename AS "sourcePdfFilename",
  created_at AS "createdAt"
`;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function countLabel(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}

// A list must still open when one template's stored contents cannot be
// read, so the names and the count are taken leniently here. Using a
// template checks them properly.
function readRoleNames(roles: unknown): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }

  return roles.flatMap((role: unknown) =>
    typeof role === "object" &&
    role !== null &&
    "name" in role &&
    typeof role.name === "string"
      ? [role.name]
      : [],
  );
}

function countFields(fields: unknown): number {
  if (!Array.isArray(fields)) {
    return 0;
  }

  return countAnswerableFields(
    fields.flatMap((field: unknown) =>
      typeof field === "object" && field !== null
        ? [
            {
              groupId:
                "groupId" in field && typeof field.groupId === "string"
                  ? field.groupId
                  : undefined,
              type: "type" in field ? String(field.type) : "",
            },
          ]
        : [],
    ),
    () => true,
  );
}

async function getTemplateRow(
  userId: string,
  templateId: string,
  database: DbExecutor,
): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(
    database,
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = $1 AND user_id = $2`,
    [templateId, userId],
  );
}

/** The template's prefill boxes; one that cannot be read cannot be used. */
function readPrefillFields(value: unknown): PrefillField[] {
  const parsed = prefillFieldListSchema.safeParse(value ?? []);

  if (!parsed.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  return parsed.data;
}

function readPages(value: unknown): StoredPageSize[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const pages = value.flatMap((page: unknown) =>
    typeof page === "object" &&
    page !== null &&
    "pageNumber" in page &&
    "widthPt" in page &&
    "heightPt" in page &&
    typeof page.pageNumber === "number" &&
    typeof page.widthPt === "number" &&
    typeof page.heightPt === "number"
      ? [
          {
            heightPt: page.heightPt,
            pageNumber: page.pageNumber,
            widthPt: page.widthPt,
          },
        ]
      : [],
  );

  return pages.length > 0 ? pages : null;
}

function toStoredPages(
  pages: ReadonlyArray<{
    heightPt: number;
    pageNumber: number;
    widthPt: number;
  }>,
): StoredPageSize[] {
  return pages.map((page) => ({
    heightPt: page.heightPt,
    pageNumber: page.pageNumber,
    widthPt: page.widthPt,
  }));
}

/**
 * Why Send to many cannot use this template, when the reason is its
 * prefill boxes: values for them are only given one envelope at a time.
 */
export function describeBulkSendPrefillProblem(
  prefillFields: readonly PrefillField[],
): string | null {
  return hasRequiredPrefill(prefillFields)
    ? "This template has boxes that must be filled in before sending and have no default value, so it can only be sent one envelope at a time. Give them defaults in the template, or use it from the Templates page instead."
    : null;
}

export async function listTemplatesForUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<TemplateListItem[]> {
  const rows = await queryMany<TemplateRow>(
    database,
    `
      SELECT ${TEMPLATE_COLUMNS}
      FROM templates
      WHERE user_id = $1
      ORDER BY created_at DESC, id ASC
    `,
    [userId],
  );

  return rows.map((row) => ({
    createdAtLabel: dateFormatter.format(new Date(row.createdAt * 1000)),
    fieldCountLabel: countLabel(countFields(row.fields), "field"),
    id: row.id,
    name: row.name,
    pageCountLabel: countLabel(row.pageCount, "page"),
    // Leniently, as the names are: a list must open even when one
    // template's boxes cannot be read. Using it checks them properly.
    prefillFields:
      prefillFieldListSchema.safeParse(row.prefillFields ?? []).data ?? [],
    roleNames: readRoleNames(row.roles),
  }));
}

export type TemplateForBulkSend = UseTemplateData & {
  fields: unknown;
  pages: StoredPageSize[] | null;
  sourcePdfFilename: string;
  sourcePdfKey: string;
};

/**
 * Whether this template can be sent as it stands: someone has to sign,
 * every signer role needs a signature field, an approver role has no
 * fields, and choice fields must be finished. Saved from a draft
 * that was still being prepared, it is kept, but it cannot go out.
 */
export function describeUnsendableTemplate(
  roles: readonly TemplateRole[],
  fields: unknown,
): string | null {
  if (roles.length === 0) {
    return "Add signers and place fields before sending this envelope.";
  }

  const parsed = fieldPlacementListSchema.safeParse(fields);

  if (!parsed.success) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (parsed.data.length === 0) {
    return "Add signers and place fields before sending this envelope.";
  }

  const roleIds = new Set(roles.map((role) => role.id));

  if (parsed.data.some((field) => !roleIds.has(field.signerId))) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (!roles.some((role) => role.kind !== "approver")) {
    return "Add at least one signer. Approvers approve or reject, so someone else has to sign.";
  }

  const approverWithFields = roles.find(
    (role) =>
      role.kind === "approver" &&
      parsed.data.some((field) => field.signerId === role.id),
  );

  if (approverWithFields) {
    return `${approverWithFields.name} is an approver, and approvers have no fields. Remove their fields, or make them a signer.`;
  }

  const missing = roles.find(
    (role) =>
      role.kind !== "approver" &&
      !parsed.data.some(
        (field) => field.signerId === role.id && field.type === "signature",
      ),
  );

  if (missing) {
    return `Every signer must have at least one Signature field before sending. ${missing.name} is missing one.`;
  }

  const choiceProblem = findChoiceFieldProblem(parsed.data);

  if (!choiceProblem) {
    return null;
  }

  return describeChoiceFieldProblem(
    choiceProblem,
    roles.find((role) => role.id === choiceProblem.signerId)?.name ??
      "a signer",
  );
}

/**
 * Whether any dropdown on the template is too small to show one of its
 * choices at a readable size on the template's PDF, in words for the
 * sender, or null. Mirrors sendDraftEnvelope so Send to many rejects an
 * unreadable dropdown before preview marks rows Ready or creates drafts.
 */
export async function describeTemplateDropdownProblem(
  roles: readonly TemplateRole[],
  fields: unknown,
  sourcePdf: { filename: string; key: string },
  storageService?: StorageService,
): Promise<string | null> {
  const parsed = fieldPlacementListSchema.safeParse(fields);

  if (!parsed.success) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (
    !parsed.data.some(
      (field) => field.type === "dropdown" && (field.options?.length ?? 0) > 0,
    )
  ) {
    return null;
  }

  const resolvedStorage = storageService ?? createStorageService();
  let sourcePdfBody: Uint8Array;

  try {
    sourcePdfBody = (await resolvedStorage.getObject(sourcePdf.key)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }

  let imported: Awaited<ReturnType<typeof importPdfDocument>>;

  try {
    imported = await importPdfDocument({
      body: sourcePdfBody,
      contentType: "application/pdf",
      filename: sourcePdf.filename,
    });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      throw new TemplateError(error.message, 400);
    }

    throw error;
  }

  return findUnreadableDropdown(roles, parsed.data, imported.pages);
}

export async function getTemplateForBulkSend(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
  {
    checkDropdownReadability = true,
    storageService,
  }: {
    checkDropdownReadability?: boolean;
    storageService?: StorageService;
  } = {},
): Promise<TemplateForBulkSend | null> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    return null;
  }

  const roles = templateRolesSchema.safeParse(row.roles);

  if (!roles.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  if (
    checkDropdownReadability &&
    describeUnsendableTemplate(roles.data, row.fields) === null
  ) {
    const dropdownProblem = await describeTemplateDropdownProblem(
      roles.data,
      row.fields,
      {
        filename: row.sourcePdfFilename,
        key: row.sourcePdfKey,
      },
      storageService,
    );

    if (dropdownProblem) {
      throw new TemplateError(dropdownProblem, 400);
    }
  }

  return {
    fieldCountLabel: countLabel(countFields(row.fields), "field"),
    fields: row.fields,
    id: row.id,
    name: row.name,
    pageCountLabel: countLabel(row.pageCount, "page"),
    pages: readPages(row.pages),
    prefillFields: readPrefillFields(row.prefillFields),
    roles: roles.data,
    sourcePdfFilename: row.sourcePdfFilename,
    sourcePdfKey: row.sourcePdfKey,
  };
}

export async function getUseTemplateDataForUser(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
): Promise<UseTemplateData | null> {
  const template = await getTemplateForBulkSend(userId, templateId, database, {
    checkDropdownReadability: false,
  });

  if (!template) {
    return null;
  }

  return {
    fieldCountLabel: template.fieldCountLabel,
    id: template.id,
    name: template.name,
    pageCountLabel: template.pageCountLabel,
    prefillFields: template.prefillFields,
    roles: template.roles,
  };
}

/**
 * Keeps an envelope's document, fields and signing order as a template.
 * Any envelope of the user's will do, sent or not: only where the fields
 * are is copied, never what was entered in them, and the signers' names
 * and addresses are left behind.
 */
export async function saveEnvelopeAsTemplate(
  userId: string,
  envelopeId: string,
  input: unknown,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<SavedTemplate> {
  const parsedInput = saveTemplateSchema.parse(input);
  const envelope = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
    database,
  });

  if (!envelope) {
    throw new TemplateError("Envelope not found.", 404);
  }

  const signers = [...envelope.signers].sort(
    (left, right) => left.order - right.order,
  );

  if (signers.length === 0) {
    throw new TemplateError(
      "Add at least one signer before saving this as a template.",
      400,
    );
  }

  const roleNames =
    parsedInput.roleNames ??
    signers.map((_, index) => `Signer ${String(index + 1)}`);

  if (roleNames.length !== signers.length) {
    throw new TemplateError(
      "The signers of this envelope have changed. Reload the page and try again.",
      409,
    );
  }

  // Each role keeps its signer's step, so roles that signed at the same
  // time still do when the template is used, and whether they sign or
  // approve.
  const steps = normalizeSigningSteps(signers.map((signer) => signer.step));
  const roles = templateRolesSchema.parse(
    roleNames.map((name, index) => ({
      id: randomUUID(),
      kind: signers[index]?.role ?? "signer",
      name,
      step: steps[index],
    })),
  );
  const roleIdBySignerId = new Map(
    signers.map((signer, index) => [signer.id, roles[index]!.id] as const),
  );
  // Where each field is and what kind it is. Anything a signer entered
  // stays with the envelope.
  const fields = fieldPlacementListSchema.parse(
    envelope.fields.flatMap((field) => {
      const roleId = roleIdBySignerId.get(field.signerId);

      return roleId
        ? [
            {
              groupId: field.groupId,
              height: field.height,
              label: field.label,
              options: field.options,
              page: field.page,
              required: field.required,
              signerId: roleId,
              type: field.type,
              width: field.width,
              x: field.x,
              y: field.y,
            },
          ]
        : [];
    }),
  );

  // Before the document is copied, so a full account costs no upload. It is
  // counted again when the template is stored.
  await assertRoomForTemplate(userId, database);

  let document: Awaited<ReturnType<typeof getDraftEnvelopeDocumentForUser>>;

  try {
    document = await getDraftEnvelopeDocumentForUser(userId, envelopeId, {
      database,
      storageService,
    });
  } catch (error) {
    if (error instanceof EnvelopeDocumentAccessError) {
      throw new TemplateError(
        "This envelope's document is no longer available, so it cannot be saved as a template.",
        error.statusCode,
      );
    }

    throw error;
  }

  const templateId = randomUUID();
  const sourcePdfKey = buildTemplatePdfKey({ templateId, userId });
  const now = Math.floor(Date.now() / 1000);

  await storageService.putObject({
    body: document.body,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  try {
    await withTransaction(async (tx) => {
      // Two saves at the same moment would both pass the count above. Here
      // the saves of one user take turns, and each counts what the one
      // before it stored.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 13))", [
        userId,
      ]);
      await assertRoomForTemplate(userId, tx);
      await tx.query(
        `
          INSERT INTO templates (
            id,
            user_id,
            name,
            source_pdf_key,
            source_pdf_filename,
            source_pdf_size_bytes,
            page_count,
            roles,
            fields,
            pages,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $11)
        `,
        [
          templateId,
          userId,
          parsedInput.name,
          sourcePdfKey,
          document.fileName,
          document.body.length,
          envelope.pageCount,
          JSON.stringify(roles),
          JSON.stringify(fields),
          JSON.stringify(toStoredPages(envelope.pages)),
          now,
        ],
      );
    }, database);
  } catch (error) {
    // Nothing points at the copy, so nothing would ever remove it.
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }

  return { id: templateId, name: parsedInput.name };
}

/**
 * Starts a draft envelope from a template: the template's document and
 * fields, with a person named for each role. The draft is an ordinary one
 * from then on, and changing it does not change the template.
 */
export async function createDraftFromTemplate(
  userId: string,
  templateId: string,
  input: unknown,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<DraftFromTemplate> {
  const parsedInput = useTemplateSchema.parse(input);
  const template = await getTemplateRow(userId, templateId, database);

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  const roles = templateRolesSchema.safeParse(template.roles);
  const fields = fieldPlacementListSchema.safeParse(template.fields);

  if (!roles.success || !fields.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  const roleIds = new Set(roles.data.map((role) => role.id));

  if (fields.data.some((field) => !roleIds.has(field.signerId))) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  const prefillFields = readPrefillFields(template.prefillFields);
  let prefilled: ReturnType<typeof resolvePrefillValues>;

  try {
    prefilled = resolvePrefillValues(
      prefillFields,
      withPrefillDefaults(prefillFields, parsedInput.prefill),
    );
  } catch (error) {
    if (error instanceof PrefillError) {
      throw new TemplateError(error.message, 400, error.fieldId);
    }

    throw error;
  }

  if (parsedInput.signers.length !== roles.data.length) {
    throw new TemplateError(
      "Name one person for each signer in this template.",
      400,
    );
  }

  let sourcePdf: Uint8Array;

  try {
    sourcePdf = (await storageService.getObject(template.sourcePdfKey)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }

  if (prefilled.length > 0) {
    const pages =
      readPages(template.pages) ??
      toStoredPages(
        (
          await importPdfDocument({
            body: sourcePdf,
            contentType: "application/pdf",
            filename: template.sourcePdfFilename,
          })
        ).pages,
      );
    // A value that would only fit its box below a readable size is refused,
    // as a signer's typed answer is.
    const textBoxes = prefilled.filter(
      (box) => box.value !== null && box.field.type !== "date",
    );
    const tooLong = await findTypedValueTooLongForField(
      textBoxes.map((box) => ({ field: box.field, value: box.value ?? "" })),
      pages,
    );

    if (tooLong) {
      const box = textBoxes.find((entry) => entry.field.page === tooLong.page);

      throw new TemplateError(
        `A value on page ${String(tooLong.page)} is too long for its box. Shorten it to ${String(tooLong.maxCharacters)} characters or fewer.`,
        400,
        box?.field.id ?? null,
      );
    }

    sourcePdf = await stampPrefilledBoxes(
      sourcePdf,
      prefilled,
      pages,
      storageService,
    );
  }

  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: template.sourcePdfFilename,
      },
      title: parsedInput.title,
    },
    { database, storageService },
  );
  const envelopeId = draft.envelope.id;

  try {
    const roleSteps = roles.data.every((role) => role.step !== undefined)
      ? roles.data.map((role) => role.step)
      : null;
    const saved = await replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      {
        // The roles' steps, when the template has them. One saved before
        // steps existed has none, and its people sign one after the other.
        signers: parsedInput.signers.map((signer, index) => ({
          ...signer,
          role: roles.data[index]?.kind ?? "signer",
          ...(roleSteps ? { signingStep: roleSteps[index] } : {}),
        })),
      },
      database,
    );
    const signerIdByOrder = new Map(
      saved.signers.map((signer) => [signer.signOrder, signer.id] as const),
    );
    const signerIdByRoleId = new Map(
      roles.data.map(
        (role, index) => [role.id, signerIdByOrder.get(index + 1)] as const,
      ),
    );

    await replaceDraftEnvelopeFields(
      userId,
      envelopeId,
      {
        // A template's field ids are its own; the draft gets new ones, so
        // two drafts from one template never share a field id.
        fields: fields.data.map((field) => ({
          ...field,
          id: undefined,
          signerId: signerIdByRoleId.get(field.signerId),
        })),
      },
      database,
    );
  } catch (error) {
    // Half a draft is worse than none: the sender would find a document
    // with no fields on it and no sign of why.
    await deleteDraftEnvelope(userId, envelopeId, {
      database,
      storageService,
    }).catch(() => undefined);

    throw error;
  }

  return {
    envelopeId,
    // Everything is already in place, so the sender lands where they can
    // check it and send. The earlier steps are one click back.
    redirectPath: `/envelopes/${envelopeId}/review`,
  };
}

export async function deleteTemplate(
  userId: string,
  templateId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<void> {
  const template = await queryOne<{ sourcePdfKey: string }>(
    database,
    `
      SELECT source_pdf_key AS "sourcePdfKey"
      FROM templates
      WHERE id = $1 AND user_id = $2
    `,
    [templateId, userId],
  );

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  // The document goes first and the template only once it is gone. If
  // storage fails, the template is still listed, and deleting it again
  // tries again. The other way round, a failure would leave a document that
  // nothing points to, which nothing would ever remove. Envelopes made from
  // the template have their own copies of the document.
  try {
    await storageService.deleteObject(template.sourcePdfKey);
  } catch (error) {
    console.error(
      `Failed to delete the document of template ${templateId}:`,
      error,
    );

    throw new TemplateError(
      "The template's document could not be deleted, so the template was kept. Try again in a moment.",
      503,
    );
  }

  await database.query(`DELETE FROM templates WHERE id = $1 AND user_id = $2`, [
    templateId,
    userId,
  ]);
}

// ---------------------------------------------------------------------------
// The template editor: making a template from a document, naming its roles
// and placing its fields, without an envelope.
// ---------------------------------------------------------------------------

/** The assignee shown in the field editor for prefill boxes. */
export const PREFILL_ASSIGNEE_NAME = "Prefilled before sending";

export type TemplateRolesData = {
  id: string;
  name: string;
  roles: TemplateRole[];
};

/**
 * Makes a template from an uploaded PDF, with one role and no fields yet.
 * The document is checked as an envelope's upload is.
 */
export async function createTemplateFromUpload(
  userId: string,
  input: {
    name: unknown;
    sourcePdf: { body: Uint8Array; contentType: string; filename: string };
  },
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<SavedTemplate> {
  const { name } = createTemplateSchema.parse({ name: input.name });
  const imported = await importPdfDocument(input.sourcePdf);

  await assertRoomForTemplate(userId, database);

  const templateId = randomUUID();
  const sourcePdfKey = buildTemplatePdfKey({ templateId, userId });
  const roles = templateRolesSchema.parse([
    { id: randomUUID(), kind: "signer", name: "Signer 1", step: 1 },
  ]);
  const now = Math.floor(Date.now() / 1000);

  await storageService.putObject({
    body: input.sourcePdf.body,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  try {
    await withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 13))", [
        userId,
      ]);
      await assertRoomForTemplate(userId, tx);
      await tx.query(
        `
          INSERT INTO templates (
            id, user_id, name, source_pdf_key, source_pdf_filename,
            source_pdf_size_bytes, page_count, roles, fields, pages,
            prefill_fields, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9::jsonb,
            '[]'::jsonb, $10, $10
          )
        `,
        [
          templateId,
          userId,
          name,
          sourcePdfKey,
          imported.filename,
          imported.sizeBytes,
          imported.pageCount,
          JSON.stringify(roles),
          JSON.stringify(toStoredPages(imported.pages)),
          now,
        ],
      );
    }, database);
  } catch (error) {
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }

  return { id: templateId, name };
}

async function requireTemplateRow(
  userId: string,
  templateId: string,
  database: DbExecutor,
): Promise<TemplateRow> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    throw new TemplateError("Template not found.", 404);
  }

  return row;
}

function readRoles(row: TemplateRow): TemplateRole[] {
  const roles = templateRolesSchema.safeParse(row.roles);

  if (!roles.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  return roles.data;
}

/** The page sizes of a template, read from its document when they were never stored. */
async function ensureTemplatePages(
  userId: string,
  row: TemplateRow,
  database: DbExecutor,
  storageService: StorageService,
): Promise<StoredPageSize[]> {
  const stored = readPages(row.pages);

  if (stored) {
    return stored;
  }

  let body: Uint8Array;

  try {
    body = (await storageService.getObject(row.sourcePdfKey)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }

  const pages = toStoredPages(
    (
      await importPdfDocument({
        body,
        contentType: "application/pdf",
        filename: row.sourcePdfFilename,
      })
    ).pages,
  );

  await database.query(
    `UPDATE templates SET pages = $3::jsonb WHERE id = $1 AND user_id = $2`,
    [row.id, userId, JSON.stringify(pages)],
  );

  return pages;
}

/** What the role step of the template editor shows. */
export async function getTemplateRolesData(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
): Promise<TemplateRolesData | null> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    return null;
  }

  return { id: row.id, name: row.name, roles: readRoles(row) };
}

/**
 * The template in the shape the field editor reads an envelope in: its
 * roles as signers, with one more assignee for the prefill boxes.
 */
export async function getTemplateEditorData(
  userId: string,
  templateId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<PrepareEnvelopeData | null> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    return null;
  }

  const roles = readRoles(row);
  const fields = fieldPlacementListSchema.safeParse(row.fields);

  if (!fields.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  const prefillFields = readPrefillFields(row.prefillFields);
  const pages = await ensureTemplatePages(
    userId,
    row,
    database,
    storageService,
  );
  const now = Math.floor(Date.now() / 1000);
  const toRecord = (field: FieldPlacement): FieldRecord => ({
    ...field,
    // Templates saved from an envelope kept no field ids; the editor gives
    // them ids on its first save.
    createdAt: now,
    id: field.id ?? randomUUID(),
    updatedAt: now,
  });

  return {
    envelopeId: row.id,
    fields: [...fields.data, ...prefillFields].map(toRecord),
    fieldsRevision: row.fieldsRevision,
    pageCount: pages.length,
    pages: pages.map((page) => ({ ...page })),
    pdfUrl: `/api/templates/${encodeURIComponent(row.id)}/document`,
    signers: [
      ...roles.map((role, index) => ({
        email: "",
        id: role.id,
        name: role.name,
        order: index + 1,
        role: role.kind ?? ("signer" as const),
        step: role.step ?? index + 1,
      })),
      {
        email: "",
        id: PREFILL_ASSIGNEE_ID,
        name: PREFILL_ASSIGNEE_NAME,
        order: roles.length + 1,
        role: "signer" as const,
        step: roles.length + 1,
      },
    ],
    status: "draft",
    title: row.name,
  };
}

/**
 * Saves the roles of a template, in signing order. A role that is gone
 * takes its fields with it; an approver keeps none.
 */
export async function replaceTemplateRoles(
  userId: string,
  templateId: string,
  input: unknown,
  { database = getDb() }: Pick<TemplateOptions, "database"> = {},
): Promise<TemplateRolesData> {
  const { roles } = replaceTemplateRolesSchema.parse(input);
  const steps = normalizeSigningSteps(
    roles.map((role, index) => role.step ?? index + 1),
  );
  const normalizedRoles = roles.map((role, index) => ({
    ...role,
    kind: role.kind ?? ("signer" as const),
    step: steps[index],
  }));

  if (!normalizedRoles.some((role) => role.kind !== "approver")) {
    throw new TemplateError(
      "Add at least one signer. Approvers approve or reject, so someone else has to sign.",
      400,
    );
  }

  return withTransaction(async (tx) => {
    const row = await queryOne<TemplateRow>(
      tx,
      `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [templateId, userId],
    );

    if (!row) {
      throw new TemplateError("Template not found.", 404);
    }

    const signerRoleIds = new Set(
      normalizedRoles
        .filter((role) => role.kind !== "approver")
        .map((role) => role.id),
    );
    const fields: unknown[] = Array.isArray(row.fields) ? row.fields : [];
    const keptFields = fields.filter(
      (field) =>
        typeof field === "object" &&
        field !== null &&
        "signerId" in field &&
        typeof field.signerId === "string" &&
        signerRoleIds.has(field.signerId),
    );

    await tx.query(
      `
        UPDATE templates
        SET roles = $3::jsonb,
            fields = $4::jsonb,
            fields_revision = fields_revision + $5,
            updated_at = $6
        WHERE id = $1 AND user_id = $2
      `,
      [
        templateId,
        userId,
        JSON.stringify(normalizedRoles),
        JSON.stringify(keptFields),
        keptFields.length === fields.length ? 0 : 1,
        Math.floor(Date.now() / 1000),
      ],
    );

    return { id: row.id, name: row.name, roles: normalizedRoles };
  }, database);
}

const FIELDS_CHANGED_ELSEWHERE_MESSAGE =
  "This template's fields were changed in another window. Reload the page to see them.";

/**
 * Saves the fields the editor placed. Boxes given to the prefill assignee
 * are kept as prefill boxes; the rest belong to the template's roles.
 */
export async function replaceTemplateFields(
  userId: string,
  templateId: string,
  input: unknown,
  { database = getDb() }: Pick<TemplateOptions, "database"> = {},
) {
  const parsed = replaceTemplateFieldsSchema.parse(input);

  return withTransaction(async (tx) => {
    const row = await queryOne<TemplateRow>(
      tx,
      `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [templateId, userId],
    );

    if (!row) {
      throw new TemplateError("Template not found.", 404);
    }

    if (
      parsed.expectedRevision !== undefined &&
      parsed.expectedRevision !== row.fieldsRevision
    ) {
      throw new TemplateError(FIELDS_CHANGED_ELSEWHERE_MESSAGE, 409);
    }

    const roles = readRoles(row);
    const roleIds = new Set(
      roles.filter((role) => role.kind !== "approver").map((role) => role.id),
    );
    const pageNumbers = new Set(
      (readPages(row.pages) ?? []).map((page) => page.pageNumber),
    );
    const withIds = parsed.fields.map((field) => ({
      ...field,
      id: field.id ?? randomUUID(),
    }));

    for (const field of withIds) {
      if (
        field.signerId !== PREFILL_ASSIGNEE_ID &&
        !roleIds.has(field.signerId)
      ) {
        throw new TemplateError(
          "A field belongs to a signer this template no longer has. Reload the page.",
          400,
        );
      }

      if (
        (pageNumbers.size > 0 && !pageNumbers.has(field.page)) ||
        field.page > row.pageCount
      ) {
        throw new TemplateError(
          "Each field must be placed on an existing page in this document.",
          400,
        );
      }

      if (
        field.x + field.width > 1.000001 ||
        field.y + field.height > 1.000001
      ) {
        throw new TemplateError("Each field must fit on its page.", 400);
      }
    }

    const signerFields = fieldPlacementListSchema.parse(
      withIds.filter((field) => field.signerId !== PREFILL_ASSIGNEE_ID),
    );
    const prefillFields = prefillFieldListSchema.safeParse(
      withIds.filter((field) => field.signerId === PREFILL_ASSIGNEE_ID),
    );

    if (!prefillFields.success) {
      throw new TemplateError(
        prefillFields.error.issues[0]?.message ??
          "A prefill box could not be saved.",
        400,
      );
    }

    // A default must be a value the box would accept from the sender.
    try {
      assertPrefillDefaults(prefillFields.data);
    } catch (error) {
      if (error instanceof PrefillError) {
        throw new TemplateError(
          `Default value: ${error.message}`,
          400,
          error.fieldId,
        );
      }

      throw error;
    }

    const now = Math.floor(Date.now() / 1000);
    const nextRevision = row.fieldsRevision + 1;

    await tx.query(
      `
        UPDATE templates
        SET fields = $3::jsonb,
            prefill_fields = $4::jsonb,
            fields_revision = $5,
            updated_at = $6
        WHERE id = $1 AND user_id = $2
      `,
      [
        templateId,
        userId,
        JSON.stringify(signerFields),
        JSON.stringify(prefillFields.data),
        nextRevision,
        now,
      ],
    );

    return {
      envelopeId: templateId,
      fields: withIds,
      fieldsRevision: nextRevision,
      redirectPath: "/templates",
      updatedAt: now,
    };
  }, database);
}

export async function renameTemplate(
  userId: string,
  templateId: string,
  input: unknown,
  { database = getDb() }: Pick<TemplateOptions, "database"> = {},
): Promise<SavedTemplate> {
  const { name } = renameTemplateSchema.parse(input);
  const updated = await queryOne<{ id: string }>(
    database,
    `
      UPDATE templates SET name = $3, updated_at = $4
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `,
    [templateId, userId, name, Math.floor(Date.now() / 1000)],
  );

  if (!updated) {
    throw new TemplateError("Template not found.", 404);
  }

  return { id: templateId, name };
}

/** The template's document, for its owner's field editor. */
export async function getTemplateDocumentForUser(
  userId: string,
  templateId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<{ body: Uint8Array; fileName: string }> {
  const row = await requireTemplateRow(userId, templateId, database);

  try {
    return {
      body: (await storageService.getObject(row.sourcePdfKey)).body,
      fileName: row.sourcePdfFilename,
    };
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }
}
