import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";
import { ZodError } from "zod";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import {
  createDraftEnvelope,
  EnvelopeMutationError,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
  getReviewEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";
import { runRetentionSweep } from "./retention.ts";
import { buildTemplatePdfKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { PREFILL_ASSIGNEE_ID } from "./schemas/template.ts";
import {
  createDraftFromTemplate,
  createTemplateFromUpload,
  deleteTemplate,
  describeBulkSendPrefillProblem,
  getTemplateEditorData,
  getTemplateForBulkSend,
  getUseTemplateDataForUser,
  listTemplatesForUser,
  MAX_TEMPLATES_PER_USER,
  replaceTemplateFields,
  replaceTemplateRoles,
  saveEnvelopeAsTemplate,
  TemplateError,
} from "./templates.ts";

// Templates against a real Postgres and real files: what a template keeps
// of an envelope, what a draft made from it gets, and that neither leaves
// files behind. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let sourcePdf: Uint8Array;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-templates-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(): Promise<string> {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

function field(
  signerId: string,
  type: string,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.2,
    x: 0.1,
    y,
    ...extra,
  };
}

/** A two-page draft with two signers and one field of each awkward kind. */
async function createPreparedDraft(userId: string) {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "lease.pdf" },
      title: "Lease for 12 Harbour Road",
    },
    { database, storageService },
  );
  const envelopeId = draft.envelope.id;
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: "riley@example.test", name: "Riley Recipient" },
        { email: "casey@example.test", name: "Casey Second" },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);
  const groupId = randomUUID();

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        field(riley!, "signature", 0.1),
        field(casey!, "signature", 0.15, { page: 2 }),
        field(riley!, "text", 0.2, { label: "Unit number", required: false }),
        field(riley!, "dropdown", 0.25, { options: ["Monthly", "Yearly"] }),
        field(casey!, "radio", 0.3, { groupId, label: "Furnished" }),
        field(casey!, "radio", 0.35, { groupId, label: "Unfurnished" }),
      ],
    },
    database,
  );

  return { envelopeId };
}

async function fileExists(key: string): Promise<boolean> {
  return (await storageService.headObject(key)).exists;
}

async function countEnvelopes(userId: string): Promise<number> {
  const result = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1`,
    [userId],
  );

  return result.rows[0]!.total;
}

function assertTemplateError(statusCode: number) {
  return (error: unknown): true => {
    assert.ok(error instanceof TemplateError, String(error));
    assert.equal(error.statusCode, statusCode);

    return true;
  };
}

test("a template keeps the document, the fields and the order, and no one's name", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const template = await saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "  Residential lease ", roleNames: ["Tenant", "Landlord"] },
    { database, storageService },
  );

  assert.equal(template.name, "Residential lease");
  assert.equal(
    await fileExists(buildTemplatePdfKey({ templateId: template.id, userId })),
    true,
  );

  const stored = await database.query<{ everything: string }>(
    `select row_to_json(t)::text as everything from templates t where id = $1`,
    [template.id],
  );

  for (const personal of ["Riley", "Casey", "riley@", "casey@"]) {
    assert.ok(!stored.rows[0]!.everything.includes(personal), personal);
  }

  assert.deepEqual(await listTemplatesForUser(userId, database), [
    {
      createdAtLabel: (await listTemplatesForUser(userId, database))[0]!
        .createdAtLabel,
      // The two radio buttons are one question.
      fieldCountLabel: "5 fields",
      id: template.id,
      name: "Residential lease",
      pageCountLabel: "2 pages",
      roleNames: ["Tenant", "Landlord"],
    },
  ]);

  const form = await getUseTemplateDataForUser(userId, template.id, database);

  assert.deepEqual(
    form?.roles.map((role) => role.name),
    ["Tenant", "Landlord"],
  );
});

test("a meaning given for a signer is kept on the draft made from a template", async () => {
  // Part 11 installs need one for each signer before sending, and the API
  // gives them here so it can send the draft at once.
  const userId = await createUser();
  const { envelopeId: originalId } = await createPreparedDraft(userId);
  const template = await saveEnvelopeAsTemplate(
    userId,
    originalId,
    { name: "Lease" },
    { database, storageService },
  );
  const made = await createDraftFromTemplate(
    userId,
    template.id,
    {
      signers: [
        {
          email: "tess@example.test",
          name: "Tess Tenant",
          signatureMeaning: "approval",
        },
        { email: "lou@example.test", name: "Lou Landlord" },
      ],
      title: "Lease for 4 Mill Lane",
    },
    { database, storageService },
  );
  const saved = await database.query<{ signature_meaning: string | null }>(
    `select signature_meaning from signers where envelope_id = $1 order by sign_order`,
    [made.envelopeId],
  );

  assert.deepEqual(
    saved.rows.map((row) => row.signature_meaning),
    ["approval", null],
  );
});

test("a draft made from a template has the fields on the people named for it", async () => {
  const userId = await createUser();
  const { envelopeId: originalId } = await createPreparedDraft(userId);
  const template = await saveEnvelopeAsTemplate(
    userId,
    originalId,
    { name: "Lease" },
    { database, storageService },
  );
  const made = await createDraftFromTemplate(
    userId,
    template.id,
    {
      signers: [
        { email: "tess@example.test", name: "Tess Tenant" },
        { email: "lou@example.test", name: "Lou Landlord" },
      ],
      title: "Lease for 4 Mill Lane",
    },
    { database, storageService },
  );

  assert.notEqual(made.envelopeId, originalId);
  assert.equal(made.redirectPath, `/envelopes/${made.envelopeId}/review`);

  const draft = await getPrepareEnvelopeDataForUser(userId, made.envelopeId, {
    database,
  });

  assert.ok(draft);
  assert.equal(draft.status, "draft");
  assert.equal(draft.title, "Lease for 4 Mill Lane");
  assert.equal(draft.pageCount, 2);
  assert.deepEqual(
    draft.signers.map((signer) => [signer.order, signer.name, signer.email]),
    [
      [1, "Tess Tenant", "tess@example.test"],
      [2, "Lou Landlord", "lou@example.test"],
    ],
  );

  const [tess, lou] = draft.signers.map((signer) => signer.id);
  const summary = draft.fields
    .map((placed) => ({
      label: placed.label,
      options: placed.options,
      page: placed.page,
      required: placed.required,
      signer: placed.signerId === tess ? "tess" : "lou",
      type: placed.type,
    }))
    .sort((left, right) =>
      `${left.type}${left.label ?? ""}`.localeCompare(
        `${right.type}${right.label ?? ""}`,
      ),
    );

  assert.deepEqual(summary, [
    {
      label: undefined,
      options: ["Monthly", "Yearly"],
      page: 1,
      required: true,
      signer: "tess",
      type: "dropdown",
    },
    {
      label: "Furnished",
      options: undefined,
      page: 1,
      required: true,
      signer: "lou",
      type: "radio",
    },
    {
      label: "Unfurnished",
      options: undefined,
      page: 1,
      required: true,
      signer: "lou",
      type: "radio",
    },
    {
      label: undefined,
      options: undefined,
      page: 1,
      required: true,
      signer: "tess",
      type: "signature",
    },
    {
      label: undefined,
      options: undefined,
      page: 2,
      required: true,
      signer: "lou",
      type: "signature",
    },
    {
      label: "Unit number",
      options: undefined,
      page: 1,
      required: false,
      signer: "tess",
      type: "text",
    },
  ]);
  assert.ok(lou);

  const radios = draft.fields.filter((placed) => placed.type === "radio");

  assert.equal(radios[0]!.groupId, radios[1]!.groupId);
  // Nothing anyone entered came along, and it is ready to send.
  assert.ok(draft.fields.every((placed) => !placed.value));
  assert.equal(
    (await getReviewEnvelopeDataForUser(userId, made.envelopeId, database))
      ?.canSend,
    true,
  );

  // The draft has its own copy of the document: deleting the template
  // takes the template's copy and nothing else.
  await deleteTemplate(userId, template.id, { database, storageService });

  assert.equal(
    await fileExists(buildTemplatePdfKey({ templateId: template.id, userId })),
    false,
  );
  assert.deepEqual(await listTemplatesForUser(userId, database), []);

  for (const envelopeId of [made.envelopeId, originalId]) {
    const document = await getDraftEnvelopeDocumentForUser(userId, envelopeId, {
      database,
      storageService,
    });

    assert.equal(document.body.length, sourcePdf.length);
  }
});

test("a template belongs to the person who saved it", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const { envelopeId } = await createPreparedDraft(owner);
  const options = { database, storageService };
  const people = {
    signers: [
      { email: "a@example.test", name: "A" },
      { email: "b@example.test", name: "B" },
    ],
    title: "Lease",
  };

  await assert.rejects(
    saveEnvelopeAsTemplate(stranger, envelopeId, { name: "Mine now" }, options),
    assertTemplateError(404),
  );

  const template = await saveEnvelopeAsTemplate(
    owner,
    envelopeId,
    { name: "Lease" },
    options,
  );

  assert.deepEqual(await listTemplatesForUser(stranger, database), []);
  assert.equal(
    await getUseTemplateDataForUser(stranger, template.id, database),
    null,
  );
  await assert.rejects(
    createDraftFromTemplate(stranger, template.id, people, options),
    assertTemplateError(404),
  );
  await assert.rejects(
    deleteTemplate(stranger, template.id, options),
    assertTemplateError(404),
  );
  assert.equal(await countEnvelopes(stranger), 0);
  assert.equal((await listTemplatesForUser(owner, database)).length, 1);
});

test("what a template is given is checked", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const options = { database, storageService };
  const save = (input: unknown) =>
    saveEnvelopeAsTemplate(userId, envelopeId, input, options);

  await assert.rejects(save({ name: "   " }), ZodError);
  await assert.rejects(
    save({ name: "Lease", roleNames: ["Tenant", "tenant"] }),
    ZodError,
  );
  // One name for two signers: the envelope is not what the form showed.
  await assert.rejects(
    save({ name: "Lease", roleNames: ["Tenant"] }),
    assertTemplateError(409),
  );
  assert.deepEqual(await listTemplatesForUser(userId, database), []);

  // An envelope nobody signs has no order to keep.
  const bare = await createDraftEnvelope(
    userId,
    { sourcePdf: { body: sourcePdf, filename: "bare.pdf" }, title: "Bare" },
    options,
  );

  await assert.rejects(
    saveEnvelopeAsTemplate(userId, bare.envelope.id, { name: "Bare" }, options),
    assertTemplateError(400),
  );

  const template = await save({ name: "Lease" });
  const use = (input: unknown) =>
    createDraftFromTemplate(userId, template.id, input, options);
  const before = await countEnvelopes(userId);

  await assert.rejects(
    use({ signers: [{ email: "a@example.test", name: "A" }], title: "Lease" }),
    assertTemplateError(400),
  );
  await assert.rejects(
    use({
      signers: [
        { email: "a@example.test", name: "A" },
        { email: "A@example.test", name: "B" },
      ],
      title: "Lease",
    }),
    ZodError,
  );
  await assert.rejects(
    use({
      signers: [
        { email: "a@example.test", name: "A" },
        { email: "b@example.test", name: "B" },
      ],
      title: "",
    }),
    ZodError,
  );
  assert.equal(await countEnvelopes(userId), before);
});

test("a draft that cannot be finished is not left half made", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const options = { database, storageService };
  const template = await saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "Lease" },
    options,
  );
  const people = {
    signers: [
      { email: "a@example.test", name: "A" },
      { email: "b@example.test", name: "B" },
    ],
    title: "Lease",
  };
  const before = await countEnvelopes(userId);

  // A field on a page the document does not have: well formed, so it is
  // only found out once the draft exists.
  await database.query(
    `
      update templates
      set fields = jsonb_set(fields, '{0,page}', '9')
      where id = $1
    `,
    [template.id],
  );
  await assert.rejects(
    createDraftFromTemplate(userId, template.id, people, options),
    EnvelopeMutationError,
  );
  assert.equal(await countEnvelopes(userId), before);

  // Contents the application would never have written.
  await database.query(
    `update templates set fields = '[{"type":"stamp"}]'::jsonb where id = $1`,
    [template.id],
  );
  await assert.rejects(
    createDraftFromTemplate(userId, template.id, people, options),
    assertTemplateError(409),
  );
  // The list still opens, so the template can be deleted.
  assert.equal((await listTemplatesForUser(userId, database)).length, 1);

  // The document itself has gone missing.
  const second = await saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "Lease again" },
    options,
  );

  await storageService.deleteObject(
    buildTemplatePdfKey({ templateId: second.id, userId }),
  );
  await assert.rejects(
    createDraftFromTemplate(userId, second.id, people, options),
    assertTemplateError(409),
  );
  assert.equal(await countEnvelopes(userId), before);
});

test("the database refuses a template without signers", async () => {
  const userId = await createUser();
  const insert = (roles: string) =>
    database.query(
      `
        insert into templates (
          id, user_id, name, source_pdf_key, source_pdf_filename,
          source_pdf_size_bytes, page_count, roles, fields
        ) values ($1, $2, 'T', 'k', 'f.pdf', 1, 1, $3::jsonb, '[]'::jsonb)
      `,
      [randomUUID(), userId, roles],
    );

  await assert.rejects(insert("[]"), /templates_roles_check/);
  await assert.rejects(insert('{"name":"x"}'), /templates_roles_check/);
  await insert('[{"id":"r1","name":"Client"}]');
});

test("a template whose document cannot be deleted is kept, to be deleted again", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const template = await saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "Lease" },
    { database, storageService },
  );
  const key = buildTemplatePdfKey({ templateId: template.id, userId });
  const storageDown: StorageService = {
    ...storageService,
    async deleteObject() {
      throw new Error("storage is down");
    },
  };

  await assert.rejects(
    deleteTemplate(userId, template.id, {
      database,
      storageService: storageDown,
    }),
    assertTemplateError(503),
  );

  // Still listed, so the document is still known and can be asked for again.
  assert.equal(await fileExists(key), true);
  assert.deepEqual(
    (await listTemplatesForUser(userId, database)).map((entry) => entry.id),
    [template.id],
  );

  await deleteTemplate(userId, template.id, { database, storageService });

  assert.equal(await fileExists(key), false);
  assert.deepEqual(await listTemplatesForUser(userId, database), []);
});

test("saves at the same moment cannot pass the most an account may keep", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);

  // One short of full.
  await database.query(
    `
      insert into templates (
        id, user_id, name, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, roles, fields, created_at,
        updated_at
      )
      select
        gen_random_uuid(), $1, 'Filler ' || n, 'test/filler-' || n || '.pdf',
        'filler.pdf', 10, 1, '[{"id":"r1","name":"Client"}]'::jsonb,
        '[]'::jsonb, 1, 1
      from generate_series(1, $2::int) as n
    `,
    [userId, MAX_TEMPLATES_PER_USER - 1],
  );

  const saves = await Promise.allSettled(
    ["First", "Second"].map((name) =>
      saveEnvelopeAsTemplate(
        userId,
        envelopeId,
        { name },
        { database, storageService },
      ),
    ),
  );
  const stored = saves.flatMap((save) =>
    save.status === "fulfilled" ? [save.value] : [],
  );
  const refused = saves.flatMap((save) =>
    save.status === "rejected" ? [save.reason as unknown] : [],
  );

  assert.equal(stored.length, 1);
  assert.equal(refused.length, 1);
  assertTemplateError(409)(refused[0]);
  assert.equal(
    (
      await database.query<{ total: number }>(
        `select count(*)::int as total from templates where user_id = $1`,
        [userId],
      )
    ).rows[0]?.total,
    MAX_TEMPLATES_PER_USER,
  );

  // The save that was refused took its copy of the document back.
  const keptDocuments = (
    await readdir(path.join(storageDir, "users", userId, "templates"), {
      recursive: true,
    })
  ).filter((entry) => entry.endsWith("original.pdf"));

  assert.deepEqual(keptDocuments, [path.join(stored[0]!.id, "original.pdf")]);
});

test("closing the account removes its templates and their documents", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const template = await saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "Lease" },
    { database, storageService },
  );
  const key = buildTemplatePdfKey({ templateId: template.id, userId });

  assert.equal(await fileExists(key), true);

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [userId],
  );

  const summary = await runRetentionSweep({ database, storageService });

  assert.ok(!summary.accountPurgeFailures.includes(userId));
  assert.equal(await fileExists(key), false);
  assert.equal(
    (
      await database.query(`select 1 from templates where user_id = $1`, [
        userId,
      ])
    ).rowCount,
    0,
  );
});

test("a template saved while its account is being deleted leaves no document behind", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [userId],
  );

  // The save starts when the deletion has just read which templates the
  // account has, and the deletion then waits: for the save to finish, or
  // long enough to show that the save is the one waiting.
  let save: Promise<unknown> | undefined;
  const summary = await runRetentionSweep({
    database: afterStatement(
      database,
      (text, values) =>
        text.includes("FROM templates WHERE user_id") && values[0] === userId,
      async () => {
        save = saveEnvelopeAsTemplate(
          userId,
          envelopeId,
          { name: "Lease" },
          { database, storageService },
        );
        await Promise.race([
          save.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      },
    ),
    storageService,
  });

  assert.ok(!summary.accountPurgeFailures.includes(userId));
  assert.ok(save, "the deletion read the account's templates");

  const refusal: unknown = await save.then(
    () => null,
    (error: unknown) => error,
  );
  const keptDocuments = (
    await readdir(path.join(storageDir, "users", userId, "templates"), {
      recursive: true,
    }).catch(() => [])
  ).filter((entry) => entry.endsWith("original.pdf"));

  assert.deepEqual(keptDocuments, []);
  // The deletion went first, so the save found no account to keep a
  // template for, and took its copy of the document back.
  assert.match(String(refusal), /foreign key/);
  assert.equal(
    (await database.query(`select 1 from "user" where id = $1`, [userId]))
      .rowCount,
    0,
  );
});

// --- The template editor and prefill boxes -------------------------------

async function createEditedTemplate(userId: string) {
  const created = await createTemplateFromUpload(
    userId,
    {
      name: "Consulting agreement",
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: "consulting.pdf",
      },
    },
    { database, storageService },
  );
  const clientId = randomUUID();
  const firmId = randomUUID();

  await replaceTemplateRoles(
    userId,
    created.id,
    {
      roles: [
        { id: clientId, kind: "signer", name: "Client", step: 1 },
        { id: firmId, kind: "signer", name: "Firm", step: 2 },
      ],
    },
    { database },
  );

  const editor = await getTemplateEditorData(userId, created.id, {
    database,
    storageService,
  });

  assert.ok(editor);

  const saved = await replaceTemplateFields(
    userId,
    created.id,
    {
      expectedRevision: editor.fieldsRevision,
      fields: [
        {
          height: 0.06,
          id: randomUUID(),
          page: 1,
          required: true,
          signerId: clientId,
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
        {
          height: 0.06,
          id: randomUUID(),
          page: 2,
          required: true,
          signerId: firmId,
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
        {
          height: 0.05,
          id: "fee-box",
          label: "Monthly fee",
          page: 1,
          required: true,
          signerId: PREFILL_ASSIGNEE_ID,
          type: "number",
          width: 0.3,
          x: 0.1,
          y: 0.2,
        },
        {
          height: 0.05,
          id: "note-box",
          label: "Notes",
          page: 1,
          required: false,
          signerId: PREFILL_ASSIGNEE_ID,
          type: "text",
          width: 0.5,
          x: 0.1,
          y: 0.3,
        },
      ],
    },
    { database },
  );

  return { clientId, firmId, saved, templateId: created.id };
}

test("a template is made from an upload, without an envelope", async () => {
  const userId = await createUser();
  const { saved, templateId } = await createEditedTemplate(userId);

  assert.equal(saved.fieldsRevision, 1);

  const editor = await getTemplateEditorData(userId, templateId, {
    database,
    storageService,
  });

  assert.ok(editor);
  assert.equal(editor.title, "Consulting agreement");
  assert.equal(editor.pageCount, 2);
  assert.equal(editor.pdfUrl, `/api/templates/${templateId}/document`);
  // The roles, then the assignee for prefill boxes.
  assert.deepEqual(
    editor.signers.map((signer) => signer.name),
    ["Client", "Firm", "Prefilled before sending"],
  );
  assert.equal(editor.fields.length, 4);

  const usable = await getUseTemplateDataForUser(userId, templateId, database);

  assert.ok(usable);
  assert.deepEqual(
    usable.prefillFields.map((field) => [field.id, field.type, field.required]),
    [
      ["fee-box", "number", true],
      ["note-box", "text", false],
    ],
  );

  const listed = await listTemplatesForUser(userId, database);

  assert.equal(
    listed.find((entry) => entry.id === templateId)?.name,
    "Consulting agreement",
  );
});

test("a save made against an older field list is refused", async () => {
  const userId = await createUser();
  const { templateId } = await createEditedTemplate(userId);

  await assert.rejects(
    replaceTemplateFields(
      userId,
      templateId,
      { expectedRevision: 0, fields: [] },
      { database },
    ),
    (error: unknown) =>
      error instanceof TemplateError && error.statusCode === 409,
  );
});

test("signatures cannot be prefill boxes", async () => {
  const userId = await createUser();
  const { templateId } = await createEditedTemplate(userId);

  await assert.rejects(
    replaceTemplateFields(
      userId,
      templateId,
      {
        fields: [
          {
            height: 0.05,
            id: randomUUID(),
            page: 1,
            required: true,
            signerId: PREFILL_ASSIGNEE_ID,
            type: "signature",
            width: 0.3,
            x: 0.1,
            y: 0.1,
          },
        ],
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof TemplateError && error.statusCode === 400,
  );
});

test("removing a role removes its fields", async () => {
  const userId = await createUser();
  const { clientId, templateId } = await createEditedTemplate(userId);

  await replaceTemplateRoles(
    userId,
    templateId,
    { roles: [{ id: clientId, kind: "signer", name: "Client", step: 1 }] },
    { database },
  );

  const editor = await getTemplateEditorData(userId, templateId, {
    database,
    storageService,
  });

  assert.ok(editor);
  assert.deepEqual(
    editor.fields
      .filter((field) => field.signerId !== PREFILL_ASSIGNEE_ID)
      .map((field) => field.signerId),
    [clientId],
  );
});

test("using a template writes the prefill values into the draft's document", async () => {
  const userId = await createUser();
  const { templateId } = await createEditedTemplate(userId);
  const people = {
    signers: [
      { email: "cara@example.test", name: "Cara Client" },
      { email: "finn@example.test", name: "Finn Firm" },
    ],
    title: "Consulting for Acme",
  };

  // A required prefill box left empty names the box.
  await assert.rejects(
    createDraftFromTemplate(userId, templateId, people, {
      database,
      storageService,
    }),
    (error: unknown) =>
      error instanceof TemplateError &&
      error.statusCode === 400 &&
      error.fieldId === "fee-box",
  );

  const made = await createDraftFromTemplate(
    userId,
    templateId,
    { ...people, prefill: { "fee-box": "2,500" } },
    { database, storageService },
  );
  const document = await getDraftEnvelopeDocumentForUser(
    userId,
    made.envelopeId,
    { database, storageService },
  );

  assert.notDeepEqual(new Uint8Array(document.body), sourcePdf);

  const draft = await getPrepareEnvelopeDataForUser(userId, made.envelopeId, {
    database,
  });

  assert.ok(draft);
  // Only the signers' fields are on the envelope; the prefilled values are
  // part of its document.
  assert.deepEqual(draft.fields.map((field) => field.type).sort(), [
    "signature",
    "signature",
  ]);

  // Two drafts from one template never share field ids.
  const second = await createDraftFromTemplate(
    userId,
    templateId,
    { ...people, prefill: { "fee-box": "3000" } },
    { database, storageService },
  );
  const secondDraft = await getPrepareEnvelopeDataForUser(
    userId,
    second.envelopeId,
    { database },
  );

  assert.ok(secondDraft);
  assert.equal(
    secondDraft.fields.some((field) =>
      draft.fields.some((other) => other.id === field.id),
    ),
    false,
  );
});

test("a template with a required prefill box cannot be sent to many", async () => {
  const userId = await createUser();
  const { templateId } = await createEditedTemplate(userId);
  const template = await getTemplateForBulkSend(userId, templateId, database, {
    checkDropdownReadability: false,
  });

  assert.ok(template);
  assert.match(
    describeBulkSendPrefillProblem(template.prefillFields) ?? "",
    /one envelope at a time/,
  );
});
