import { createHash } from "node:crypto";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  allocatePluginStateNamespaceCreatedAt,
  deletePluginStateEntry,
  iteratePluginStateEntries,
  parseStoredJson,
  RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX,
  selectPluginStateEntry,
} from "../../plugin-state/plugin-state-store.kernel.js";
import { registerPluginStateEntry } from "../../plugin-state/plugin-state-store.retention.js";
import { prepareRegisterParams } from "../../plugin-state/plugin-state-store.validation.js";
import { CRON_MIGRATION_MAX_SNAPSHOT_BYTES } from "../migration-snapshot.js";

export type MigrationStatus =
  | "held"
  | "exported"
  | "staged"
  | "activated"
  | "resumed"
  | "retired"
  | "aborted";
export type MigrationRecord = {
  store_key: string;
  operation_id: string;
  agent_ids_json: string;
  status: MigrationStatus;
  snapshot_json: string | null;
  snapshot_digest: string | null;
};
export type MigrationFence = { store_key: string; agent_id: string; operation_id: string };
type StoredMigration = Omit<MigrationRecord, "snapshot_json"> & {
  snapshot_chunks: number;
  snapshot_content_sha256: string | null;
};

const pluginId = "core:cron-custody";
const operationNamespace = `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}cron-custody.operations`;
const fenceNamespace = `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}cron-custody.fences`;
const snapshotNamespace = `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}cron-custody.snapshots`;
const importNamespace = `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}cron-custody.import`;
const chunkBytes = 512 * 1024;
const maxEncodedChunkLength = Math.ceil(chunkBytes / 3) * 4;
const key = (...parts: (string | number)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const scope = (namespace: string) => ({ pluginId, namespace });
const partition = (namespace: string, storeKey: string) => `${namespace}.${key(storeKey)}`;

function read(db: EngineConnection, namespace: string, entryKey: string): unknown {
  const row = selectPluginStateEntry(db, { ...scope(namespace), key: entryKey, now: 0 });
  if (!row) {
    return undefined;
  }
  if (row.expires_at !== null) {
    throw new Error("Cron custody state must not expire");
  }
  return parseStoredJson(row.value_json, "lookup", "cron custody");
}

function write(
  db: EngineConnection,
  namespace: string,
  entryKey: string,
  value: unknown,
  createdAt?: number,
): void {
  const previous = selectPluginStateEntry(db, { ...scope(namespace), key: entryKey, now: 0 });
  const prepared = prepareRegisterParams(entryKey, value, undefined, undefined, namespace);
  registerPluginStateEntry(
    { db, path: "cron custody" },
    {
      ...scope(namespace),
      key: entryKey,
      valueJson: prepared.valueJson,
      maxEntries: undefined,
      overflowPolicy: "evict-oldest",
      createdAtMs:
        createdAt ??
        previous?.created_at ??
        allocatePluginStateNamespaceCreatedAt(db, {
          ...scope(namespace),
          now: Date.now(),
        }),
    },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMigrationStatus(value: unknown): value is MigrationStatus {
  return (
    typeof value === "string" &&
    ["held", "exported", "staged", "activated", "resumed", "retired", "aborted"].includes(value)
  );
}

function migration(value: unknown): StoredMigration {
  if (
    !isObject(value) ||
    typeof value.store_key !== "string" ||
    typeof value.operation_id !== "string" ||
    typeof value.agent_ids_json !== "string" ||
    !isMigrationStatus(value.status) ||
    !(value.snapshot_digest === null || typeof value.snapshot_digest === "string") ||
    typeof value.snapshot_chunks !== "number" ||
    !Number.isSafeInteger(value.snapshot_chunks) ||
    value.snapshot_chunks < 0 ||
    value.snapshot_chunks > Math.ceil(CRON_MIGRATION_MAX_SNAPSHOT_BYTES / chunkBytes) ||
    !(
      value.snapshot_content_sha256 === null ||
      (typeof value.snapshot_content_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.snapshot_content_sha256))
    )
  ) {
    throw new Error("Invalid retained cron custody operation");
  }
  return {
    store_key: value.store_key,
    operation_id: value.operation_id,
    agent_ids_json: value.agent_ids_json,
    status: value.status,
    snapshot_digest: value.snapshot_digest,
    snapshot_chunks: value.snapshot_chunks,
    snapshot_content_sha256: value.snapshot_content_sha256,
  };
}

export function readCronMigrationMetadata(
  db: EngineConnection,
  storeKey: string,
  operationId: string,
): StoredMigration | undefined {
  const value = read(db, partition(operationNamespace, storeKey), key(storeKey, operationId));
  if (value === undefined) {
    return undefined;
  }
  const record = migration(value);
  if (record.store_key !== storeKey || record.operation_id !== operationId) {
    throw new Error("Cron custody operation key mismatch");
  }
  return record;
}

export function readCronMigration(
  db: EngineConnection,
  storeKey: string,
  operationId: string,
): MigrationRecord | undefined {
  const record = readCronMigrationMetadata(db, storeKey, operationId);
  if (!record) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let snapshotBytes = 0;
  for (let index = 0; index < record.snapshot_chunks; index++) {
    const chunk = read(db, snapshotNamespace, key(storeKey, operationId, index));
    if (typeof chunk !== "string") {
      throw new Error("Cron custody snapshot is incomplete");
    }
    if (chunk.length > maxEncodedChunkLength) {
      throw new Error("Cron custody snapshot chunk exceeds the 512 KiB encoding");
    }
    const bytes = Buffer.from(chunk, "base64");
    if (bytes.toString("base64") !== chunk) {
      throw new Error("Cron custody snapshot chunk is invalid");
    }
    snapshotBytes += bytes.byteLength;
    if (bytes.byteLength > chunkBytes || snapshotBytes > CRON_MIGRATION_MAX_SNAPSHOT_BYTES) {
      throw new Error("Cron custody snapshot exceeds the 8 MiB transfer limit");
    }
    chunks.push(bytes);
  }
  const bytes = chunks.length ? Buffer.concat(chunks) : undefined;
  if (
    (bytes ? createHash("sha256").update(bytes).digest("hex") : null) !==
    record.snapshot_content_sha256
  ) {
    throw new Error("Cron custody snapshot digest mismatch");
  }
  const { snapshot_chunks: _chunks, snapshot_content_sha256: _digest, ...row } = record;
  return { ...row, snapshot_json: bytes?.toString("utf8") ?? null };
}

export function listCronMigrations(db: EngineConnection, storeKey: string): StoredMigration[] {
  return Array.from(
    iteratePluginStateEntries(db, { ...scope(partition(operationNamespace, storeKey)), now: 0 }),
    (row) => {
      if (row.expires_at !== null) {
        throw new Error("Cron custody state must not expire");
      }
      const record = migration(parseStoredJson(row.value_json, "entries", "cron custody"));
      if (record.store_key !== storeKey || row.entry_key !== key(storeKey, record.operation_id)) {
        throw new Error("Cron custody operation key mismatch");
      }
      return record;
    },
  );
}

export function writeCronMigration(
  db: EngineConnection,
  row: MigrationRecord,
  createdAt?: number,
): void {
  const entryKey = key(row.store_key, row.operation_id);
  const namespace = partition(operationNamespace, row.store_key);
  const previousValue = read(db, namespace, entryKey);
  const previous = previousValue === undefined ? undefined : migration(previousValue);
  const bytes = row.snapshot_json === null ? undefined : Buffer.from(row.snapshot_json);
  if (bytes && bytes.byteLength > CRON_MIGRATION_MAX_SNAPSHOT_BYTES) {
    throw new Error("Cron migration snapshot exceeds the 8 MiB transfer limit");
  }
  const count = bytes ? Math.max(1, Math.ceil(bytes.byteLength / chunkBytes)) : 0;
  for (let index = 0; index < Math.max(count, previous?.snapshot_chunks ?? 0); index++) {
    const chunkKey = key(row.store_key, row.operation_id, index);
    if (bytes && index < count) {
      write(
        db,
        snapshotNamespace,
        chunkKey,
        bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
      );
    } else {
      deletePluginStateEntry(db, { ...scope(snapshotNamespace), key: chunkKey });
    }
  }
  const { snapshot_json: _snapshot, ...metadata } = row;
  write(
    db,
    namespace,
    entryKey,
    {
      ...metadata,
      snapshot_chunks: count,
      snapshot_content_sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    },
    createdAt,
  );
}

export function readCronMigrationFence(
  db: EngineConnection,
  storeKey: string,
  agentId: string,
): MigrationFence | undefined {
  const value = read(db, partition(fenceNamespace, storeKey), key(storeKey, agentId));
  if (value === undefined) {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.store_key !== storeKey ||
    value.agent_id !== agentId ||
    typeof value.operation_id !== "string"
  ) {
    throw new Error("Invalid retained cron custody fence");
  }
  return { store_key: storeKey, agent_id: agentId, operation_id: value.operation_id };
}

export function listCronMigrationFences(db: EngineConnection, storeKey: string): MigrationFence[] {
  return Array.from(
    iteratePluginStateEntries(db, { ...scope(partition(fenceNamespace, storeKey)), now: 0 }),
    (row) => {
      const value = parseStoredJson(row.value_json, "entries", "cron custody");
      if (
        row.expires_at !== null ||
        !isObject(value) ||
        value.store_key !== storeKey ||
        typeof value.agent_id !== "string" ||
        typeof value.operation_id !== "string" ||
        row.entry_key !== key(storeKey, value.agent_id)
      ) {
        throw new Error("Invalid retained cron custody fence");
      }
      return { store_key: storeKey, agent_id: value.agent_id, operation_id: value.operation_id };
    },
  );
}

export function writeCronMigrationFence(db: EngineConnection, fence: MigrationFence): void {
  write(
    db,
    partition(fenceNamespace, fence.store_key),
    key(fence.store_key, fence.agent_id),
    fence,
  );
}

export function deleteCronMigrationFence(db: EngineConnection, fence: MigrationFence): void {
  deletePluginStateEntry(db, {
    ...scope(partition(fenceNamespace, fence.store_key)),
    key: key(fence.store_key, fence.agent_id),
  });
}

export function readCronMigrationImport(db: EngineConnection): unknown {
  return read(db, importNamespace, "legacy-pair");
}

export function writeCronMigrationImport(db: EngineConnection, value: unknown): void {
  write(db, importNamespace, "legacy-pair", value);
}
