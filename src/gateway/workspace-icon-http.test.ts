import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeControlUiReadRequestOrReply: (...args: unknown[]) => mocks.authorize(...args),
}));

const {
  handleWorkspaceIconHttpRequest,
  resolveWorkspaceIcon,
  SVG_ICON_MAX_BYTES,
  WORKSPACE_ICON_MAX_BYTES,
} = await import("./workspace-icon-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const ICO_BYTES = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');

function expectHeaders(response: Response, headers: Record<string, string | null>) {
  for (const [name, value] of Object.entries(headers)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

function holdIconRead() {
  const reading = createDeferredCore();
  const release = createDeferredCore();
  const readFile = boundaryFileRead.readFileDescriptorBounded;
  const read = vi
    .spyOn(boundaryFileRead, "readFileDescriptorBounded")
    .mockImplementationOnce(async (...args) => {
      reading.resolve();
      await release.promise;
      return await readFile(...args);
    });
  return { reading: reading.promise, release: release.resolve, restore: () => read.mockRestore() };
}

const roots = useAutoCleanupTempDirTracker(afterEach);

async function makeWorkspace(files: Record<string, Buffer>): Promise<string> {
  // Canonicalize first: macOS tmp is a /var -> /private/var symlink and the
  // resolver returns realpaths, so a raw mkdtemp root would not compare equal.
  const root = await fs.realpath(roots.make("openclaw-ws-icon-"));
  for (const [relative, body] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }
  return root;
}

afterEach(() => vi.restoreAllMocks());

describe("resolveWorkspaceIcon", () => {
  const rejected = [
    ["an empty file", "ico", Buffer.alloc(0)],
    ["bytes that are not an image", "ico", Buffer.from("#!/bin/sh\n")],
    ["an SVG carrying a doctype", "svg", '<!DOCTYPE svg><svg xmlns="x"></svg>'],
    ["external SVG", "svg", '<svg xmlns="x"><image href="https://x.test"/></svg>'],
    ["an SVG script", "svg", '<svg xmlns="x"><script>alert(1)</script></svg>'],
    ["oversized SVG", "svg", `<svg xmlns="x">${"1".repeat(SVG_ICON_MAX_BYTES)}</svg>`],
    ["an icon past the size cap", "png", Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1)],
  ] as const;

  it.each(rejected)("records no icon for %s", async (_label, extension, body) => {
    const root = await makeWorkspace({
      [`favicon.${extension}`]: typeof body === "string" ? Buffer.from(body) : body,
    });
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("does not follow an icon symlink out of the workspace", async () => {
    const outside = await makeWorkspace({ "secret.png": PNG_BYTES });
    const root = await makeWorkspace({});
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "favicon.png"));
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });
});

describe("handleWorkspaceIconHttpRequest", () => {
  let origin: string;
  let server: ReturnType<typeof createServer>;
  let authorityCurrent = true;
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let projection: SessionRowProjection | undefined;
  const context = bindSessionRowProjection({}, () => projection);

  function seedSession(
    root?: string,
    key = "agent:main:one",
    fields: Partial<InternalSessionEntry> = {},
  ) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: key,
        updatedAt: 1,
        ...(root ? { spawnedCwd: root } : { pendingWorktree: { titleSource: "Pending" } }),
        ...fields,
      },
    );
  }

  function publishPluginMetadata() {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(), {
      config: cfg,
      compatibleConfigs: [cfg],
    });
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    cfg = {
      agents: {
        entries: { main: {} },
        defaults: { workspace: state.workspaceDir },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    publishPluginMetadata();
    // Gateway startup admits the physical store before serving prepared reads.
    seedSession(undefined, "agent:main:fixture");
    projection = await createSessionRowProjection({
      cfg,
      getPolicyConfig: () => cfg,
      modelCatalog: [],
    });
    server = createServer((req, res) => {
      void handleWorkspaceIconHttpRequest(req, res, {
        ...context,
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 418;
            res.end("unhandled");
          }
        })
        .catch(() => finishFailedGatewayHttpResponse(res));
    });
    origin = await listenLoopback(server);
  });

  afterAll(async () => {
    await closeHttpServer(server);
    projection?.dispose();
    projection = undefined;
    setCurrentPluginMetadataSnapshot(undefined);
    resetPluginRuntimeStateForTest();
    await state?.cleanup();
  });

  beforeEach(() => {
    // The shared test setup retires plugin runtime metadata after every case.
    cfg = { ...cfg, gateway: undefined };
    setRuntimeConfigSnapshot(cfg);
    publishPluginMetadata();
    authorityCurrent = true;
    mocks.authorize.mockReset().mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        {
          authMethod: "token",
          operatorScopes: ["operator.admin", "operator.read"],
        },
        res,
        () => authorityCurrent,
      ),
    );
  });

  const iconRoute = (sessionKey: string) =>
    `${origin}/__openclaw__/workspace-icon/${encodeURIComponent(sessionKey)}`;
  async function requestIcon(status = 200, key = "agent:main:one") {
    const response = await fetch(iconRoute(key));
    expect(response.status).toBe(status);
    return response;
  }
  async function seedIcon(key = "agent:main:one", fields: Partial<InternalSessionEntry> = {}) {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    seedSession(root, key, fields);
    return root;
  }
  async function expectBody(response: Response, bytes: Buffer) {
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }

  it("serves a solo read-scoped device without a profile", async () => {
    const key = "agent:main:standalone";
    seedSession(await makeWorkspace({ "favicon.png": PNG_BYTES }), key, { visibility: "draft" });
    mocks.authorize.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        { authMethod: "device-token", operatorScopes: ["operator.read"] },
        res,
        () => authorityCurrent,
      ),
    );
    const response = await fetch(iconRoute(key));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  function authorizeMember(sessionCap: "none" | "view") {
    cfg = {
      ...cfg,
      gateway: {
        roles: {
          default: "fallback",
          definitions: {
            fallback: {
              sessions: { others: sessionCap === "none" ? "view" : "none" },
              agents: "*",
              scopes: ["operator.read"],
            },
            member: {
              sessions: { others: sessionCap },
              agents: ["other-agent"],
              scopes: ["operator.read"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const member = ensureProfileForEmail(`icon-member-${sessionCap}@example.test`);
    setUserProfileRole(member.id, "member");
    mocks.authorize.mockImplementation(({ res }: { res: ServerResponse }) =>
      bindHttpResponseAuthority(
        {
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          authenticatedUserProfile: {
            profileId: member.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: member.updatedAt,
          },
        },
        res,
        () => authorityCurrent,
      ),
    );
    return member.id;
  }

  it.each(["none", "view"] as const)(
    "scopes named-role icons to current session visibility with %s access",
    async (sessionCap) => {
      const profileId = authorizeMember(sessionCap);
      for (const kind of [
        "own",
        "foreign",
        "invited",
        "channel",
        "draft",
        "incognito",
        "deleted",
      ]) {
        const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
        const key = `agent:main:icon-${sessionCap}-${kind}`;
        if (kind !== "deleted") {
          seedSession(root, key, {
            sessionId: key,
            visibility: kind === "draft" ? "draft" : "shared",
            ...(kind === "channel" || kind === "draft" ? { createdVia: "channel" as const } : {}),
            ...(kind === "incognito" ? { incognito: true as const } : {}),
            createdActor: {
              type: "human",
              source: "profile",
              id: kind === "own" || kind === "incognito" ? profileId : "other",
            },
          });
        }
        if (kind === "invited" || kind === "channel" || kind === "draft") {
          addSessionMember(
            { agentId: "main", sessionKey: key },
            { identityId: profileId, addedBy: "channel-sync", expectedSessionId: key },
          );
        }
        const reads = vi.spyOn(boundaryFileRead, "openRootFile");
        const response = await fetch(iconRoute(key));
        const visible =
          kind === "own" ||
          kind === "channel" ||
          ((kind === "foreign" || kind === "invited") && sessionCap === "view");
        expect(response.status, kind).toBe(visible ? 200 : 404);
        if (!visible) {
          expect(response.headers.get("etag")).toBeNull();
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(reads).not.toHaveBeenCalled();
        }
        await response.arrayBuffer();
        reads.mockRestore();
        if (kind === "channel" && sessionCap === "none") {
          removeSessionMember({ agentId: "main", sessionKey: key }, profileId, undefined, key);
          const revoked = await fetch(iconRoute(key));
          expect(revoked.status).toBe(404);
          expect(revoked.headers.get("etag")).toBeNull();
          await revoked.arrayBuffer();
        }
        if (kind === "foreign" && sessionCap === "view") {
          seedSession(root, key, {
            sessionId: key,
            visibility: "draft",
            createdActor: { type: "human", source: "profile", id: "other" },
          });
          const hidden = await fetch(iconRoute(key));
          expect(hidden.status).toBe(404);
          await hidden.arrayBuffer();
        }
      }
    },
  );

  it("rejects membership revoked while reading an admitted channel icon", async () => {
    const profileId = authorizeMember("none");
    const key = "agent:main:icon-membership-revoked";
    seedSession(await makeWorkspace({ "favicon.png": PNG_BYTES }), key, {
      createdVia: "channel",
      createdActor: { type: "human", source: "channel", id: "other" },
    });
    addSessionMember(
      { agentId: "main", sessionKey: key },
      { identityId: profileId, addedBy: "channel-sync", expectedSessionId: key },
    );
    const reading = createDeferredCore();
    const release = createDeferredCore();
    const readFile = boundaryFileRead.readFileDescriptorBounded;
    const read = vi
      .spyOn(boundaryFileRead, "readFileDescriptorBounded")
      .mockImplementationOnce(async (...args) => {
        reading.resolve();
        await release.promise;
        return await readFile(...args);
      });
    const pending = fetch(iconRoute(key));
    try {
      await reading.promise;
      removeSessionMember({ agentId: "main", sessionKey: key }, profileId, undefined, key);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(404);
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      await response.arrayBuffer();
    } finally {
      release.resolve();
      await pending;
      read.mockRestore();
    }
  });

  it.each([
    {
      name: "weak quoted comma/star HEAD",
      validator: 'W/"client,*,tag"',
      expectedStatus: 200,
    },
    {
      name: "literal backslash before weak match",
      validator: (etag: string) => String.raw`"trailing\", W/` + etag,
      expectedStatus: 304,
    },
  ])("honors $name for workspace image responses", async ({ validator, expectedStatus }) => {
    await seedIcon();

    const first = await fetch(iconRoute("agent:main:one"));
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    await first.arrayBuffer();

    const response = await fetch(iconRoute("agent:main:one"), {
      method: "HEAD",
      headers: { "If-None-Match": typeof validator === "function" ? validator(etag) : validator },
    });
    expect(response.status).toBe(expectedStatus);
    expectHeaders(response, {
      etag,
      "content-disposition": 'attachment; filename="workspace-icon"',
      "content-length": expectedStatus === 304 ? null : String(PNG_BYTES.byteLength),
    });
    if (expectedStatus === 200) {
      expect(response.headers.get("content-type")).toBe("image/png");
    }
    await expectBody(response, Buffer.alloc(0));
  });

  it("refuses a session the profile cannot see without reading its workspace", async () => {
    authorizeMember("view");
    const key = "agent:main:one";
    const createdActor = { type: "human", source: "profile", id: "other" } as const;
    const root = await seedIcon(key, { visibility: "draft", createdActor });
    const open = vi.spyOn(boundaryFileRead, "openRootFile");
    const read = vi.spyOn(boundaryFileRead, "readFileDescriptorBounded");
    try {
      const response = await requestIcon(404);
      expectHeaders(response, { "cache-control": "no-store", etag: null });
      await response.arrayBuffer();
      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      read.mockRestore();
    }
    seedSession(root, key, { visibility: "shared", createdActor });
    await expectBody(await requestIcon(), PNG_BYTES);
  });

  it("briefly caches an authenticated 404 for a workspace with no icon", async () => {
    seedSession(await makeWorkspace({}));
    const response = await requestIcon(404);
    expectHeaders(response, {
      "cache-control": "private, max-age=60",
      vary: "Authorization, Cookie",
    });
  });

  it("serves a cold canonical session through its main alias without chat startup", async () => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    seedSession(root, "agent:main:main");
    const response = await requestIcon(200, "main");
    expectHeaders(response, {
      "content-type": "image/x-icon",
      "content-length": String(ICO_BYTES.byteLength),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": 'attachment; filename="workspace-icon"',
    });
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expectBody(response, ICO_BYTES);
  });

  it.each(["authority", "workspace"])(
    "rejects a changed %s during icon preparation",
    async (kind) => {
      await seedIcon();
      const replacement =
        kind === "workspace" ? await makeWorkspace({ "favicon.svg": SVG_BYTES }) : undefined;
      const held = holdIconRead();
      const pending = fetch(iconRoute("agent:main:one"));
      try {
        await held.reading;
        if (replacement) {
          seedSession(replacement, "agent:main:one", { sessionId: "replacement-session" });
        } else {
          authorityCurrent = false;
        }
        held.release();
        const response = await pending;
        expect(response.status).toBe(kind === "authority" ? 401 : 503);
        expectHeaders(response, { etag: null });
        if (kind === "authority") {
          expect(await response.json()).toEqual({
            error: { message: "Unauthorized", type: "unauthorized" },
          });
        } else {
          await response.arrayBuffer();
          await expectBody(await requestIcon(), SVG_BYTES);
        }
      } finally {
        held.release();
        await pending;
        held.restore();
      }
    },
  );

  it("never exposes a local decoy for a bound or stopped remote workspace", async () => {
    const root = await seedIcon();
    const release = registerAgentWorkspaceAccess(root, {
      bridge: {
        readFile: async () => {
          throw new Error("unexpected remote icon read");
        },
        writeFile: async () => {
          throw new Error("unexpected write");
        },
        stat: async () => null,
      },
    });
    try {
      for (const stopped of [false, true]) {
        if (stopped) {
          release();
        }
        const response = await requestIcon(404);
        expect(response.headers.get("etag")).toBeNull();
        await response.arrayBuffer();
      }
    } finally {
      release();
    }
  });

  it.each(["missing session", "unavailable projection"])(
    "recovers a %s without caching absence",
    async (kind) => {
      const key = kind === "missing session" ? "agent:main:new-session" : "agent:main:one";
      const ready = projection;
      if (kind === "unavailable projection") {
        await seedIcon(key);
        projection = undefined;
      }
      try {
        const response = await requestIcon(kind === "missing session" ? 404 : 503, key);
        if (kind === "unavailable projection") {
          expectHeaders(response, { "cache-control": "no-store", "retry-after": "1" });
        }
        await response.arrayBuffer();
      } finally {
        projection = ready;
      }
      if (kind === "missing session") {
        await seedIcon(key);
      }
      await expectBody(await requestIcon(200, key), PNG_BYTES);
    },
  );

  it.each(["exec-node", "pending checkout", "repository-owned"])(
    "never reads a local decoy for a %s workspace",
    async (kind) => {
      const key = "agent:main:one";
      let fields: Partial<InternalSessionEntry>;
      if (kind === "repository-owned") {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: key,
          url: "https://example.test/project.git",
          assertCurrent: () => {},
        });
        fields = { repositoryWorkspaceId: repository.workspaceId };
      } else {
        fields =
          kind === "exec-node"
            ? { execNode: "remote-node" }
            : { spawnedCwd: undefined, pendingWorktree: { titleSource: "Pending" } };
      }
      await seedIcon(key, fields);
      const reads = vi.spyOn(boundaryFileRead, "openRootFile");
      const response = await requestIcon(404, key);
      expectHeaders(response, { "cache-control": "no-store" });
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/__openclaw__/workspace-icon/", "GET", 404, null],
    ["/__openclaw__/plugin-icon/x", "GET", 418, null],
    ["/__openclaw__/workspace-icon/agent:main:one", "POST", 405, "GET, HEAD"],
  ] as const)("routes %s %s", async (pathname, method, status, allow) => {
    const response = await fetch(`${origin}${pathname}`, { method });
    expect(response.status).toBe(status);
    if (allow) {
      expectHeaders(response, { allow });
    }
  });

  it("never reads a workspace when authorization answers 401", async () => {
    await seedIcon("agent:main:hidden");
    const reads = vi.spyOn(boundaryFileRead, "openRootFile");
    // `sessions.list` hides incognito and non-owner draft sessions per client.
    // Without that filter here, the read scope alone would let a caller who
    // knows such a key pull bytes derived from a session it cannot list.
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = 401;
        params.res.end();
        return null;
      },
    );
    await requestIcon(401, "agent:main:hidden");
    expect(reads).not.toHaveBeenCalled();
  });
});
