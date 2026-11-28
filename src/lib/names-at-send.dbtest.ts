import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  correctSentEnvelopeSigner,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { getSigningPayloadForToken, recordSignerConsent } from "./signing.ts";

// Every signer's name goes into their name fields when the envelope is
// sent, so the first person to sign sees who else signs, and correcting a
// name updates them. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-names-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(workDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: workDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(workDir, { force: true, recursive: true });
});

/** A sent envelope with two signers, one after the other, each with a name field. */
async function sendTwoSignerEnvelope() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);

  const bytes = await pdf.save();
  const key = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: bytes,
    contentType: "application/pdf",
    key,
  });
  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Contract', 'draft', $3, 'contract.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      key,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: `cara-${randomUUID()}@example.test`, name: "Cara Client" },
        { email: `finn-${randomUUID()}@example.test`, name: "Finn Firm" },
      ],
    },
    database,
  );
  const [first, second] = saved.signers as [
    (typeof saved.signers)[number],
    (typeof saved.signers)[number],
  ];
  const place = (signerId: string, type: "name" | "signature", y: number) => ({
    height: 0.05,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.3,
    x: 0.1,
    y,
  });

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        place(first.id, "name", 0.1),
        place(first.id, "signature", 0.2),
        place(second.id, "name", 0.4),
        place(second.id, "signature", 0.5),
      ],
    },
    database,
  );
  await sendDraftEnvelope(
    userId,
    envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  return { envelopeId, first, second, userId };
}

async function nameFields(envelopeId: string) {
  const result = await database.query<{
    input_method: string | null;
    signer_id: string;
    submitted_at: number | null;
    value: string | null;
  }>(
    `
      select signer_id, value, input_method, submitted_at
      from fields
      where envelope_id = $1 and type = 'name'
    `,
    [envelopeId],
  );

  return result.rows;
}

/** Opens the first signer's link, as the invitation would. */
async function openLink(signerId: string) {
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });

  await database.query(
    `update signers set signing_token_hash = $1, signing_token_expires_at = $2 where id = $3`,
    [link.tokenHash, link.exp, signerId],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  return link.token;
}

test("sending fills every signer's name fields", async () => {
  const { envelopeId, first, second } = await sendTwoSignerEnvelope();
  const fields = await nameFields(envelopeId);
  const bySigner = new Map(fields.map((field) => [field.signer_id, field]));

  assert.equal(bySigner.get(first.id)?.value, "Cara Client");
  assert.equal(bySigner.get(second.id)?.value, "Finn Firm");

  for (const field of fields) {
    assert.equal(field.input_method, "auto");
    assert.equal(typeof field.submitted_at, "number");
  }
});

test("the first signer sees the later signer's name", async () => {
  const { first, second } = await sendTwoSignerEnvelope();
  const token = await openLink(first.id);
  const payload = await getSigningPayloadForToken(token, { database });
  const shown = payload.visibleFields.filter(
    (field) => field.signerId === second.id,
  );

  // Only the name: the later signer's signature is not theirs to see.
  assert.deepEqual(
    shown.map((field) => [field.type, field.value]),
    [["name", "Finn Firm"]],
  );
});

test("correcting a signer's name updates their name fields", async () => {
  const { envelopeId, second, userId } = await sendTwoSignerEnvelope();

  await correctSentEnvelopeSigner(
    userId,
    envelopeId,
    second.id,
    { email: second.email, name: "Finley Firm" },
    {
      ipAddress: "203.0.113.8",
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
      userAgent: "test",
    },
    { database },
  );

  const field = (await nameFields(envelopeId)).find(
    (entry) => entry.signer_id === second.id,
  );

  assert.equal(field?.value, "Finley Firm");
});
