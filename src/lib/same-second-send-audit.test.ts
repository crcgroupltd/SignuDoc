import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type { Pool, PoolClient, QueryResult } from "pg";

import { listApiEnvelopeEvents } from "./api/envelope-view.ts";
import { exportEnvelopeAuditCsv } from "./audit-export.ts";
import { replaceDbPoolForTests } from "./db/connection.ts";
import { createDraftEnvelope, sendDraftEnvelope } from "./envelopes.ts";
import type { AuditEventRecord, EnvelopeRecord } from "./schemas/envelope.ts";
import type { SignerRecord } from "./schemas/signer.ts";
import { listAuditEventsForEnvelope } from "./services/audit.ts";
import { renderEnvelopeCertificatePdf } from "./services/pdf-finalize.ts";
import { createStorageService } from "./services/storage.ts";

// Regression tests for issue #213: creating and sending an envelope in the
// same whole second must record sent.created_at === envelope.sent_at and
// email_sent.created_at >= sent.created_at, while preserving created -> sent
// -> email_sent order across the audit API, CSV export, and PDF certificate.

const ENV_KEYS = [
  "APP_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let workDir: string;
let storageDir: string;
let outboxDir: string;
let sourcePdfBytes: Uint8Array;
let replacedPool: Pool | null = null;
const previousEnv = new Map<string, string | undefined>();

type StoredEnvelope = {
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  id: string;
  pageCount: number;
  part11: boolean;
  reminderIntervalDays: number | null;
  sentAt: number | null;
  signatureLevel: "advanced" | "qualified" | "simple";
  signatureProvider: string | null;
  signedPdfKey: string | null;
  sourcePdfFilename: string;
  sourcePdfHash: string;
  sourcePdfKey: string;
  sourcePdfSizeBytes: number;
  status: "draft" | "sent" | "completed" | "declined" | "voided";
  title: string;
  updatedAt: number;
  userId: string;
  voidedAt: number | null;
};

type StoredPage = {
  envelopeId: string;
  heightPt: number;
  id: string;
  pageNumber: number;
  widthPt: number;
};

type StoredSigner = {
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  role: "signer" | "approver";
  signatureMeaning: null;
  signedAt: number | null;
  signOrder: number;
  signingStep: number;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: "pending" | "notified" | "signed" | "declined";
  turnStartedAt: number | null;
  updatedAt: number;
};

type StoredField = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  groupId: string | null;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: null;
  label: string | null;
  options: string[] | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type: "signature";
  updatedAt: number;
  value: string | null;
  width: number;
  x: number;
  y: number;
};

type StoredAuditRow = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  envelopeId: string;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  prevHash: string | null;
  rowHash: string | null;
  sequence: number;
  userAgent: string | null;
};

function queryResult<T>(rows: T[], rowCount = rows.length): QueryResult {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount,
    rows,
  } as unknown as QueryResult;
}

function createFakeAuditDb() {
  const envelopes = new Map<string, StoredEnvelope>();
  const pages: StoredPage[] = [];
  const signers: StoredSigner[] = [];
  const fields: StoredField[] = [];
  const auditEvents: StoredAuditRow[] = [];

  function orderedAuditRows(envelopeId: string): StoredAuditRow[] {
    return auditEvents
      .filter((row) => row.envelopeId === envelopeId)
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
  }

  async function execute(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return queryResult([], 0);
    }

    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      return queryResult([{ pg_advisory_xact_lock: "" }], 1);
    }

    if (sql.toLowerCase().includes("app_settings")) {
      return queryResult([
        {
          allowed_email_domains: [],
          brand_color: null,
          consent_disclosure: null,
          email_ready_at: null,
          logo_hash: null,
          organization_name: "Acme Test",
          part11_mode: false,
          privacy_url: null,
          require_two_factor: false,
          retention_days: null,
          sender_address: null,
          session_idle_minutes: null,
          session_max_hours: null,
          setup_completed_at: 1_700_000_000,
          signup_mode: "open",
          support_address: null,
          terms_url: null,
        },
      ]);
    }

    if (sql.startsWith("INSERT INTO envelopes")) {
      const row: StoredEnvelope = {
        completedAt: (values[12] as number | null) ?? null,
        createdAt: Number(values[15]),
        declinedAt: (values[13] as number | null) ?? null,
        evidenceKey: (values[9] as string | null) ?? null,
        expiresAt: null,
        id: String(values[0]),
        pageCount: Number(values[7]),
        part11: false,
        reminderIntervalDays: null,
        sentAt: (values[11] as number | null) ?? null,
        signatureLevel: "simple",
        signatureProvider: null,
        signedPdfKey: (values[8] as string | null) ?? null,
        sourcePdfFilename: String(values[5]),
        sourcePdfHash: String(values[10]),
        sourcePdfKey: String(values[4]),
        sourcePdfSizeBytes: Number(values[6]),
        status: values[3] as StoredEnvelope["status"],
        title: String(values[2]),
        updatedAt: Number(values[16]),
        userId: String(values[1]),
        voidedAt: (values[14] as number | null) ?? null,
      };
      envelopes.set(row.id, row);
      return queryResult([], 1);
    }

    if (sql.startsWith("INSERT INTO envelope_pages")) {
      pages.push({
        envelopeId: String(values[1]),
        heightPt: Number(values[4]),
        id: String(values[0]),
        pageNumber: Number(values[2]),
        widthPt: Number(values[3]),
      });
      return queryResult([], 1);
    }

    if (sql.includes("FROM envelope_pages WHERE envelope_id = $1")) {
      return queryResult(
        pages
          .filter((page) => page.envelopeId === values[0])
          .sort((a, b) => a.pageNumber - b.pageNumber),
      );
    }

    if (sql.includes("FROM envelopes WHERE id = $1 AND user_id = $2")) {
      const row = envelopes.get(String(values[0]));

      if (row && row.userId === values[1]) {
        return queryResult([{ ...row }]);
      }

      return queryResult([]);
    }

    if (sql.includes("FROM signers") && sql.includes("role = 'cc'")) {
      return queryResult([]);
    }

    if (sql.includes("FROM signers WHERE envelope_id IN")) {
      return queryResult(
        signers
          .filter((signer) => values.includes(signer.envelopeId))
          .map((signer) => ({ ...signer })),
      );
    }

    if (sql.includes("FROM fields WHERE envelope_id IN")) {
      return queryResult(
        fields
          .filter((field) => values.includes(field.envelopeId))
          .map((field) => ({ ...field })),
      );
    }

    if (sql.startsWith("UPDATE envelopes SET status = 'sent'")) {
      const row = envelopes.get(String(values[2]));

      if (row && row.userId === values[3] && row.status === "draft") {
        row.status = "sent";
        row.sentAt = Number(values[0]);
        row.updatedAt = Number(values[1]);
        row.expiresAt = Number(values[4]);
        row.reminderIntervalDays = (values[5] as number | null) ?? null;
        return queryResult([], 1);
      }

      return queryResult([], 0);
    }

    if (sql.startsWith("UPDATE envelopes SET status = 'draft'")) {
      const row = envelopes.get(String(values[1]));

      if (row && row.userId === values[2] && row.status === "sent") {
        row.status = "draft";
        row.sentAt = null;
        row.expiresAt = null;
        row.reminderIntervalDays = null;
        row.updatedAt = Number(values[0]);
        return queryResult([], 1);
      }

      return queryResult([], 0);
    }

    if (sql.startsWith("UPDATE signers SET status = 'pending'")) {
      let updated = 0;

      for (const signer of signers) {
        if (signer.envelopeId === values[1]) {
          signer.status = "pending";
          signer.signingTokenHash = null;
          signer.signingTokenExpiresAt = null;
          signer.turnStartedAt = null;
          signer.lastNotifiedAt = null;
          signer.updatedAt = Number(values[0]);
          updated += 1;
        }
      }

      return queryResult([], updated);
    }

    // Sending fills every signer's name fields. These envelopes have none.
    if (sql.startsWith("UPDATE fields f SET value = s.name")) {
      return queryResult([], 0);
    }

    if (sql.startsWith("UPDATE signers SET status = 'notified'")) {
      const signer = signers.find(
        (entry) => entry.id === values[5] && entry.envelopeId === values[6],
      );

      if (!signer) {
        return queryResult([], 0);
      }

      signer.status = "notified";
      signer.signingTokenHash = String(values[0]);
      signer.signingTokenExpiresAt = Number(values[1]);
      signer.turnStartedAt = Number(values[2]);
      signer.lastNotifiedAt = Number(values[3]);
      signer.updatedAt = Number(values[4]);
      return queryResult([], 1);
    }

    if (
      sql.includes("SELECT sequence, row_hash") &&
      sql.includes("FROM audit_events")
    ) {
      const latest = orderedAuditRows(String(values[0])).at(-1);

      return queryResult(
        latest ? [{ rowHash: latest.rowHash, sequence: latest.sequence }] : [],
      );
    }

    if (sql.startsWith("INSERT INTO audit_events")) {
      auditEvents.push({
        actorEmail: (values[4] as string | null) ?? null,
        actorType: String(values[3]),
        createdAt: Number(values[8]),
        envelopeId: String(values[1]),
        event: String(values[2]),
        id: String(values[0]),
        ipAddress: (values[5] as string | null) ?? null,
        metadata: (values[7] as Record<string, unknown> | null) ?? null,
        prevHash: (values[10] as string | null) ?? null,
        rowHash: (values[11] as string | null) ?? null,
        sequence: Number(values[9]),
        userAgent: (values[6] as string | null) ?? null,
      });
      return queryResult([], 1);
    }

    if (sql.startsWith("DELETE FROM audit_events")) {
      const envelopeId = String(values[0]);
      const createdAt = Number(values[1]);
      const actorEmail = values[2];
      const maxSeq = orderedAuditRows(envelopeId).at(-1)?.sequence;
      const index = auditEvents.findIndex(
        (row) =>
          row.envelopeId === envelopeId &&
          row.event === "sent" &&
          row.createdAt === createdAt &&
          row.actorEmail === actorEmail &&
          row.sequence === maxSeq,
      );

      if (index === -1) {
        return queryResult([], 0);
      }

      auditEvents.splice(index, 1);
      return queryResult([], 1);
    }

    if (sql.includes("FROM audit_events") && sql.includes("ORDER BY")) {
      return queryResult(
        orderedAuditRows(String(values[0])).map((row) => ({ ...row })),
      );
    }

    if (
      sql.includes("webhook_deliveries") ||
      sql.includes("webhook_endpoints")
    ) {
      return queryResult([], 0);
    }

    throw new Error(`Unexpected SQL in fake audit DB: ${sql}`);
  }

  const client = {
    query: execute,
    release() {},
  } as unknown as PoolClient;

  const pool = {
    async connect() {
      return client;
    },
    query: execute,
    totalCount: 1,
  } as unknown as Pool;

  return {
    addSignerAndField(envelopeId: string, createdAt: number) {
      const signerId = randomUUID();
      signers.push({
        createdAt,
        declineReason: null,
        declinedAt: null,
        email: "riley@example.test",
        envelopeId,
        id: signerId,
        lastNotifiedAt: null,
        lastNudgedAt: null,
        name: "Riley Recipient",
        role: "signer",
        signatureMeaning: null,
        signedAt: null,
        signOrder: 1,
        signingStep: 1,
        signingTokenExpiresAt: null,
        signingTokenHash: null,
        status: "pending",
        turnStartedAt: null,
        updatedAt: createdAt,
      });
      fields.push({
        checked: null,
        createdAt,
        envelopeId,
        groupId: null,
        height: 0.04,
        id: randomUUID(),
        imageKey: null,
        inputMethod: null,
        label: null,
        options: null,
        page: 1,
        required: true,
        signerId,
        submittedAt: null,
        type: "signature",
        updatedAt: createdAt,
        value: null,
        width: 0.25,
        x: 0.1,
        y: 0.1,
      });
      return signerId;
    },
    auditEvents,
    envelopes,
    pool,
    signers,
  };
}

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    parts.push(
      content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
    );
  }

  await document.destroy();

  return parts.join("\n").replace(/\s+/g, " ");
}

function certificateEventEntries(
  text: string,
): Array<{ event: string; timestamp: string }> {
  const section = text.slice(text.indexOf("Audit events"));

  return [
    ...section.matchAll(
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC) \| (\w+) \|/g,
    ),
  ].map((match) => ({ event: match[2]!, timestamp: match[1]! }));
}

before(async () => {
  for (const key of ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
  }

  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-audit-213-"));
  storageDir = path.join(workDir, "storage");
  outboxDir = path.join(workDir, "outbox");

  process.env.APP_URL = "https://sign.example.test";
  process.env.EMAIL_CAPTURE_DIR = outboxDir;
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  sourcePdfBytes = await pdf.save();
});

after(async () => {
  if (replacedPool) {
    replaceDbPoolForTests(replacedPool);
  }

  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

test("same-second create and send aligns sent audit timestamp with envelope.sentAt across API, CSV, and certificate (issue #213)", async (t) => {
  const fixedSecond = 1_800_000_500;
  t.mock.method(Date, "now", () => fixedSecond * 1000);

  const db = createFakeAuditDb();
  const previousPool = replaceDbPoolForTests(db.pool);
  if (replacedPool === null && previousPool !== null) {
    replacedPool = previousPool;
  }
  const storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
  const userId = "sender-1";

  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdfBytes,
        contentType: "application/pdf",
        filename: "contract.pdf",
      },
      title: "Same-second contract",
    },
    { database: db.pool, storageService },
  );
  const envelopeId = draft.envelope.id;
  db.addSignerAndField(envelopeId, fixedSecond);

  const sentResult = await sendDraftEnvelope(
    userId,
    envelopeId,
    {
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
    },
    { database: db.pool },
  );

  const storedEnvelope = db.envelopes.get(envelopeId)!;
  assert.equal(storedEnvelope.createdAt, fixedSecond);
  assert.equal(storedEnvelope.sentAt, fixedSecond);
  assert.equal(sentResult.sentAt, fixedSecond);

  // Audit events via listAuditEventsForEnvelope:
  const events = await listAuditEventsForEnvelope(envelopeId, db.pool);
  assert.deepEqual(
    events.map((event) => event.event),
    ["created", "sent", "email_sent"],
  );
  assert.equal(events[0]!.createdAt, fixedSecond);
  assert.equal(events[1]!.createdAt, storedEnvelope.sentAt);
  assert.ok(
    events[2]!.createdAt >= events[1]!.createdAt,
    `expected email_sent (${String(events[2]!.createdAt)}) >= sent (${String(events[1]!.createdAt)})`,
  );

  // Public audit API:
  const apiEvents = await listApiEnvelopeEvents(userId, envelopeId, db.pool);
  const expectedIso = new Date(fixedSecond * 1000).toISOString();
  assert.deepEqual(
    apiEvents?.map((event) => [event.event, event.at]),
    [
      ["created", expectedIso],
      ["sent", expectedIso],
      ["email_sent", expectedIso],
    ],
  );

  // Audit CSV export:
  const csv = await exportEnvelopeAuditCsv(userId, envelopeId, db.pool);
  assert.match(csv.body, /intact \(3 chained events\)/);
  const lines = csv.body.trim().split("\r\n");
  const headerIndex = lines.findIndex((line) =>
    line.startsWith("sequence,time_utc,event,"),
  );
  assert.ok(headerIndex >= 0);
  const csvEventRows = lines.slice(headerIndex + 1).map((line) => {
    const [sequence, timeUtc, event] = line.split(",");
    return [sequence, timeUtc, event];
  });
  assert.deepEqual(csvEventRows, [
    ["1", expectedIso, "created"],
    ["2", expectedIso, "sent"],
    ["3", expectedIso, "email_sent"],
  ]);

  // Voided certificate preserves sequence order and non-decreasing timestamps:
  const voidedAt = fixedSecond;
  const voidedEnvelope: EnvelopeRecord = {
    ...storedEnvelope,
    status: "voided",
    voidedAt,
  };
  const certificateEvents: AuditEventRecord[] = [
    ...events,
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: voidedAt,
      envelopeId,
      event: "voided",
      id: "00000000-0000-0000-0000-000000000000",
      ipAddress: null,
      metadata: null,
      userAgent: null,
    },
  ];
  const certificateSigners: SignerRecord[] = db.signers.map((signer) => ({
    createdAt: signer.createdAt,
    email: signer.email,
    id: signer.id,
    name: signer.name,
    role: signer.role,
    signOrder: signer.signOrder,
    signingStep: signer.signingStep,
    status: signer.status,
    updatedAt: signer.updatedAt,
  }));
  const certificatePdf = await renderEnvelopeCertificatePdf(
    {
      auditEvents: certificateEvents,
      envelope: voidedEnvelope,
      signers: certificateSigners,
    },
    { seal: (pdfDocument) => pdfDocument.save() },
  );
  const certificateText = await extractPdfText(certificatePdf);

  assert.deepEqual(
    certificateEventEntries(certificateText),
    [
      { event: "created", timestamp: "2027-01-15T08:08:20 UTC" },
      { event: "sent", timestamp: "2027-01-15T08:08:20 UTC" },
      { event: "email_sent", timestamp: "2027-01-15T08:08:20 UTC" },
      { event: "voided", timestamp: "2027-01-15T08:08:20 UTC" },
    ],
    certificateText,
  );
});

test("separate-second create and send records created < sent === envelope.sentAt <= email_sent (issue #213)", async (t) => {
  let currentSecond = 1_800_001_000;
  t.mock.method(Date, "now", () => currentSecond * 1000);

  const db = createFakeAuditDb();
  const previousPool = replaceDbPoolForTests(db.pool);
  if (replacedPool === null && previousPool !== null) {
    replacedPool = previousPool;
  }
  const storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
  const userId = "sender-2";

  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdfBytes,
        contentType: "application/pdf",
        filename: "control.pdf",
      },
      title: "Separate-second contract",
    },
    { database: db.pool, storageService },
  );
  const envelopeId = draft.envelope.id;
  db.addSignerAndField(envelopeId, currentSecond);

  currentSecond += 2;
  await sendDraftEnvelope(
    userId,
    envelopeId,
    {
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
    },
    { database: db.pool },
  );

  const storedEnvelope = db.envelopes.get(envelopeId)!;
  const events = await listAuditEventsForEnvelope(envelopeId, db.pool);

  assert.deepEqual(
    events.map((event) => event.event),
    ["created", "sent", "email_sent"],
  );
  assert.equal(events[0]!.createdAt, 1_800_001_000);
  assert.equal(events[1]!.createdAt, 1_800_001_002);
  assert.equal(events[1]!.createdAt, storedEnvelope.sentAt);
  assert.ok(events[0]!.createdAt < events[1]!.createdAt);
  assert.ok(events[2]!.createdAt >= events[1]!.createdAt);
});

test("same-second failed invitation rolls back the sent audit event while keeping created (issue #213)", async (t) => {
  const fixedSecond = 1_800_002_000;
  t.mock.method(Date, "now", () => fixedSecond * 1000);

  const db = createFakeAuditDb();
  const previousPool = replaceDbPoolForTests(db.pool);
  if (replacedPool === null && previousPool !== null) {
    replacedPool = previousPool;
  }
  const storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
  const userId = "sender-3";

  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdfBytes,
        contentType: "application/pdf",
        filename: "rollback.pdf",
      },
      title: "Rollback contract",
    },
    { database: db.pool, storageService },
  );
  const envelopeId = draft.envelope.id;
  db.addSignerAndField(envelopeId, fixedSecond);

  // Point EMAIL_CAPTURE_DIR at a regular file so local capture fails cleanly
  // without network access and triggers sendDraftEnvelope's rollback path.
  const blockingFile = path.join(workDir, "not-a-directory");
  await writeFile(blockingFile, "block");
  const prevCaptureDir = process.env.EMAIL_CAPTURE_DIR;
  process.env.EMAIL_CAPTURE_DIR = blockingFile;

  try {
    await assert.rejects(
      sendDraftEnvelope(
        userId,
        envelopeId,
        {
          senderEmail: "sam@example.test",
          senderName: "Sam Sender",
        },
        { database: db.pool },
      ),
    );
  } finally {
    process.env.EMAIL_CAPTURE_DIR = prevCaptureDir;
  }

  const storedEnvelope = db.envelopes.get(envelopeId)!;
  const events = await listAuditEventsForEnvelope(envelopeId, db.pool);

  assert.equal(storedEnvelope.status, "draft");
  assert.equal(storedEnvelope.sentAt, null);
  assert.deepEqual(
    events.map((event) => [event.event, event.createdAt]),
    [["created", fixedSecond]],
  );
});
