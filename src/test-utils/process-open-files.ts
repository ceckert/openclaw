import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Every path this process holds open on any thread; unlinked files keep their last name. */
export async function listProcessOpenFilePaths(): Promise<string[]> {
  if (process.platform === "linux") {
    const entries = await fs.readdir("/proc/self/fd");
    const targets = await Promise.all(
      entries.map((entry) => fs.readlink(path.join("/proc/self/fd", entry)).catch(() => undefined)),
    );
    return targets.flatMap((target) =>
      target === undefined ? [] : [target.replace(/ \(deleted\)$/, "")],
    );
  }
  const { stdout } = await execFileAsync(
    "lsof",
    ["-w", "-n", "-P", "-p", String(process.pid), "-F", "n"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => (line.startsWith("n") ? [line.slice(1)] : []));
}

/** Open paths that name the database, its WAL, or its shared-memory index. */
export async function listOpenSqliteFamilyPaths(databasePath: string): Promise<string[]> {
  const resolved = path.resolve(databasePath);
  const family = new Set([resolved, `${resolved}-wal`, `${resolved}-shm`, `${resolved}-journal`]);
  return (await listProcessOpenFilePaths()).filter((open) => family.has(open));
}
