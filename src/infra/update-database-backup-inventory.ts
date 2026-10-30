import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import type { z } from "zod";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { ignoreMissingPath } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { isSqliteSnapshotFile } from "./sqlite-file-header.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import type { UpdateStateDatabaseOwner } from "./update-candidate-paths.js";
import type { UpdateStateSchemaInspectionPlanSchema } from "./update-candidate-state.js";

type InspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

export async function inspectRestorableDatabaseFiles(
  databases: readonly string[],
  previous?: ReadonlyMap<string, BigIntStats>,
  stopped = false,
) {
  const identities = new Map<string, BigIntStats>();
  for (const database of databases) {
    // Readers mutate/recreate the transient WAL index; only durable files fence capture.
    for (const suffix of ["", "-wal", "-journal"]) {
      const file = `${database}${suffix}`;
      let info;
      try {
        info = await fs.lstat(file, { bigint: true });
      } catch (error) {
        if (suffix && hasNodeErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (!info.isFile() || info.nlink !== 1n) {
        throw new Error(
          `Update database rollback requires a regular file with one link: ${file}. Resolve database aliases before retrying; the databases have not been migrated.`,
        );
      }
      const before = previous?.get(file);
      if (
        before &&
        !(stopped ? sameFileMutationFingerprint(before, info) : sameFileIdentity(before, info))
      ) {
        throw new Error(`Update database file changed during backup: ${file}.`);
      }
      // Readers can create an empty WAL beside a checkpointed database.
      if (suffix !== "-wal" || info.size !== 0n) {
        identities.set(file, info);
      }
    }
  }
  if (stopped && previous) {
    const changed = [...previous.keys(), ...identities.keys()].find(
      (file) => previous.has(file) !== identities.has(file),
    );
    if (changed) {
      throw new Error(`Update database journal state changed during stopped backup: ${changed}.`);
    }
  }
  return identities;
}

export async function canonicalDatabaseInventory(
  plan: InspectionPlan,
  includeOwners: boolean,
  additionalPaths: readonly string[] = [],
  additionalFiles: readonly string[] = [],
  excludedDatabasePaths: readonly string[] = [],
  selectedDatabasePaths?: ReadonlySet<string>,
) {
  const present = new Set<string>();
  const missing = new Set<string>();
  const owners = new Map<string, UpdateStateDatabaseOwner & { path: string }>();
  const excluded = new Set(excludedDatabasePaths.flatMap(resolveSqliteDatabaseFilePaths));
  const isExcluded = (file: string) =>
    excluded.has(resolvePathViaExistingAncestorSync(file)) ||
    (selectedDatabasePaths !== undefined &&
      !selectedDatabasePaths.has(resolvePathViaExistingAncestorSync(file)));
  const selectedPaths = new Set(
    additionalPaths.filter((file) => !isExcluded(file)).map((file) => path.resolve(file)),
  );
  // Header readers close only in this backup child, outside the updater's SQLite lock lifetime.
  for (const file of additionalFiles) {
    if (isExcluded(file)) {
      continue;
    }
    const resolved = path.resolve(file);
    if (!selectedPaths.has(resolved) && (await isSqliteSnapshotFile(resolved))) {
      selectedPaths.add(resolved);
    }
  }
  const sources = [
    ...plan.files.map(([, database]) => database),
    ...[...selectedPaths].map((file) => ({ spellings: [file], owners: undefined })),
  ];
  for (const database of sources) {
    for (const spelling of database.spellings) {
      if (isExcluded(spelling)) {
        continue;
      }
      let canonical: string;
      try {
        canonical = await fs.realpath(spelling);
        present.add(canonical);
      } catch (error) {
        ignoreMissingPath(error);
        // A dangling alias is not proof that a database was absent.
        const entry = await fs.lstat(spelling).catch(ignoreMissingPath);
        if (entry) {
          throw new Error(`Update database path cannot be resolved: ${spelling}`, { cause: error });
        }
        canonical = resolvePathViaExistingAncestorSync(spelling);
        missing.add(canonical);
      }
      for (const owner of database.owners ?? []) {
        const entry = { path: canonical, ...owner };
        owners.set(JSON.stringify(entry), entry);
      }
    }
  }
  return {
    present: [...present].toSorted(),
    missing: [...missing].toSorted(),
    sourcePaths: [
      ...new Set(
        sources.flatMap((database) => database.spellings).filter((file) => !isExcluded(file)),
      ),
    ].toSorted(),
    databaseOwners: includeOwners
      ? [...owners]
          .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, owner]) => owner)
      : undefined,
  };
}
