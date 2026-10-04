import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeRegistry, NodeSession } from "../node-registry.js";
import { createDesktopComputerInputGuard } from "./computer-control.js";
import { DesktopCredentialsRequiredError } from "./host-source-errors.js";
import type { NodeDesktopStreamBroker } from "./node-stream-broker.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import type { DesktopObserveRequester } from "./observe-requester.js";
import type { RfbPreauthDescriptor } from "./rfb-preauth.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

type ActiveNodeDesktopStream = ReturnType<DesktopSessionRegistry["createStream"]>;

type ComputerBinding = {
  guard: ReturnType<typeof createDesktopComputerInputGuard>;
  release(): void;
  timer?: ReturnType<typeof setTimeout>;
  pending: number;
};

type NodeDesktopSession = {
  connId: string;
  pairingGeneration: string;
  ownerEpoch: number;
  active: Set<ActiveNodeDesktopStream>;
  computers: Map<string, ComputerBinding>;
};

/** Combines node command policy, ticket redemption, and desktop session ownership. */
export function createNodeDesktopService(params: {
  getConfig: () => OpenClawConfig;
  nodeRegistry: NodeRegistry;
  desktopRegistry: DesktopSessionRegistry;
  streamBroker: NodeDesktopStreamBroker;
}) {
  const ownerEpochs = new Map<string, number>();
  const sessions = new Map<string, NodeDesktopSession>();

  const commandAllowed = (node: NodeSession) =>
    isNodeCommandAllowed({
      command: NODE_DESKTOP_STREAM_COMMAND,
      declaredCommands: node.commands,
      allowlist: resolveNodeCommandAllowlist(params.getConfig(), node),
    }).ok;

  const stopNode = (nodeId: string): Promise<void> => params.desktopRegistry.stop(`node:${nodeId}`);

  const ensureSession = async (request: {
    nodeId: string;
    connId: string;
    pairingGeneration: string;
  }): Promise<NodeDesktopSession> => {
    const sourceKey = `node:${request.nodeId}`;
    const current = sessions.get(request.nodeId);
    if (
      current?.connId === request.connId &&
      current.pairingGeneration === request.pairingGeneration
    ) {
      await params.desktopRegistry.activate({
        sourceKey,
        ownerEpoch: current.ownerEpoch,
      });
      return current;
    }

    const ownerEpoch = (ownerEpochs.get(request.nodeId) ?? 0) + 1;
    ownerEpochs.set(request.nodeId, ownerEpoch);
    const session: NodeDesktopSession = {
      connId: request.connId,
      pairingGeneration: request.pairingGeneration,
      ownerEpoch,
      active: new Set(),
      computers: new Map(),
    };
    sessions.set(request.nodeId, session);
    try {
      await params.desktopRegistry.activate({
        sourceKey,
        ownerEpoch,
        teardown: async () => {
          if (sessions.get(request.nodeId) === session) {
            sessions.delete(request.nodeId);
          }
          for (const binding of session.computers.values()) {
            clearTimeout(binding.timer);
            binding.guard.dispose();
            binding.release();
          }
          session.computers.clear();
          await Promise.all([...session.active].map((active) => active.stop()));
          session.active.clear();
        },
      });
      return session;
    } catch (error) {
      if (sessions.get(request.nodeId) === session) {
        sessions.delete(request.nodeId);
      }
      throw error;
    }
  };

  return {
    stopNode,
    async beginComputerRequest(request: {
      nodeId: string;
      connId: string;
      pairingGeneration: string;
      owner: string;
      command: string;
      params: Record<string, unknown>;
      signal?: AbortSignal;
    }) {
      const node = params.nodeRegistry.get(request.nodeId);
      if (node?.connId !== request.connId || node.pairingGeneration !== request.pairingGeneration) {
        throw new Error("COMPUTER_STALE_OBSERVATION: node desktop connection changed");
      }
      const session = await ensureSession(request);
      const sourceKey = `node:${request.nodeId}`;
      const isCurrent = () => {
        const currentNode = params.nodeRegistry.get(request.nodeId);
        return (
          sessions.get(request.nodeId) === session &&
          currentNode?.connId === request.connId &&
          currentNode.pairingGeneration === request.pairingGeneration &&
          params.desktopRegistry.isOwnerEpochCurrent(sourceKey, session.ownerEpoch)
        );
      };
      if (!isCurrent()) {
        throw new Error("COMPUTER_STALE_OBSERVATION: node desktop connection changed");
      }
      const key = JSON.stringify([request.owner, request.params.executionId ?? null]);
      const close =
        request.command === "computer.act" && request.params.action === "__close_execution";
      let binding = session.computers.get(key);
      if (!binding && close) {
        return undefined;
      }
      if (!binding) {
        if (session.computers.size >= 64) {
          throw new Error("COMPUTER_HOST_BUSY: node desktop execution limit reached");
        }
        const activity = params.desktopRegistry.retainActivity(sourceKey, session.ownerEpoch);
        if (!activity) {
          throw new Error("COMPUTER_STALE_OBSERVATION: node desktop owner closed");
        }
        binding = {
          guard: createDesktopComputerInputGuard(
            {
              isCurrent: () => isCurrent() && activity.isCurrent(),
              hasController: () =>
                params.desktopRegistry.hasController(sourceKey, session.ownerEpoch),
              onControlChanged: (changed) =>
                params.desktopRegistry.onControlChanged(sourceKey, session.ownerEpoch, changed),
            },
            true,
          ),
          release: () => activity.release(),
          pending: 0,
        };
        session.computers.set(key, binding);
      }
      const owned = binding;
      const dispose = () => {
        clearTimeout(owned.timer);
        owned.guard.dispose();
        owned.release();
        if (session.computers.get(key) === owned) {
          session.computers.delete(key);
        }
      };
      const scheduleIdle = () => {
        if (owned.pending === 0 && session.computers.get(key) === owned) {
          owned.timer = setTimeout(dispose, 300_000);
          owned.timer.unref?.();
        }
      };
      clearTimeout(owned.timer);
      let operation: ReturnType<typeof owned.guard.begin> | undefined;
      try {
        operation = close
          ? undefined
          : owned.guard.begin(request.command, request.params, request.signal);
      } catch (error) {
        scheduleIdle();
        throw error;
      }
      owned.pending += 1;
      return {
        signal: operation?.signal ?? request.signal,
        assertCurrent() {
          if (!isCurrent()) {
            throw new Error("COMPUTER_STALE_OBSERVATION: node desktop connection changed");
          }
          operation?.assertCurrent();
        },
        complete: () => operation?.complete(),
        release() {
          operation?.release();
          owned.pending -= 1;
          if (close) {
            dispose();
          } else {
            scheduleIdle();
          }
        },
      };
    },
    async reconcileRuntimePolicy(): Promise<void> {
      await Promise.all(
        [...sessions].map(async ([nodeId, session]) => {
          const node = params.nodeRegistry.get(nodeId);
          if (
            !node ||
            node.connId !== session.connId ||
            node.pairingGeneration !== session.pairingGeneration ||
            !commandAllowed(node)
          ) {
            await stopNode(nodeId);
          }
        }),
      );
    },
    async observe(request: {
      nodeId: string;
      control: boolean;
      requester?: DesktopObserveRequester;
      credentials?: { username?: string; password?: string };
    }) {
      const node = params.nodeRegistry.get(request.nodeId);
      if (!node?.pairingGeneration) {
        throw new Error("node desktop is unavailable; reconnect and approve the node capability");
      }
      const pairingGeneration = node.pairingGeneration;
      const isRequesterCurrent = () =>
        !request.requester?.signal?.aborted && request.requester?.isCurrent() !== false;
      const isAuthorized = () =>
        params.nodeRegistry.get(request.nodeId) === node &&
        node.pairingGeneration === pairingGeneration &&
        commandAllowed(node);
      const assertAuthorized = () => {
        if (!isRequesterCurrent()) {
          throw new Error("Desktop observer connection is no longer current");
        }
        if (!isAuthorized()) {
          throw new Error(
            "node desktop is unavailable; enable Desktop Sharing on the node, approve its capability request, and check gateway.nodes.commands.deny",
          );
        }
      };
      assertAuthorized();

      const sourceKey = `node:${request.nodeId}`;
      const session = await ensureSession({
        nodeId: request.nodeId,
        connId: node.connId,
        pairingGeneration,
      });
      assertAuthorized();
      const active: ActiveNodeDesktopStream = params.desktopRegistry.createStream({
        sourceKey,
        ownerEpoch: session.ownerEpoch,
        onStopped: () => {
          session.active.delete(active);
        },
      });
      if (!active.reserve()) {
        throw new Error("node desktop observer limit reached");
      }
      const signal = request.requester?.signal
        ? AbortSignal.any([active.signal, request.requester.signal])
        : active.signal;
      session.active.add(active);
      try {
        const ticket = params.streamBroker.mint({
          nodeId: request.nodeId,
          connId: node.connId,
          pairingGeneration,
        });
        const attached = await active.connect(ticket, () =>
          params.nodeRegistry.invoke({
            nodeId: request.nodeId,
            expectedConnId: node.connId,
            expectedPairingGeneration: pairingGeneration,
            command: NODE_DESKTOP_STREAM_COMMAND,
            params: { ticket: ticket.ticket, attachPath: ticket.attachPath },
            timeoutMs: 0,
            onProgress: () => {},
            signal,
            // Pairing resolution yields before dispatch. Recheck this exact desktop
            // owner and live command policy at the transport's final admission edge.
            isDispatchAuthorized: () =>
              !active.stopped &&
              sessions.get(request.nodeId) === session &&
              isRequesterCurrent() &&
              isAuthorized(),
          }),
        );
        if (active.stopped || sessions.get(request.nodeId) !== session) {
          attached.stream.destroy();
          throw new Error("node desktop session was superseded before attachment");
        }
        assertAuthorized();

        let preauth: RfbPreauthDescriptor;
        if (attached.auth === "vnc-password") {
          const password = attached.vncPassword ?? request.credentials?.password;
          if (!password) {
            throw new DesktopCredentialsRequiredError(
              "vnc-password",
              "VNC password is required to observe this node",
            );
          }
          registerSecretValueForRedaction(password);
          preauth = { auth: attached.auth, credentials: { password } };
        } else {
          const username = request.credentials?.username?.trim() ?? "";
          const password = request.credentials?.password ?? "";
          if (!username || !password) {
            throw new DesktopCredentialsRequiredError(
              "ard-account",
              "macOS account credentials are required to observe this node",
            );
          }
          registerSecretValueForRedaction(password);
          preauth = { auth: attached.auth, credentials: { username, password } };
        }

        const attachment = active.publish();
        if (!attachment) {
          throw new Error("node desktop session was superseded before publication");
        }
        const minted = mintDesktopObserverToken({
          sourceKey,
          ownerEpoch: session.ownerEpoch,
          control: request.control,
          requester: request.requester,
          attachment,
          preauth,
          onAbandon: active.stop,
        });
        active.expireAt(minted.expiresAtMs);
        return {
          transport: "rfb" as const,
          wsPath: `/desktop/observe?token=${minted.token}`,
          expiresAtMs: minted.expiresAtMs,
          control: request.control,
          auth: attached.auth,
          preauthenticated: true as const,
        };
      } catch (error) {
        await active.stop();
        throw error;
      }
    },
  };
}

export type NodeDesktopService = ReturnType<typeof createNodeDesktopService>;
