import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAgentActivityHttpTransport } from "./activity-http-client.js";
import type { ActivityOutboxRecord } from "./activity-outbox.js";

function activityAppend(): ActivityOutboxRecord {
  return {
    envelope: {
      schemaVersion: 1,
      type: "turn.started",
      eventKey: "event-1",
      emittedAt: "2026-07-11T12:00:00.000Z",
      ref: {
        conversationId: "channel-1",
        turnId: "post-1",
        runId: "run-1",
        agentId: "agent-1",
        sessionKey: "session-1",
        origin: "human",
        mainChannelId: "channel-1",
        mainRootPostId: "post-1",
        itemId: "octogee:run-root",
        ordinal: 0,
        semanticVersion: 1,
      },
      redaction: { policy: "octogee-v1", appliedAt: "producer" },
    },
  };
}

describe("createAgentActivityHttpTransport", () => {
  it("posts bounded JSON to the private loopback route and validates success", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            outcome: "persisted",
            postIds: ["activity-1"],
            activityChannelId: "activity-channel",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const transport = createAgentActivityHttpTransport({ fetchImpl });

    await expect(transport(activityAppend())).resolves.toEqual({
      status: 201,
      outcome: "persisted",
      postIds: ["activity-1"],
      activityChannelId: "activity-channel",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/internal/openclaw/activity/v1/events",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activityAppend().envelope),
      }),
    );
  });

  it("uses one envelope part and one detail part for attachments", async () => {
    const append = activityAppend();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-activity-http-"));
    const detailPath = path.join(stateDir, "detail.md");
    await fs.writeFile(detailPath, "large redacted detail", { mode: 0o600 });
    append.attachmentFile = {
      path: detailPath,
      byteLength: 21,
      sha256: createHash("sha256").update("large redacted detail").digest("hex"),
    };
    append.envelope = {
      ...append.envelope,
      type: "item.completed",
      item: {
        kind: "tool",
        status: "completed",
        summary: "large output",
        attachment: {
          filename: "tool.md",
          mediaType: "text/markdown",
          byteLength: 21,
          sha256: createHash("sha256").update("large redacted detail").digest("hex"),
          multipartField: "detail",
        },
      },
    };
    let capturedBody = "";
    let capturedHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      const chunks: Buffer[] = [];
      if (!init?.body) {
        throw new Error("expected multipart request body");
      }
      for await (const chunk of init.body as unknown as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      capturedBody = Buffer.concat(chunks).toString("utf8");
      return new Response(
        JSON.stringify({
          outcome: "duplicate",
          postIds: [],
          activityChannelId: "activity-channel",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const transport = createAgentActivityHttpTransport({ fetchImpl });

    try {
      await expect(transport(append)).resolves.toMatchObject({ status: 200, outcome: "duplicate" });
      expect(capturedHeaders?.get("content-type")).toMatch(
        /^multipart\/form-data; boundary=openclaw-activity-/,
      );
      expect(capturedBody).toContain(JSON.stringify(append.envelope));
      expect(capturedBody).toContain("large redacted detail");
      expect(capturedBody).toContain('name="detail"; filename="tool.md"');
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("classifies retryable status and rejects malformed success payloads", async () => {
    const unavailable = createAgentActivityHttpTransport({
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });
    await expect(unavailable(activityAppend())).resolves.toEqual({
      status: 503,
      outcome: "unavailable",
    });

    const malformed = createAgentActivityHttpTransport({
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              outcome: "persisted",
              postIds: [1],
              activityChannelId: "activity-channel",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    });
    await expect(malformed(activityAppend())).resolves.toEqual({
      status: 422,
      outcome: "rejected",
    });
  });

  it("refuses an oversized JSON envelope before opening the socket", async () => {
    const append = activityAppend();
    append.envelope = {
      ...append.envelope,
      type: "item.completed",
      item: {
        kind: "tool",
        status: "completed",
        summary: "x".repeat(300_000),
      },
    };
    const fetchImpl = vi.fn();
    const transport = createAgentActivityHttpTransport({ fetchImpl });

    await expect(transport(append)).resolves.toEqual({ status: 413, outcome: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses attachment metadata above the configured upload limit before reading the file", async () => {
    const append = activityAppend();
    append.envelope = {
      ...append.envelope,
      type: "item.completed",
      item: {
        kind: "tool",
        status: "completed",
        summary: "large",
        attachment: {
          filename: "tool.md",
          mediaType: "text/markdown",
          byteLength: 5,
          sha256: "a".repeat(64),
          multipartField: "detail",
        },
      },
    };
    append.attachmentFile = {
      path: "/does/not/exist",
      byteLength: 5,
      sha256: "a".repeat(64),
    };
    const fetchImpl = vi.fn();
    const transport = createAgentActivityHttpTransport({ fetchImpl, maxAttachmentBytes: 4 });

    await expect(transport(append)).resolves.toEqual({ status: 413, outcome: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a spool file whose bytes do not match the envelope before HTTP", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-activity-http-"));
    const detailPath = path.join(stateDir, "detail.md");
    await fs.writeFile(detailPath, "tampered", { mode: 0o600 });
    const append = activityAppend();
    const expected = "expected detail";
    append.envelope = {
      ...append.envelope,
      type: "item.completed",
      item: {
        kind: "tool",
        status: "completed",
        summary: "output",
        attachment: {
          filename: "tool.md",
          mediaType: "text/markdown",
          byteLength: Buffer.byteLength(expected),
          sha256: createHash("sha256").update(expected).digest("hex"),
          multipartField: "detail",
        },
      },
    };
    append.attachmentFile = {
      path: detailPath,
      byteLength: Buffer.byteLength(expected),
      sha256: createHash("sha256").update(expected).digest("hex"),
    };
    const fetchImpl = vi.fn();
    const transport = createAgentActivityHttpTransport({ fetchImpl });

    try {
      await expect(transport(append)).resolves.toEqual({ status: 422, outcome: "rejected" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
