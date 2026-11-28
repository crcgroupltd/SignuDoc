import {
  type DbPool,
  type DbExecutor,
  getDb,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import {
  deletePendingFile,
  listEnvelopeStorageKeys,
  queueFileDeletions,
} from "./retention.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// An administrator may delete any finished envelope, their own or another
// member's. It goes at once: the signed PDF, the certificates, the fields
// and the envelope's own audit trail are deleted, as the retention period
// deletes them. The deletion stays in the install's audit trail, with the
// fingerprints the certificate gave, who deleted it and why.

const FINISHED_STATUSES = ["completed", "declined", "voided"] as const;

export const ENVELOPE_DELETION_REASON_MAX_LENGTH = 1000;

type FinishedEnvelopeRow = {
  evidenceSha256: string | null;
  finishedAt: number | null;
  id: string;
  ownerUserId: string;
  part11: boolean;
  recipientEvidenceSha256: string | null;
  signedPdfSha256: string | null;
  sourcePdfHash: string;
  status: string;
  title: string;
};

type OwnerRow = { email: string; name: string | null; role: string };

export type EnvelopeDeletionRequest = {
  actor: { email: string; userId: string };
  ipAddress?: string | null;
  reason?: unknown;
  userAgent?: string | null;
};

function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function parseReason(reason: unknown, part11: boolean): string | null {
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new EnvelopeMutationError("The reason must be text.", 400);
  }

  const trimmed = typeof reason === "string" ? reason.trim() : "";

  if (trimmed.length > ENVELOPE_DELETION_REASON_MAX_LENGTH) {
    throw new EnvelopeMutationError(
      `Keep the reason under ${String(ENVELOPE_DELETION_REASON_MAX_LENGTH)} characters.`,
      400,
    );
  }

  if (part11 && trimmed.length === 0) {
    throw new EnvelopeMutationError(
      "Give a reason for deleting this Part 11 record.",
      400,
    );
  }

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Locks a finished envelope for an administrator, in the one order
 * everything that moves envelopes between accounts uses.
 *
 * The account rows come before the envelope row: the sender's, then the
 * administrator's. Taking away a role, and closing an account, hold that
 * account's row (FOR UPDATE) before they take the audit trail lock and
 * move its envelopes, so the two wait in turn here instead of each holding
 * what the other needs. Read under these locks, the administrator's role is
 * the one in force: a change since the page loaded is honored. The
 * envelope row comes next, then the install's audit trail lock.
 */
async function lockFinishedEnvelope(
  tx: DbExecutor,
  envelopeId: string,
  actorUserId: string | null,
): Promise<{ envelope: FinishedEnvelopeRow; owner: OwnerRow | null }> {
  // Whose envelope it is, read first without a lock, so that the sender's
  // account row can be taken before the envelope row.
  const located = await queryOne<{ ownerUserId: string }>(
    tx,
    `SELECT user_id AS "ownerUserId" FROM envelopes WHERE id = $1`,
    [envelopeId],
  );

  if (!located) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  const owner = await queryOne<OwnerRow>(
    tx,
    `SELECT email, name, role FROM public."user" WHERE id = $1 FOR SHARE`,
    [located.ownerUserId],
  );
  let actorIsAdmin = true;

  if (actorUserId !== null) {
    const actorIsOwner = located.ownerUserId === actorUserId;
    const actorRole = actorIsOwner
      ? owner
      : await queryOne<{ role: string }>(
          tx,
          `SELECT role FROM public."user" WHERE id = $1 FOR SHARE`,
          [actorUserId],
        );

    actorIsAdmin = actorRole?.role === "admin";

    // Someone else's envelope is not there for anyone but an
    // administrator.
    if (!actorIsOwner && !actorIsAdmin) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }
  }

  const envelope = await queryOne<FinishedEnvelopeRow>(
    tx,
    `
      SELECT
        id,
        user_id AS "ownerUserId",
        title,
        status,
        part11,
        source_pdf_hash AS "sourcePdfHash",
        signed_pdf_sha256 AS "signedPdfSha256",
        evidence_sha256 AS "evidenceSha256",
        recipient_evidence_sha256 AS "recipientEvidenceSha256",
        COALESCE(completed_at, declined_at, voided_at) AS "finishedAt"
      FROM envelopes
      WHERE id = $1
      FOR UPDATE
    `,
    [envelopeId],
  );

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.ownerUserId !== located.ownerUserId) {
    // Handed to another administrator in the moment between.
    throw new EnvelopeMutationError(
      "This envelope just moved to another account. Reload the page and try again.",
      409,
    );
  }

  if (!(FINISHED_STATUSES as readonly string[]).includes(envelope.status)) {
    throw new EnvelopeMutationError(
      envelope.status === "sent"
        ? "This envelope is still out for signature. Void it first."
        : "Only finished envelopes can be deleted this way.",
      409,
    );
  }

  if (!actorIsAdmin) {
    throw new EnvelopeMutationError(
      "Only an administrator can delete a finished envelope.",
      403,
    );
  }

  return { envelope, owner };
}

/**
 * Deletes a finished envelope now, for an administrator. The row, the
 * record of its deletion and the list of its files commit together; the
 * files go after the commit, and one that cannot be deleted stays on the
 * list for the daily cleanup to try again.
 */
export async function deleteFinishedEnvelope(
  envelopeId: string,
  {
    actor,
    ipAddress = null,
    reason,
    userAgent = null,
  }: EnvelopeDeletionRequest,
  {
    database = getDb(),
    now = currentTime(),
    storageService = createStorageService(),
  }: {
    database?: DbPool;
    now?: number;
    storageService?: StorageService;
  } = {},
): Promise<{ deletedAt: number; reason: string | null }> {
  const result = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      actor.userId,
    );
    const deletionReason = parseReason(reason, envelope.part11);

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deleted",
        ipAddress,
        metadata: {
          envelopeId: envelope.id,
          evidenceSha256: envelope.evidenceSha256,
          finishedAt: envelope.finishedAt,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          part11: envelope.part11,
          reason: deletionReason,
          recipientEvidenceSha256: envelope.recipientEvidenceSha256,
          requestedAt: now,
          signedPdfSha256: envelope.signedPdfSha256,
          sourcePdfHash: envelope.sourcePdfHash,
          status: envelope.status,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
        userAgent,
      },
      tx,
    );

    const storageKeys = await listEnvelopeStorageKeys(envelope.id, tx);

    await queueFileDeletions(envelope.id, storageKeys, now, tx);
    await tx.query(`DELETE FROM envelopes WHERE id = $1`, [envelope.id]);

    return { reason: deletionReason, storageKeys };
  }, database);

  for (const key of result.storageKeys) {
    await deletePendingFile(key, database, storageService);
  }

  return { deletedAt: now, reason: result.reason };
}
