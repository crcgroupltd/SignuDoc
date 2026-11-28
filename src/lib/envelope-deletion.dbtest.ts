import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { deleteFinishedEnvelope } from "./envelope-deletion.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";

// An administrator deleting a finished envelope, which happens at once,
// against a real Postgres. Run with `npm run test:db`.

const SOURCE_HASH = "a".repeat(64);
const SIGNED_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);
const RECIPIENT_EVIDENCE_HASH = "d".repeat(64);

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-deletion-"));
  Object.assign(process.env, {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(role: "admin" | "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Avery Admin', $2, $3)`,
    [id, email, role],
  );

  return { email, userId: id };
}

/** An envelope with its files stored, in the given state. */
async function createEnvelope(
  userId: string,
  {
    part11 = false,
    status,
  }: {
    part11?: boolean;
    status: "completed" | "declined" | "draft" | "sent" | "voided";
  },
) {
  const envelopeId = randomUUID();
  const base = `users/${userId}/envelopes/${envelopeId}`;
  const keys = {
    evidence: `${base}/evidence/internal.pdf`,
    signed: `${base}/signed.pdf`,
    source: `${base}/source.pdf`,
  };
  const finished = status !== "draft" && status !== "sent";
  const stored = [keys.source];

  if (finished) {
    stored.push(
      keys.evidence,
      getRecipientCertificateKey(keys.evidence),
      ...(status === "completed" ? [keys.signed] : []),
    );
  }

  for (const key of stored) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }

  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, declined_at, voided_at, signed_pdf_key, evidence_key,
        signed_pdf_sha256, evidence_sha256, part11, recipient_evidence_sha256
      ) values (
        $1, $2, 'Lease', $3, $4, 'lease.pdf', 4, 1, $14, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $15
      )
    `,
    [
      envelopeId,
      userId,
      status,
      keys.source,
      status === "draft" ? null : now - 100,
      status === "completed" ? now : null,
      status === "declined" ? now : null,
      status === "voided" ? now : null,
      status === "completed" ? keys.signed : null,
      finished ? keys.evidence : null,
      status === "completed" ? SIGNED_HASH : null,
      finished ? EVIDENCE_HASH : null,
      part11,
      SOURCE_HASH,
      finished ? RECIPIENT_EVIDENCE_HASH : null,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Riley Recipient', 'riley@example.test', 1, $3)
    `,
    [randomUUID(), envelopeId, status === "completed" ? "signed" : "pending"],
  );

  return { envelopeId, stored };
}

async function envelopeExists(envelopeId: string) {
  const result = await database.query(`select 1 from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rowCount === 1;
}

async function pendingFileDeletions(envelopeId: string) {
  const result = await database.query<{ storage_key: string }>(
    `select storage_key from pending_file_deletions where envelope_id = $1`,
    [envelopeId],
  );

  return result.rows.map((row) => row.storage_key);
}

async function filesExist(keys: readonly string[]) {
  return Promise.all(
    keys.map(async (key) => (await storageService.headObject(key)).exists),
  );
}

function deleteAs(
  actor: { email: string; userId: string },
  envelopeId: string,
  reason?: unknown,
) {
  return deleteFinishedEnvelope(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", reason, userAgent: "Test browser" },
    { database, storageService },
  );
}

function rejectsWith(statusCode: number) {
  return (error: unknown) =>
    error instanceof EnvelopeMutationError && error.statusCode === statusCode;
}

async function latestEvent() {
  const [event] = await listSystemAuditEvents({ limit: 1 }, database);

  return event;
}

for (const status of ["completed", "declined", "voided"] as const) {
  test(`a ${status} envelope is deleted at once, with its files`, async () => {
    const admin = await createUser("admin");
    const sender = await createUser("user");
    const envelope = await createEnvelope(sender.userId, { status });

    assert.deepEqual(
      await filesExist(envelope.stored),
      envelope.stored.map(() => true),
    );

    const result = await deleteAs(
      admin,
      envelope.envelopeId,
      "Confidential HR cleanup",
    );

    assert.equal(result.reason, "Confidential HR cleanup");
    assert.equal(await envelopeExists(envelope.envelopeId), false);
    assert.deepEqual(
      await filesExist(envelope.stored),
      envelope.stored.map(() => false),
    );
    assert.deepEqual(await pendingFileDeletions(envelope.envelopeId), []);

    const event = await latestEvent();

    assert.equal(event?.event, "envelope_deleted");
    assert.equal(event?.actorUserId, admin.userId);
    assert.equal(event?.metadata?.envelopeId, envelope.envelopeId);
    assert.equal(event?.metadata?.ownerUserId, sender.userId);
    assert.equal(event?.metadata?.reason, "Confidential HR cleanup");
    assert.equal(event?.metadata?.sourcePdfHash, SOURCE_HASH);
    assert.equal(event?.metadata?.evidenceSha256, EVIDENCE_HASH);
    assert.equal(
      event?.metadata?.recipientEvidenceSha256,
      RECIPIENT_EVIDENCE_HASH,
    );
    assert.equal(
      event?.metadata?.signedPdfSha256,
      status === "completed" ? SIGNED_HASH : null,
    );
    assert.equal((await verifySystemAuditChain(database)).ok, true);
  });
}

test("an administrator may delete their own finished envelope too", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });

  await deleteAs(admin, envelope.envelopeId);

  assert.equal(await envelopeExists(envelope.envelopeId), false);
  assert.equal((await latestEvent())?.metadata?.reason, null);
});

test("only an administrator can delete a finished envelope", async () => {
  const sender = await createUser("user");
  const other = await createUser("user");
  const envelope = await createEnvelope(sender.userId, { status: "completed" });

  // Its own sender, without the role, is refused.
  await assert.rejects(deleteAs(sender, envelope.envelopeId), rejectsWith(403));
  // Anyone else does not see it at all.
  await assert.rejects(deleteAs(other, envelope.envelopeId), rejectsWith(404));
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("drafts and envelopes still out for signature are not deleted this way", async () => {
  const admin = await createUser("admin");
  const sender = await createUser("user");
  const draft = await createEnvelope(sender.userId, { status: "draft" });
  const sent = await createEnvelope(sender.userId, { status: "sent" });

  await assert.rejects(deleteAs(admin, draft.envelopeId), rejectsWith(409));
  await assert.rejects(deleteAs(admin, sent.envelopeId), /Void it first/);
  assert.equal(await envelopeExists(draft.envelopeId), true);
  assert.equal(await envelopeExists(sent.envelopeId), true);
});

test("a Part 11 record needs a reason to be deleted", async () => {
  const admin = await createUser("admin");
  const sender = await createUser("user");
  const envelope = await createEnvelope(sender.userId, {
    part11: true,
    status: "completed",
  });

  await assert.rejects(deleteAs(admin, envelope.envelopeId), /Give a reason/);
  await assert.rejects(
    deleteAs(admin, envelope.envelopeId, "   "),
    /Give a reason/,
  );
  assert.equal(await envelopeExists(envelope.envelopeId), true);

  await deleteAs(
    admin,
    envelope.envelopeId,
    "Superseded by a corrected record",
  );

  assert.equal(await envelopeExists(envelope.envelopeId), false);
  assert.equal((await latestEvent())?.metadata?.part11, true);
});

test("a reason must be text, and not too long", async () => {
  const admin = await createUser("admin");
  const sender = await createUser("user");
  const envelope = await createEnvelope(sender.userId, { status: "completed" });

  await assert.rejects(
    deleteAs(admin, envelope.envelopeId, 42),
    rejectsWith(400),
  );
  await assert.rejects(
    deleteAs(admin, envelope.envelopeId, "x".repeat(1001)),
    rejectsWith(400),
  );
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("a deleted envelope cannot be deleted twice", async () => {
  const admin = await createUser("admin");
  const sender = await createUser("user");
  const envelope = await createEnvelope(sender.userId, { status: "voided" });

  await deleteAs(admin, envelope.envelopeId);
  await assert.rejects(deleteAs(admin, envelope.envelopeId), rejectsWith(404));
});

test("a file that cannot be deleted stays queued for the daily cleanup", async () => {
  const admin = await createUser("admin");
  const sender = await createUser("user");
  const envelope = await createEnvelope(sender.userId, { status: "completed" });
  const failingStorage: StorageService = {
    ...storageService,
    async deleteObject() {
      throw new Error("Storage is down.");
    },
  };
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await deleteFinishedEnvelope(
      envelope.envelopeId,
      { actor: admin },
      { database, storageService: failingStorage },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(await envelopeExists(envelope.envelopeId), false);
  assert.deepEqual(
    (await pendingFileDeletions(envelope.envelopeId)).sort(),
    [...envelope.stored].sort(),
  );
});
