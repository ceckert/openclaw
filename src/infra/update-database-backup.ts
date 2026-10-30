import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { z } from "zod";
import { resolveBackupAgentRoots } from "../commands/backup-shared.js";
import type { DoctorRehearsalDatabaseCoverage } from "../commands/doctor-rehearsal-databases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openClawStateDatabaseCache,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
  maintenanceOwnerMayCopySourcesInProcess,
} from "../state/openclaw-state-maintenance-context.js";
import {
  assertOpenClawSnapshotDeliveryQueuesEmpty,
  sanitizeOpenClawGlobalStateSnapshot,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { sanitizeClientCredentialSnapshot } from "./client-credential-snapshot.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import {
  ensureDurableDirectory,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteSnapshotSource } from "./sqlite-readonly-location.types.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import { UpdateStateDatabaseOwnerSchema } from "./update-candidate-paths.js";
import type { UpdateStateInspectionProgress } from "./update-candidate-state.diagnostics.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  UpdateStateSchemaInspectionPlanSchema,
} from "./update-candidate-state.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
} from "./update-candidate-state.sizes.js";
import {
  canonicalDatabaseInventory,
  inspectRestorableDatabaseFiles,
} from "./update-database-backup-inventory.js";
import { checkUpdateDatabaseBackupSpace } from "./update-database-backup-space.js";
import {
  readUnchangedUpdateDatabaseGeneration,
  type SqliteDatabaseGenerationReceipt,
} from "./update-database-generations.js";
import {
  readUpdatePhysicalDatabaseGenerations,
  readUpdatePhysicalDatabaseObservation,
  readUpdatePostgresDatabaseGenerations,
} from "./update-physical-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

export const UpdateDatabaseBackupSchema = z.object({
  captureScope: z.literal("local-files").optional(),
  directory: z.string(),
  databases: z.array(
    z.object({
      path: z.string(),
      snapshotPath: z.string(),
      userVersion: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      sizeBytes: z.number().int().nonnegative(),
      engine: z.literal("postgres").optional(),
      storeId: z.string().uuid().optional(),
      namespace: z.string().optional(),
      exportDirectory: z.string().optional(),
      localAnchor: z.object({ storeId: z.string().uuid(), namespace: z.string() }).optional(),
      sourceFile: z.object({ dev: z.string(), ino: z.string() }).optional(),
    }),
  ),
  pluginOwners: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        rootDir: z.string(),
        source: z.string(),
        origin: z.enum(["bundled", "global", "workspace", "config"]),
      }),
    )
    .optional(),
  missingPaths: z.array(z.string()),
  sourcePaths: z.array(z.string()),
  sourceGenerations: z.record(z.string(), z.string().nullable()),
  /** Manual original images held under maintenance custody; never automatic rollback authority. */
  originalCaptureSourcePaths: z.array(z.string()).optional(),
  databaseOwners: z
    .array(UpdateStateDatabaseOwnerSchema.and(z.object({ path: z.string() })))
    .optional(),
  warnings: z.array(z.string()),
});
export type UpdateDatabaseBackup = z.infer<typeof UpdateDatabaseBackupSchema> & {
  migration?: {
    name: string;
    backup: string;
    from: Record<string, string | null>;
    to: Record<string, string | null>;
  };
  restoreRefusal?: string;
};

type BackupInput = {
  captureScope?: "local-files";
  requireEmptyDeliveryQueues?: boolean;
  backupRoot: string;
  stateDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalPaths?: readonly string[];
  additionalFiles?: readonly string[];
  preserveSourceArtifacts?: boolean;
  integrityCheck?: "quick" | "full";
  /** Native migration owns the stopped Gateway until Doctor takes custody. */
  stopped?: boolean;
  postgresOffline?: boolean;
  pluginOwners?: UpdateDatabaseBackup["pluginOwners"];
};
type InspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

async function loadUpdateDatabaseBackupRuntime() {
  const [{ discoverBackupDatabasePaths }, { readBackupEngine }] = await Promise.all([
    import("./backup-sqlite-snapshot.js"),
    import("./database-engine/physical-store.js"),
  ]);
  return { discoverBackupDatabasePaths, readBackupEngine };
}

let backupRuntime: ReturnType<typeof loadUpdateDatabaseBackupRuntime> | undefined;

/** Resolve the backup's lazy modules before an updater replaces its own dist tree. */
export function prepareUpdateDatabaseBackupRuntime() {
  return (backupRuntime ??= loadUpdateDatabaseBackupRuntime());
}

/** Read-only capture; the caller separately decides whether automatic restoration is safe. */
export async function createUpdateDatabaseBackupInProcess(
  input: BackupInput & {
    stagingRoot: string;
    inspectionPlan: InspectionPlan;
    /** Exact families admitted by the owning Doctor before launching this backup child. */
    excludedDatabasePaths?: readonly string[];
    /** Source custody prepared by the parent only for manual original-state capture. */
    originalCaptureSourcePaths?: readonly string[];
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<UpdateDatabaseBackup> {
  const directory = await fs.realpath(`${input.backupRoot}.databases`);
  // Older parents strip owners from discovery before calling the candidate worker.
  // Compare the same admitted dialect; absent metadata must not become an inventory change.
  const inspectionPlan = input.inspectionPlan;
  const includeOwners = inspectionPlan.files.some(([, database]) => database.owners !== undefined);
  const localEnv = input.env ?? process.env;
  const sharedPath = resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(localEnv));
  const clientPath = resolvePathViaExistingAncestorSync(resolveClientCredentialStorePath(localEnv));
  const localPaths =
    input.captureScope === "local-files"
      ? new Set([
          sharedPath,
          clientPath,
          ...(await resolveBackupAgentRoots(input.config)).map((root) =>
            resolvePathViaExistingAncestorSync(root.databasePath),
          ),
        ])
      : undefined;
  const inventoryFor = (plan: InspectionPlan) =>
    canonicalDatabaseInventory(
      plan,
      includeOwners,
      input.additionalPaths,
      input.additionalFiles,
      input.excludedDatabasePaths,
      localPaths,
    );
  const inventory = await inventoryFor(inspectionPlan);
  const identities = await inspectRestorableDatabaseFiles(inventory.present);
  const { warnings } = await checkUpdateDatabaseBackupSpace(
    directory,
    await measureUpdateStateFiles(inventory.present),
    input,
  );
  const { buildBackupArchivePath } = await import("./backup-archive-path-policy.js");
  const { createStoppedSqliteSnapshot, createVerifiedSqliteSnapshot } =
    await import("./sqlite-snapshot.js");
  const { AGENT_FTS_SCHEMAS } = await import("../state/openclaw-agent-fts-schema.js");
  const databases: UpdateDatabaseBackup["databases"] = [];
  const sourceGenerations: UpdateDatabaseBackup["sourceGenerations"] = Object.fromEntries(
    inventory.missing.map((file) => [file, null]),
  );
  const readGeneration = async (
    file: string,
    observation?: ReturnType<typeof readUpdatePhysicalDatabaseObservation>,
    receipt?: SqliteDatabaseGenerationReceipt,
  ) => {
    try {
      if (observation) {
        if (!observation.generation.ok) {
          throw observation.generation.error;
        }
        return observation.engine?.engine === "postgres"
          ? (await readUpdatePostgresDatabaseGenerations([file], input.pluginOwners))[file]
          : (observation.generation.value ?? undefined);
      }
      const unchanged = receipt && readUnchangedUpdateDatabaseGeneration(file, receipt);
      return (
        unchanged ??
        (await readUpdatePhysicalDatabaseGenerations([file], input.pluginOwners))[file] ??
        undefined
      );
    } catch (error) {
      warnings.push(
        `Database write generation unavailable for ${file}: ${formatErrorMessageWithCode(error)}`,
      );
      return undefined;
    }
  };
  const { readBackupEngine, readBackupEngineImage } =
    await import("./database-engine/physical-store.js");
  const requestedOriginalSources = new Set(input.originalCaptureSourcePaths);
  const stoppedSources = new Set(
    inventory.present.filter(
      (file) =>
        input.stopped &&
        input.captureScope !== "local-files" &&
        !identities.has(`${file}-journal`) &&
        (identities.get(`${file}-wal`)?.size ?? 0n) === 0n,
    ),
  );
  // The inventory gate can yield before every image is consumed. Retain the whole
  // interval so signal cleanup cannot retire a later family's staging token.
  return retainSnapshotWork(
    Promise.resolve().then(async () => {
      const heldImages = new Set<PreparedSqliteSnapshotSource>();
      let failed: { cause: unknown } | undefined;
      try {
        const observations = new Map<
          string,
          ReturnType<typeof readUpdatePhysicalDatabaseObservation>
        >();
        // Reuse classification from the generation image; only a failed acquisition needs
        // an engine-only image. PostgreSQL access still waits for the inventory custody gate.
        const engines = new Map(
          inventory.present
            .filter((file) => !stoppedSources.has(file))
            .map((file) => {
              const observation =
                !input.stopped && !requestedOriginalSources.has(file)
                  ? readUpdatePhysicalDatabaseObservation(file, input.stagingRoot)
                  : undefined;
              if (observation) {
                observations.set(file, observation);
                if (observation.preparedSource) {
                  heldImages.add(observation.preparedSource);
                }
              }
              return [file, observation?.engine ?? readBackupEngine(file)];
            }),
        );
        if (
          localPaths &&
          (!inventory.present.includes(sharedPath) ||
            !inventory.present.includes(clientPath) ||
            engines.get(sharedPath)?.engine !== "sqlite" ||
            inventory.present.some(
              (file) =>
                file !== sharedPath &&
                file !== clientPath &&
                engines.get(file)?.engine !== "postgres",
            ))
        ) {
          throw new Error(
            "Local checkpoints require a matched SQLite global/client pair and PostgreSQL agent anchors. Use backup create for other database layouts.",
          );
        }
        const originalCaptureSources = new Set(
          input.originalCaptureSourcePaths?.filter(
            (file) => engines.get(file)?.engine === "sqlite",
          ),
        );
        if (
          [...engines.values()].some((engine) => engine.engine === "postgres") &&
          input.captureScope !== "local-files" &&
          !input.postgresOffline &&
          !input.stopped
        ) {
          throw new Error(
            "PostgreSQL update capture requires exclusive ownership; stop through the service owner, then rerun.",
          );
        }
        for (const sourcePath of inventory.present) {
          input.onProgress?.({ phase: "pre-migration database backup", path: sourcePath });
          const archivePath = buildBackupArchivePath("", sourcePath);
          let parent = directory;
          for (const component of path.posix.dirname(archivePath).split("/")) {
            parent = path.join(parent, component);
            await ensureDurableDirectory({
              directoryPath: parent,
              create: createPrivateSqliteDirectory,
            });
          }
          const snapshotPath = path.join(directory, archivePath);
          const retainGeneration =
            !input.stopped &&
            !originalCaptureSources.has(sourcePath) &&
            !(
              input.captureScope === "local-files" && engines.get(sourcePath)?.engine === "postgres"
            );
          const before = retainGeneration
            ? await readGeneration(sourcePath, observations.get(sourcePath))
            : undefined;
          const preparedSource = observations.get(sourcePath)?.preparedSource;
          if (preparedSource) {
            // Publication now owns cleanup, including refusal before its first write.
            heldImages.delete(preparedSource);
          }
          const snapshot = stoppedSources.has(sourcePath)
            ? await createStoppedSqliteSnapshot({
                sourcePath,
                targetPath: snapshotPath,
                sourceIdentity: identities.get(sourcePath)!,
              })
            : await createVerifiedSqliteSnapshot({
                sourcePath,
                targetPath: snapshotPath,
                sourceAcquisition: {
                  mode: "isolated-process",
                  stagingRoot: input.stagingRoot,
                  preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
                  preparedSource,
                },
                preserveRowIds: input.captureScope !== "local-files",
                transform:
                  input.captureScope === "local-files"
                    ? (database) => {
                        if (sourcePath === sharedPath) {
                          if (input.requireEmptyDeliveryQueues) {
                            assertOpenClawSnapshotDeliveryQueuesEmpty(database);
                          }
                          sanitizeOpenClawGlobalStateSnapshot(database);
                        }
                        if (sourcePath === clientPath) {
                          sanitizeClientCredentialSnapshot(database);
                        }
                      }
                    : undefined,
                requireNonEmptySource: true,
                // Owned FTS indexes are derived; whichever runtime admits this copy rebuilds them.
                integrity:
                  engines.get(sourcePath)?.engine === "sqlite"
                    ? { check: input.integrityCheck ?? "full", ftsSchemas: AGENT_FTS_SCHEMAS }
                    : undefined,
              });
          // Checkpointed stopped stores already have a private image; classify that image
          // instead of copying and comparing the complete source again just for its anchor.
          const engine = engines.get(sourcePath) ?? readBackupEngineImage(snapshotPath, sourcePath);
          if (requestedOriginalSources.has(sourcePath) && engine.engine === "sqlite") {
            originalCaptureSources.add(sourcePath);
          }
          let postgres;
          if (engine.engine === "postgres" && input.captureScope !== "local-files") {
            const { capturePostgresBackup } = await import("../snapshot/database-backup.js");
            const exportDirectory = `${snapshotPath}.postgres`;
            await capturePostgresBackup({
              sourcePath,
              directory: exportDirectory,
              profile: "exact",
              config: input.config,
              pluginOwners: input.pluginOwners,
              assertCurrent: () => {},
            });
            postgres = { ...engine, exportDirectory };
          }
          // Automatic rollback keeps write attribution after custody ends. Manual original
          // capture stays under its maintenance owner and never grants restore authority.
          if (retainGeneration) {
            const after = await readGeneration(
              sourcePath,
              undefined,
              observations.get(sourcePath)?.sqliteReceipt,
            );
            if (after !== undefined && before === after) {
              sourceGenerations[sourcePath] = after;
            } else {
              warnings.push(
                `Database changed during capture; its snapshot requires manual recovery: ${sourcePath}`,
              );
            }
          }
          databases.push({
            path: sourcePath,
            snapshotPath,
            userVersion: snapshot.userVersion,
            sha256: snapshot.sha256,
            sizeBytes: snapshot.sizeBytes,
            ...postgres,
            ...(input.captureScope === "local-files"
              ? {
                  sourceFile: {
                    dev: String(identities.get(sourcePath)!.dev),
                    ino: String(identities.get(sourcePath)!.ino),
                  },
                }
              : {}),
            ...(engine.engine === "postgres" && input.captureScope === "local-files"
              ? { localAnchor: { storeId: engine.storeId, namespace: engine.namespace } }
              : {}),
          });
        }
        const current = await inventoryFor(
          await discoverUpdateStateSchemaInspectionInProcess({
            ...input,
            preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
          }),
        );
        if (JSON.stringify(current) !== JSON.stringify(inventory)) {
          throw new Error(
            "Update database inventory changed during backup; retry after writers stop.",
          );
        }
        await inspectRestorableDatabaseFiles(inventory.present, identities, input.stopped);
        const backup: UpdateDatabaseBackup = {
          ...(input.captureScope ? { captureScope: input.captureScope } : {}),
          directory,
          databases,
          missingPaths: inventory.missing,
          sourcePaths: inventory.sourcePaths,
          sourceGenerations,
          ...(input.originalCaptureSourcePaths
            ? { originalCaptureSourcePaths: [...originalCaptureSources] }
            : {}),
          databaseOwners: inventory.databaseOwners,
          warnings,
          ...(input.pluginOwners ? { pluginOwners: input.pluginOwners } : {}),
        };
        if (input.captureScope === "local-files") {
          const { prepareUpdateClientCredentialRestore } =
            await import("./client-credential-restore.js");
          if (!prepareUpdateClientCredentialRestore({ backup, env: input.env ?? process.env })) {
            throw new Error(
              "Local checkpoint client credentials do not match the captured global database.",
            );
          }
        }
        return backup;
      } catch (cause) {
        failed = { cause };
        throw cause;
      } finally {
        const errors: unknown[] = [];
        for (const { prepared } of heldImages) {
          try {
            if (!(await prepared.cleanupAsync())) {
              errors.push(
                new Error(`Update database image cleanup did not settle: ${prepared.location}`),
              );
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throwSqliteLifecycleErrors(
            failed ? [failed.cause, ...errors] : errors,
            "Update database capture and retained image cleanup failed",
          );
        }
      }
    }),
  );
}

/** Retain raw, verified database files separately from the old package fingerprint. */
export async function createUpdateDatabaseBackup({
  acquisition,
  purpose,
  nodeRunner = process.execPath,
  timeoutMs,
  signal: callerSignal,
  rehearsal,
  retryAdvice,
  ...input
}: BackupInput & {
  acquisition?: UpdateRecoveryCaptureAcquisition;
  /** Original-state evidence does not need generations while its owner retains every source. */
  purpose?: "original-state";
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  rehearsal?: DoctorRehearsalDatabaseCoverage;
  retryAdvice?: boolean;
}): Promise<UpdateDatabaseBackup> {
  if (
    purpose === "original-state" &&
    acquisition?.mode !== "maintenance-owner" &&
    Object.values(resolveDatabaseFamilyEngines(input.config)).includes("postgres")
  ) {
    const { acquireGatewayLock } = await import("./gateway-lock.js");
    const owner = await acquireGatewayLock({
      env: input.env,
      role: "sqlite-maintenance",
      allowInTests: true,
      timeoutMs: 0,
    });
    if (!owner) {
      throw new Error("PostgreSQL original capture requires exclusive state ownership.");
    }
    let retainOwner = false;
    try {
      await closeOpenClawStateDatabaseByPathAsync(
        path.join(input.stateDir, "state", "openclaw.sqlite"),
      );
      owner.assertCurrent();
      return await owner.run(async () => {
        const backup = await createUpdateDatabaseBackup({
          ...input,
          purpose,
          acquisition: { mode: "maintenance-owner" },
          nodeRunner,
          timeoutMs,
          signal: callerSignal,
          rehearsal,
          retryAdvice,
        });
        owner.assertCurrent();
        return backup;
      });
    } catch (error) {
      // An unjoined inspection child still owns the source read interval.
      retainOwner = hasCommandProcessCleanupError(error);
      throw error;
    } finally {
      if (!retainOwner) {
        await owner.release();
      }
    }
  }
  const controller = new AbortController();
  const { discoverBackupDatabasePaths, readBackupEngine } =
    await prepareUpdateDatabaseBackupRuntime();
  const prepared =
    input.captureScope !== "local-files" &&
    Object.values(resolveDatabaseFamilyEngines(input.config)).includes("postgres")
      ? await (await import("./backup-database-discovery.js")).preparePostgresBackupDiscovery(input)
      : {
          // Read legacy SQLite registrations from the private inspection copy, before admission.
          paths: await discoverBackupDatabasePaths({ ...input, agentRegistry: [] }),
          pluginOwners: undefined,
        };
  const additionalPaths = [...(input.additionalPaths ?? []), ...prepared.paths].map((file) =>
    path.resolve(file),
  );
  const additionalFiles = input.additionalFiles?.map((file) => path.resolve(file));
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const work = (async () => {
    signal.throwIfAborted();
    const backupRoot = path.resolve(input.backupRoot);
    const directory = `${backupRoot}.databases`;
    await createPrivateSqliteDirectory(directory);
    const identity = await fs.lstat(directory, { bigint: true });
    try {
      const sourceEnv = input.env ?? process.env;
      const worker = { nodeRunner, timeoutMs, signal, sourceEnv, stagingRoot: directory };
      // Each SQLite reader owns its token-protected scratch beneath this private backup directory.
      const workerInput = {
        ...input,
        ...(prepared.pluginOwners ? { pluginOwners: prepared.pluginOwners } : {}),
        preserveSourceArtifacts: input.stopped || input.preserveSourceArtifacts,
        additionalPaths,
        additionalFiles,
        backupRoot,
        stagingRoot: directory,
      };
      const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
      const scope = getOpenClawDatabaseMaintenanceScope();
      const custody =
        acquisition?.mode === "maintenance-owner" &&
        maintenanceOwnerHasSourceCustody(scope, shared) &&
        !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(shared);
      // Only maintenance admission consumes this classification. Other callers
      // let the backup worker inspect engines without another full source image.
      const postgresPaths = custody
        ? prepared.paths.filter((file) => readBackupEngine(file).engine === "postgres")
        : [];
      const inspectionPlan =
        custody && maintenanceOwnerMayCopySourcesInProcess(scope, shared)
          ? await discoverUpdateStateSchemaInspectionInProcess({
              ...workerInput,
              stagingRoot: directory,
              preserveSourceArtifacts: true,
            })
          : parseUpdateStateInspectionWorker(
              await runUpdateStateInspectionWorker({
                ...worker,
                retryAdvice,
                input: { ...workerInput, mode: "discover" },
                databases: custody
                  ? await readUpdateStateDatabaseSizesInProcess([shared], signal)
                  : await readUpdateStateDatabaseSizes([shared], worker),
              }),
              UpdateStateSchemaInspectionPlanSchema,
            );
      rehearsal?.assertCurrent();
      const excludedDatabasePaths = rehearsal?.admit(
        inspectionPlan.files.flatMap(([, database]) => database.spellings),
      );
      const capturedInput = {
        ...workerInput,
        excludedDatabasePaths,
        postgresOffline: input.postgresOffline || custody,
      };
      const files = [
        ...inspectionPlan.files.flatMap(([, database]) => database.spellings),
        ...(additionalPaths ?? []),
        ...(additionalFiles ?? []),
      ].filter((file) => !rehearsal?.excludes(file));
      let originalCaptureSourcePaths: string[] | undefined;
      if (purpose === "original-state" && custody) {
        const { isOpenClawAgentDatabaseOpen } = await import("../state/openclaw-agent-db.js");
        originalCaptureSourcePaths = [
          ...new Set(files.map(resolvePathViaExistingAncestorSync)),
        ].filter(
          (file) =>
            maintenanceOwnerHasSourceCustody(scope, file) &&
            !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(file) &&
            !isOpenClawAgentDatabaseOpen(file),
        );
      }
      rehearsal?.assertCurrent();
      const databases = custody
        ? await readUpdateStateDatabaseSizesInProcess(files, signal)
        : await readUpdateStateDatabaseSizes(files, worker);
      if (custody && postgresPaths.length > 0) {
        scope!.assertAdmission();
      }
      const backup = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          retryAdvice,
          input: {
            ...capturedInput,
            mode: "database-backup",
            inspectionPlan,
            originalCaptureSourcePaths,
          },
          ...(custody ? { ioBudget: "deadline" as const } : {}),
          databases,
        }),
        UpdateDatabaseBackupSchema,
      );
      if (custody && postgresPaths.length > 0) {
        scope!.assertAdmission();
      }
      rehearsal?.assertCurrent();
      if (!sameFileIdentity(identity, await fs.lstat(directory, { bigint: true }))) {
        throw new Error(`Database backup directory changed during capture: ${directory}.`);
      }
      requireDirectorySync(await syncDirectory(path.dirname(directory)), "Database backup parent");
      return backup;
    } catch (error) {
      // Partial artifacts stay with recovery; this parent never races the SQLite scratch owners.
      throw new Error(
        `${formatErrorMessageWithCode(error)}. Database backup files retained at ${directory}.`,
        { cause: error },
      );
    }
  })();
  return retainSnapshotWork(work, () => controller.abort());
}
