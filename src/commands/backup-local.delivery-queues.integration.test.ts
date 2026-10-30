import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { expect, it } from "vitest";
import { createCliProcessFixture } from "../cli/isolated-process-fixture.test-support.js";
import { completeDeliveryQueueEntryInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import {
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { runOfflineDatabaseBackup } from "../snapshot/database-backup.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("refuses every captured delivery row before publishing an opt-in checkpoint, preserving ordinary backups", async () => {
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    const queueName = "synthetic-relocation-unrecognized-namespace";
    const entry = {
      id: "retained-delivery",
      enqueuedAt: 1_790_000_000_000,
      retryCount: 2,
      availableAt: 1_900_000_000_000,
      recoveryState: "unknown_after_send",
      completionRetention: "permanent" as const,
    };
    // Native first use and the existing offline owner create a real matched client/global pair.
    await runOfflineDatabaseBackup(state.stateDir, async () => {
      loadOrCreateDeviceIdentity({ env: state.env });
      openOpenClawStateDatabase({ env: state.env });
      seedDeliveryQueueEntry({ queueName, entry, stateDir: state.stateDir });
    });
    const cli = createCliProcessFixture(state.root, {
      ...state.env,
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    });
    const create = (archive: string, guarded = true) =>
      cli.run([
        "backup",
        "local",
        "create",
        "--output",
        archive,
        ...(guarded ? ["--require-empty-delivery-queues"] : []),
        "--json",
      ]);
    const inspectSource = () =>
      runOfflineDatabaseBackup(state.stateDir, async () =>
        loadDeliveryQueueEntry(queueName, entry.id, state.stateDir, "all"),
      );
    const rejected = state.path("must-not-publish.tar.gz");
    const refused = await create(rejected);
    expect(refused.code, JSON.stringify(refused)).not.toBe(0);
    expect(JSON.parse(refused.stdout), JSON.stringify(refused)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("delivery queue entries") },
    });
    await expect(fs.stat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inspectSource()).toEqual(entry);

    // The preexisting ordinary capture still sanitizes its private image, not the source.
    const ordinary = state.path("ordinary.tar.gz");
    const captured = await create(ordinary, false);
    expect(captured.code, JSON.stringify(captured)).toBe(0);
    expect(JSON.parse(captured.stdout)).toMatchObject({ ok: true, archivePath: ordinary });
    expect(await inspectSource()).toEqual(entry);
    const unpacked = state.path("unpacked");
    await fs.mkdir(unpacked);
    await tar.extract({ file: ordinary, cwd: unpacked });
    const manifest = JSON.parse(
      await fs.readFile(path.join(unpacked, "manifest.json"), "utf8"),
    ) as {
      databases: { path: string; image: string }[];
    };
    const global = manifest.databases.find(
      (item) => item.path === state.statePath("state/openclaw.sqlite"),
    );
    expect(global).toBeDefined();
    using image = new DatabaseSync(path.join(unpacked, global!.image), { readOnly: true });
    expect(image.prepare("SELECT count(*) AS count FROM delivery_queue_entries").get()).toEqual({
      count: 0,
    });

    // A permanent completion receipt is also removed by ordinary sanitation; it must refuse.
    await runOfflineDatabaseBackup(state.stateDir, async () => {
      completeDeliveryQueueEntryInDatabase(
        openOpenClawStateDatabase({ env: state.env }),
        queueName,
        entry.id,
      );
    });
    const terminal = await inspectSource();
    expect(terminal?.acknowledgedAt).toEqual(expect.any(Number));
    const terminalRefusal = await create(rejected);
    expect(terminalRefusal.code, JSON.stringify(terminalRefusal)).not.toBe(0);
    expect(JSON.parse(terminalRefusal.stdout), JSON.stringify(terminalRefusal)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("delivery queue entries") },
    });
    expect(await inspectSource()).toEqual(terminal);
    await expect(fs.stat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
  });
  // A distinct genuinely empty installation needs no artificial queue deletion to pass.
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    await runOfflineDatabaseBackup(state.stateDir, async () => {
      loadOrCreateDeviceIdentity({ env: state.env });
      openOpenClawStateDatabase({ env: state.env });
    });
    const archive = state.path("empty.tar.gz");
    const empty = await createCliProcessFixture(state.root, {
      ...state.env,
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    }).run([
      "backup",
      "local",
      "create",
      "--output",
      archive,
      "--require-empty-delivery-queues",
      "--json",
    ]);
    expect(empty.code, JSON.stringify(empty)).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ ok: true, archivePath: archive });
  });
}, 120_000);
