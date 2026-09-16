import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  createHostDesktopService,
  createHostDesktopSource,
  inspectHostDesktop,
} from "./host-source.js";
import type { ManagedLinuxDesktop } from "./managed-linux.js";
import * as rfbProbe from "./rfb-probe.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function listenRfb(params: { banner?: string; securityTypes?: number[] }) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.write(Buffer.from(params.banner ?? "RFB 003.008\n", "ascii"));
    if (params.securityTypes) {
      socket.once("data", () => {
        socket.write(Buffer.from([params.securityTypes!.length, ...params.securityTypes!]));
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB server address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

function fakeManagedDesktop(
  status: ReturnType<ManagedLinuxDesktop["status"]> = { state: "not-started" },
) {
  let active = true;
  const leases = new Set<{ onStop(): Promise<void> }>();
  const acquire = vi.fn(async () => ({
    attachment: { kind: "tcp" as const, host: "127.0.0.1" as const, port: 46_001 },
    auth: "vnc-password" as const,
    vncPassword: "managed-secret",
  }));
  const acquireComputer = vi.fn(async (params: { onStop(): Promise<void> }) => {
    leases.add(params);
    return {
      env: { DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "unix:path=/managed/bus" },
      isCurrent: () => active && leases.has(params),
      release: () => {
        leases.delete(params);
      },
    };
  });
  const stop = vi.fn(async () => {
    active = false;
    await Promise.all([...leases].map(async (lease) => await lease.onStop()));
    leases.clear();
  });
  const managed: ManagedLinuxDesktop = { acquire, acquireComputer, stop, status: () => status };
  return { acquire, acquireComputer, managed, stop };
}

describe("gateway host desktop source", () => {
  it("refuses an unauthenticated VNC server", async () => {
    const port = await listenRfb({ securityTypes: [1] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `refusing unauthenticated VNC server on 127.0.0.1:${port}`,
    );
  });

  it("resolves a redacted password-file value separately from the loopback attachment", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-desktop-"));
    const passwordFile = path.join(root, "passwd");
    const password = "desktop-secret";
    await fs.writeFile(passwordFile, `${password}\n`);
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

    const source = createHostDesktopSource({
      config: { enabled: true, port, passwordFile },
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
    await expect(source.resolveVncPassword()).resolves.toBe(password);
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);
  });

  it("keeps the VncAuth credential prompt path when passwordFile is omitted", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
  });

  it.each([false, true])(
    "refreshes an external password on repeated reconnects during linger (managed configured: %s)",
    async (managedConfigured) => {
      vi.useFakeTimers();
      vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "rfb", securityTypes: [2] });
      const passwordFile = path.join(tempDirs.make("openclaw-host-desktop-"), "passwd");
      const registry = createDesktopSessionRegistry();
      const managed = fakeManagedDesktop();
      const service = createHostDesktopService({
        config: { enabled: true, managed: managedConfigured, port: 5901, passwordFile },
        platform: "linux",
        registry,
        managedDesktop: managed.managed,
      });
      cleanups.push(() => registry.stopAll());
      const close = vi.fn();

      for (const password of ["first-secret", "second-secret", "third-secret"]) {
        await fs.writeFile(passwordFile, `${password}\n`);
        const observed = await service.observe({ control: true });
        expect(observed.vncPassword).toBe(password);
        expect(isSecretValueRegisteredForRedaction(password)).toBe(true);
        const observer = registry.attachObserver("host", { control: true, ownerEpoch: 0, close });
        expect(observer).toBeDefined();
        observer?.release();
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(close).not.toHaveBeenCalled();
      expect(managed.acquire).not.toHaveBeenCalled();
      expect(managed.stop).not.toHaveBeenCalled();
    },
  );

  it("keeps a managed desktop's password and active computer when observing again", async () => {
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
    const passwordFile = path.join(tempDirs.make("openclaw-host-desktop-"), "passwd");
    await fs.writeFile(passwordFile, "external-secret");
    const registry = createDesktopSessionRegistry();
    const managed = fakeManagedDesktop();
    const service = createHostDesktopService({
      config: { enabled: true, managed: true, passwordFile },
      platform: "linux",
      registry,
      managedDesktop: managed.managed,
    });
    cleanups.push(() => registry.stopAll());
    const computer = await service.acquireComputer({ onStop: vi.fn(async () => undefined) });

    await expect(service.observe({ control: false })).resolves.toMatchObject({
      vncPassword: "managed-secret",
    });
    await fs.writeFile(passwordFile, "rotated-external-secret");
    await expect(service.observe({ control: true })).resolves.toMatchObject({
      vncPassword: "managed-secret",
    });

    expect(managed.acquire).toHaveBeenCalledOnce();
    expect(managed.stop).not.toHaveBeenCalled();
    expect(computer.isCurrent()).toBe(true);
    computer.release();
  });

  it.each(["stop", "revoke"] as const)(
    "rejects a pending reconnect when its owner is invalidated by %s",
    async (invalidation) => {
      vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "rfb", securityTypes: [2] });
      const passwordFile = path.join(tempDirs.make("openclaw-host-desktop-"), "passwd");
      await fs.writeFile(passwordFile, "first-secret");
      const registry = createDesktopSessionRegistry();
      const service = createHostDesktopService({
        config: { enabled: true, port: 5901, passwordFile },
        registry,
      });
      cleanups.push(() => registry.stopAll());
      let current = true;
      const requester = { isCurrent: () => current };
      await service.observe({ control: false, requester });

      const reading = createDeferred();
      const password = createDeferred<string>();
      vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
        reading.resolve();
        return await password.promise;
      });
      const observing = service.observe({ control: true, requester });
      await reading.promise;
      if (invalidation === "stop") {
        await registry.stop("host", 0);
      } else {
        current = false;
      }
      password.resolve("second-secret");
      await expect(observing).rejects.toThrow(
        invalidation === "stop"
          ? "Desktop session stopped"
          : "desktop observer authority was revoked",
      );
    },
  );

  it("reports a missing password file on reconnect without reusing the previous credential", async () => {
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "rfb", securityTypes: [2] });
    const passwordFile = path.join(tempDirs.make("openclaw-host-desktop-"), "passwd");
    await fs.writeFile(passwordFile, "first-secret");
    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      config: { enabled: true, port: 5901, passwordFile },
      registry,
    });
    cleanups.push(() => registry.stopAll());
    await service.observe({ control: false });
    await fs.unlink(passwordFile);

    await expect(service.observe({ control: false })).rejects.toThrow(
      "could not read desktop.host.passwordFile",
    );
  });

  it("attaches ARD and keeps account credentials only in the observer token", async () => {
    const port = await listenRfb({ banner: "RFB 003.889\n", securityTypes: [30] });
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "darwin",
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "ard-account",
    });

    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      config: { enabled: true, port },
      platform: "darwin",
      registry,
    });
    cleanups.push(async () => registry.stopAll());
    await expect(service.observe({ control: false })).rejects.toThrow(
      "macOS account credentials are required",
    );
    const password = "mac-account-password";
    const observed = await service.observe({
      control: false,
      credentials: { username: "operator", password },
    });
    expect(observed).toMatchObject({ auth: "ard-account", control: false });
    expect(observed).not.toHaveProperty("vncPassword");
    expect(observed.wsPath).toMatch(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u);
    expect(observed.wsPath).not.toContain("operator");
    expect(observed.wsPath).not.toContain(password);
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);

    await expect(
      inspectHostDesktop({ config: { enabled: true, port }, platform: "darwin" }),
    ).resolves.toMatchObject({
      status: { state: "attached", security: "ARD" },
      detail: `attached (127.0.0.1:${port}, security: ARD)`,
    });
  });

  it("still refuses VeNCrypt", async () => {
    const port = await listenRfb({ securityTypes: [19] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow("VeNCrypt is not supported");
  });

  it("reports a non-VNC occupant and the port config next step", async () => {
    const port = await listenRfb({ banner: "HTTP/1.1 200" });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `desktop.host.port ${port} is occupied by a non-VNC service; configure desktop.host.port`,
    );
  });

  it("reports unreachable Linux setup guidance", async () => {
    const port = await unusedPort();
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "linux",
    });
    await expect(source.acquire()).rejects.toThrow("apt install tigervnc-standalone-server");
  });

  it("keeps an explicitly configured port ahead of managed mode", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true, port },
      platform: "linux",
      managedDesktop: managed.managed,
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
    await expect(source.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
      "selected host desktop is an external VNC server",
    );
    expect(managed.acquireComputer).not.toHaveBeenCalled();
  });

  it("keeps a default-port RFB listener ahead of managed mode", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
    await expect(source.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
      "selected host desktop is an external VNC server",
    );
    expect(managed.acquireComputer).not.toHaveBeenCalled();
  });

  it("starts managed mode only on Linux after the default port is unreachable", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
    await expect(source.acquire()).resolves.toMatchObject({
      attachment: { host: "127.0.0.1", port: 46_001 },
      auth: "vnc-password",
    });
    expect(managed.acquire).toHaveBeenCalledOnce();
    const onStop = vi.fn(async () => undefined);
    const computer = await source.acquireComputer({ onStop });
    expect(computer.env.DISPLAY).toBe(":99");
    expect(computer.isCurrent()).toBe(true);
    await source.teardown?.();
    expect(computer.isCurrent()).toBe(false);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps computer activity alive after all eight observers detach, then expires after release", async () => {
    vi.useFakeTimers();
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
    const managed = fakeManagedDesktop();
    const registry = createDesktopSessionRegistry({ lingerMs: 10 });
    const service = createHostDesktopService({
      config: { enabled: true, managed: true },
      platform: "linux",
      registry,
      managedDesktop: managed.managed,
    });
    cleanups.push(() => registry.stopAll());
    const computer = await service.acquireComputer({ onStop: async () => undefined });
    await service.observe({ control: false });
    const observers = Array.from({ length: 8 }, () =>
      registry.attachObserver("host", {
        control: false,
        ownerEpoch: 0,
        close: vi.fn(),
      }),
    );
    expect(observers.every(Boolean)).toBe(true);
    for (const observer of observers) {
      observer?.release();
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(managed.stop).not.toHaveBeenCalled();
    expect(computer.isCurrent()).toBe(true);
    computer.release();
    await vi.advanceTimersByTimeAsync(20);
    expect(managed.stop).toHaveBeenCalled();
    expect(computer.isCurrent()).toBe(false);
  });

  it("reports managed mode as Linux-only on other platforms", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "darwin",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
    await expect(source.acquire()).rejects.toThrow(
      "desktop.host.managed is available only on Linux",
    );
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "darwin",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toMatchObject({
      status: { state: "unavailable" },
      detail: expect.stringContaining("available only on Linux"),
    });
  });

  it("reports managed lifecycle states without exposing password material", async () => {
    const managed = fakeManagedDesktop({ state: "running", display: 99, port: 46_001 });
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "running",
        display: 99,
        port: 46_001,
        security: "VncAuth",
      },
      detail: "managed (running, display :99, port 46001, security: VncAuth)",
    });
  });

  it("does not infer process-local managed state from standalone inspection", async () => {
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "unknown",
        port: 5900,
      },
      detail: "managed (configured; runtime state is available from the running Gateway status)",
    });
  });
});
