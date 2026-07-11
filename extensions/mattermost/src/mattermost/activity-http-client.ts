import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type {
  AgentActivityTransport,
  AgentActivityTransportResult,
  ActivityOutboxRecord,
} from "./activity-outbox.js";

const ACTIVITY_ENDPOINT = "http://127.0.0.1:3001/internal/openclaw/activity/v1/events";
const MAX_ENVELOPE_BYTES = 256 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function encodedLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function attachmentFor(append: ActivityOutboxRecord) {
  return append.envelope.type === "item.completed" ? append.envelope.item.attachment : undefined;
}

async function hashFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

function quotedFilename(value: string): string {
  return value.replace(/["\r\n]/g, "-");
}

async function buildMultipartRequest(
  append: ActivityOutboxRecord,
  envelopeJson: string,
): Promise<RequestInit & { duplex: "half" }> {
  const attachment = attachmentFor(append);
  if (!attachment || !append.attachmentFile) {
    throw new Error("activity multipart payload requires matching attachment metadata and detail");
  }
  const descriptor = append.attachmentFile;
  const stat = await fs.stat(descriptor.path).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new Error("activity multipart detail file is unavailable");
  }
  const verified = await hashFile(descriptor.path);
  if (
    descriptor.byteLength !== attachment.byteLength ||
    descriptor.sha256 !== attachment.sha256 ||
    verified.byteLength !== attachment.byteLength ||
    verified.sha256 !== attachment.sha256
  ) {
    throw new Error("activity multipart detail does not match attachment metadata");
  }
  const boundary = `openclaw-activity-${randomBytes(18).toString("hex")}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="envelope"; filename="envelope.json"\r\n' +
      "Content-Type: application/json\r\n\r\n" +
      `${envelopeJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="detail"; filename="${quotedFilename(attachment.filename)}"\r\n` +
      `Content-Type: ${attachment.mediaType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from(
    (async function* () {
      yield prefix;
      for await (const chunk of createReadStream(descriptor.path)) {
        yield chunk;
      }
      yield suffix;
    })(),
  );
  return {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(prefix.byteLength + attachment.byteLength + suffix.byteLength),
    },
    body: body as unknown as BodyInit,
    duplex: "half",
  };
}

async function parseSuccess(response: Response): Promise<AgentActivityTransportResult> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error("activity sink returned malformed success payload");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("activity sink returned malformed success payload");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("activity sink returned malformed success payload");
  }
  const record = value as Record<string, unknown>;
  const expectedOutcome = response.status === 201 ? "persisted" : "duplicate";
  if (
    record.outcome !== expectedOutcome ||
    typeof record.activityChannelId !== "string" ||
    !record.activityChannelId.trim() ||
    !Array.isArray(record.postIds) ||
    !record.postIds.every((postId) => typeof postId === "string")
  ) {
    throw new Error("activity sink returned malformed success payload");
  }
  return {
    status: response.status as 200 | 201,
    outcome: expectedOutcome,
    postIds: record.postIds,
    activityChannelId: record.activityChannelId.trim(),
  } as AgentActivityTransportResult;
}

/** Builds the bounded loopback transport consumed only by the SQLite outbox. */
export function createAgentActivityHttpTransport(options?: {
  fetchImpl?: typeof fetch;
  maxAttachmentBytes?: number;
}): AgentActivityTransport {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxAttachmentBytes = Math.max(
    1,
    Math.floor(options?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES),
  );
  return async (append) => {
    const envelopeJson = JSON.stringify(append.envelope);
    const envelopeBytes = encodedLength(envelopeJson);
    if (envelopeBytes > MAX_ENVELOPE_BYTES) {
      return { status: 413, outcome: "rejected" };
    }
    const hasAttachment = attachmentFor(append) !== undefined;
    if (hasAttachment !== (append.attachmentFile !== undefined)) {
      return { status: 422, outcome: "rejected" };
    }
    const attachment = attachmentFor(append);
    if (attachment && attachment.byteLength > maxAttachmentBytes) {
      return { status: 413, outcome: "rejected" };
    }
    let request: RequestInit;
    try {
      request = append.attachmentFile
        ? await buildMultipartRequest(append, envelopeJson)
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: envelopeJson,
          };
    } catch {
      return { status: 422, outcome: "rejected" };
    }
    const response = await fetchImpl(ACTIVITY_ENDPOINT, request);
    if (response.status === 200 || response.status === 201) {
      try {
        return await parseSuccess(response);
      } catch {
        return { status: 422, outcome: "rejected" };
      }
    }
    if (response.status === 503) {
      return { status: 503, outcome: "unavailable" };
    }
    return { status: response.status, outcome: "rejected" };
  };
}
