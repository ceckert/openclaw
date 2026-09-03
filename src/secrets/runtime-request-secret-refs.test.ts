/** Tests request-scoped secret ref resolution for runtime operations. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { getRuntimeConfigSnapshotRefreshHandler } from "../config/runtime-snapshot.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshotForConfigWrite,
} from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

async function writeSecureFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

describe("secrets runtime snapshot request secret refs", () => {
  it("does not reuse active environment state for a newly introduced missing SecretRef", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_CONFIG_WRITE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      includeAuthStoreRefs: false,
    });
    activateSecretsRuntimeSnapshot(snapshot);

    await expect(
      prepareSecretsRuntimeSnapshotForConfigWrite({
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: missingEnvVar },
            },
          },
        }),
        includeAuthStoreRefs: false,
      }),
    ).rejects.toThrow(`Environment variable "${missingEnvVar}" is missing or empty.`);
  });

  it("can skip auth-profile SecretRef resolution when includeAuthStoreRefs is false", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    const loadAuthStore = () =>
      loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          tokenRef: { source: "env", provider: "default", id: missingEnvVar },
        },
      });

    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore,
      }),
    ).rejects.toThrow(`Environment variable "${missingEnvVar}" is missing or empty.`);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      includeAuthStoreRefs: false,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore,
    });

    expect(snapshot.authStores).toStrictEqual([]);
  });

  it("can skip auth-profile SecretRef resolution during active runtime refresh", async () => {
    const initialEnvVar = `OPENCLAW_INITIAL_AUTH_PROFILE_SECRET_${Date.now()}`;
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    let useMissingProfileRef = false;
    let loadAuthStoreCalls = 0;
    const loadAuthStore = () => {
      loadAuthStoreCalls += 1;
      return loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          tokenRef: {
            source: "env",
            provider: "default",
            id: useMissingProfileRef ? missingEnvVar : initialEnvVar,
          },
        },
      });
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: { [initialEnvVar]: "sk-initial" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore,
    });
    activateSecretsRuntimeSnapshot(snapshot);
    expect(loadAuthStoreCalls).toBe(1);
    setRuntimeAuthProfileStoreSnapshot(
      loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          token: "sk-live",
        },
      }),
      "/tmp/openclaw-agent-main",
    );

    useMissingProfileRef = true;
    const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    if (!refreshHandler) {
      throw new Error("Expected active runtime refresh handler");
    }
    await expect(
      refreshHandler.refresh({
        sourceConfig: asConfig({ gateway: { port: 19001 } }),
        includeAuthStoreRefs: false,
      }),
    ).resolves.toBe(true);
    expect(loadAuthStoreCalls).toBe(1);
    const profile = getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[
      "custom:token"
    ] as { token?: string } | undefined;
    expect(profile?.token).toBe("sk-live");
  });

  it.skipIf(process.platform === "win32")(
    "reuses active exec SecretRef values when an unrelated config field changes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-exec-preflight-"));
      try {
        const execLogPath = path.join(root, "exec-calls.log");
        const execScriptPath = path.join(root, "resolver.sh");
        await writeSecureFile(
          execScriptPath,
          [
            "#!/bin/sh",
            `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
            "cat >/dev/null",
            'printf \'{"protocolVersion":1,"values":{"gateway/token":"exec-gateway-token"}}\'',
          ].join("\n"),
          0o700,
        );

        const config = asConfig({
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: execScriptPath,
                jsonOnly: true,
                timeoutMs: 20_000,
                noOutputTimeoutMs: 10_000,
              },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "execmain", id: "gateway/token" },
            },
          },
        });
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          agentDirs: [path.join(root, "agent")],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        });
        activateSecretsRuntimeSnapshot(snapshot);
        await fs.writeFile(execLogPath, "", "utf8");

        const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
        if (!refreshHandler?.preflight) {
          throw new Error("Expected active runtime refresh preflight handler");
        }
        const nextConfig = asConfig({
          ...config,
          gateway: {
            ...config.gateway,
            port: 19001,
          },
        });
        const preflightResult = await refreshHandler.preflight({ sourceConfig: nextConfig });
        await expect(
          refreshHandler.refresh({ sourceConfig: nextConfig, preflightResult }),
        ).resolves.toBe(true);

        const execCalls = (await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean);
        expect(execCalls).toHaveLength(0);
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
          "exec-gateway-token",
        );
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.port).toBe(19001);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reuses auth-store exec SecretRef values when an unrelated config field changes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-authstore-reuse-"));
      try {
        const execLogPath = path.join(root, "exec-calls.log");
        const execScriptPath = path.join(root, "resolver.sh");
        await writeSecureFile(
          execScriptPath,
          [
            "#!/bin/sh",
            `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
            "cat >/dev/null",
            'printf \'{"protocolVersion":1,"values":{"broker/model-key":"broker-model-key"}}\'',
          ].join("\n"),
          0o700,
        );

        const config = asConfig({
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: execScriptPath,
                jsonOnly: true,
                timeoutMs: 20_000,
                noOutputTimeoutMs: 10_000,
              },
            },
          },
        });
        const loadAuthStore = () =>
          loadAuthStoreWithProfiles({
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              keyRef: { source: "exec", provider: "execmain", id: "broker/model-key" },
            },
          });
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          agentDirs: [path.join(root, "agent")],
          loadAuthStore,
        });
        activateSecretsRuntimeSnapshot(snapshot);
        expect((await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(
          1,
        );
        await fs.writeFile(execLogPath, "", "utf8");

        const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
        if (!refreshHandler?.preflight) {
          throw new Error("Expected active runtime refresh preflight handler");
        }
        const nextConfig = asConfig({
          ...config,
          gateway: { port: 19002 },
        });
        const preflightResult = await refreshHandler.preflight({ sourceConfig: nextConfig });
        await expect(
          refreshHandler.refresh({ sourceConfig: nextConfig, preflightResult }),
        ).resolves.toBe(true);

        const execCalls = (await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean);
        expect(execCalls).toHaveLength(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves a changed exec SecretRef and leaves the active snapshot untouched when it fails",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-exec-changed-"));
      try {
        const execLogPath = path.join(root, "exec-calls.log");
        const execScriptPath = path.join(root, "resolver.sh");
        await writeSecureFile(
          execScriptPath,
          [
            "#!/bin/sh",
            `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
            "cat >/dev/null",
            'printf \'{"protocolVersion":1,"values":{"gateway/token":"exec-gateway-token"}}\'',
          ].join("\n"),
          0o700,
        );

        const config = asConfig({
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command: execScriptPath,
                jsonOnly: true,
                timeoutMs: 20_000,
                noOutputTimeoutMs: 10_000,
              },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "execmain", id: "gateway/token" },
            },
          },
        });
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          agentDirs: [path.join(root, "agent")],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        });
        activateSecretsRuntimeSnapshot(snapshot);
        await fs.writeFile(execLogPath, "", "utf8");

        const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
        if (!refreshHandler?.preflight) {
          throw new Error("Expected active runtime refresh preflight handler");
        }
        const changedRefConfig = asConfig({
          ...config,
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "execmain", id: "gateway/token-next" },
            },
          },
        });
        await expect(refreshHandler.preflight({ sourceConfig: changedRefConfig })).rejects.toThrow(
          /gateway\/token-next/,
        );

        const execCalls = (await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean);
        expect(execCalls).toHaveLength(1);
        expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(config);
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
          "exec-gateway-token",
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "invalidates active exec values when the provider configuration changes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-exec-provider-"));
      try {
        const execLogPath = path.join(root, "exec-calls.log");
        const execScriptPath = path.join(root, "resolver.sh");
        await writeSecureFile(
          execScriptPath,
          [
            "#!/bin/sh",
            `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
            "cat >/dev/null",
            'printf \'{"protocolVersion":1,"values":{"gateway/token":"exec-gateway-token"}}\'',
          ].join("\n"),
          0o700,
        );

        const providerConfig = {
          source: "exec",
          command: execScriptPath,
          jsonOnly: true,
          timeoutMs: 20_000,
          noOutputTimeoutMs: 10_000,
        };
        const config = asConfig({
          secrets: {
            providers: { execmain: providerConfig },
          },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "execmain", id: "gateway/token" },
            },
          },
        });
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          agentDirs: [path.join(root, "agent")],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        });
        activateSecretsRuntimeSnapshot(snapshot);
        await fs.writeFile(execLogPath, "", "utf8");

        const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
        if (!refreshHandler?.preflight) {
          throw new Error("Expected active runtime refresh preflight handler");
        }
        const changedProviderConfig = asConfig({
          ...config,
          secrets: {
            providers: {
              execmain: { ...providerConfig, timeoutMs: 25_000 },
            },
          },
        });
        const preflightResult = await refreshHandler.preflight({
          sourceConfig: changedProviderConfig,
        });
        await expect(
          refreshHandler.refresh({ sourceConfig: changedProviderConfig, preflightResult }),
        ).resolves.toBe(true);

        const execCalls = (await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean);
        expect(execCalls).toHaveLength(1);
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
          "exec-gateway-token",
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("resolves model provider request secret refs for headers, auth, and tls material", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              headers: {
                "X-Tenant": { source: "env", provider: "default", id: "OPENAI_PROVIDER_TENANT" },
              },
              auth: {
                mode: "authorization-bearer",
                token: { source: "env", provider: "default", id: "OPENAI_PROVIDER_TOKEN" },
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:8080",
                tls: {
                  ca: { source: "env", provider: "default", id: "OPENAI_PROVIDER_PROXY_CA" },
                },
              },
              tls: {
                cert: { source: "env", provider: "default", id: "OPENAI_PROVIDER_CERT" },
                key: { source: "env", provider: "default", id: "OPENAI_PROVIDER_KEY" },
              },
            },
            models: [],
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        OPENAI_PROVIDER_TENANT: "tenant-acme",
        OPENAI_PROVIDER_TOKEN: "sk-provider-runtime", // pragma: allowlist secret
        OPENAI_PROVIDER_PROXY_CA: "proxy-ca",
        OPENAI_PROVIDER_CERT: "client-cert",
        OPENAI_PROVIDER_KEY: "client-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.models?.providers?.openai?.request).toEqual({
      headers: {
        "X-Tenant": "tenant-acme",
      },
      auth: {
        mode: "authorization-bearer",
        token: "sk-provider-runtime",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
      tls: {
        cert: "client-cert",
        key: "client-key",
      },
    });
  });

  it("resolves media request secret refs for provider headers, auth, and tls material", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  headers: {
                    "X-Shared-Tenant": {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_TENANT",
                    },
                  },
                  auth: {
                    mode: "header",
                    headerName: "x-shared-key",
                    value: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_MODEL_KEY",
                    },
                  },
                },
              },
              {
                provider: "deepgram",
                capabilities: ["audio"],
                request: {
                  auth: {
                    mode: "header",
                    headerName: "x-api-key",
                    value: { source: "env", provider: "default", id: "MEDIA_AUDIO_MODEL_KEY" },
                  },
                  proxy: {
                    mode: "explicit-proxy",
                    url: "http://proxy.example:8080",
                    tls: {
                      ca: { source: "env", provider: "default", id: "MEDIA_AUDIO_PROXY_CA" },
                    },
                  },
                },
              },
            ],
            audio: {
              enabled: true,
              request: {
                headers: {
                  "X-Tenant": { source: "env", provider: "default", id: "MEDIA_AUDIO_TENANT" },
                },
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "env", provider: "default", id: "MEDIA_AUDIO_TOKEN" },
                },
                tls: {
                  cert: { source: "env", provider: "default", id: "MEDIA_AUDIO_CERT" },
                },
              },
            },
          },
        },
      }),
      env: {
        MEDIA_SHARED_TENANT: "tenant-shared",
        MEDIA_SHARED_MODEL_KEY: "shared-model-key", // pragma: allowlist secret
        MEDIA_AUDIO_TENANT: "tenant-acme",
        MEDIA_AUDIO_TOKEN: "audio-token", // pragma: allowlist secret
        MEDIA_AUDIO_CERT: "client-cert",
        MEDIA_AUDIO_MODEL_KEY: "model-key", // pragma: allowlist secret
        MEDIA_AUDIO_PROXY_CA: "proxy-ca",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.tools?.media?.audio?.request?.headers?.["X-Tenant"]).toBe("tenant-acme");
    expect(snapshot.config.tools?.media?.audio?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "audio-token",
    });
    expect(snapshot.config.tools?.media?.audio?.request?.tls).toEqual({
      cert: "client-cert",
    });
    expect(snapshot.config.tools?.media?.models?.[0]?.request).toEqual({
      headers: {
        "X-Shared-Tenant": "tenant-shared",
      },
      auth: {
        mode: "header",
        headerName: "x-shared-key",
        value: "shared-model-key",
      },
    });
    expect(snapshot.config.tools?.media?.models?.[1]?.request).toEqual({
      auth: {
        mode: "header",
        headerName: "x-api-key",
        value: "model-key",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: {
          ca: "proxy-ca",
        },
      },
    });
  });
});
